// The regex and the Unicode fold of the Library search's query language
// (music/search-query.ts calls them for `/re/` nodes and plain text).
//
// RE2 (re2js, pure JS) rather than native RegExp: it runs in linear time, so an
// admin's typo can never make one match stall the event loop. Native RegExp took
// seconds on `(a+)+$`, and V8's linear fallback does not engage under the `i`
// flag. The cost is RE2's dialect: no backreferences or lookaround, and `\b`/`\w`
// are ASCII-only (`/\bår\b/` misses "Ett år"); `\p{L}` is the Unicode letter class.

import type { Database } from 'better-sqlite3';
import { RE2JS } from 're2js';

export interface SearchPattern {
  source: string;
  test(text: string): boolean;
}

/** A case-insensitive, unanchored RE2 regex; throws `not a valid pattern: …` when RE2 refuses it. */
export function regexPattern(source: string): SearchPattern {
  if (!source) throw new Error('empty pattern');
  let re: RE2JS;
  try {
    re = RE2JS.compile(source.normalize('NFC'), RE2JS.CASE_INSENSITIVE);
  } catch (err) {
    throw new Error(`not a valid pattern: ${(err as Error).message}`);
  }
  return { source, test: (text) => re.test(text.normalize('NFC')) };
}

/**
 * Unicode case fold for plain-text search: NFC (a decomposed Å is one Å), lower
 * case, and one apostrophe — the same apostrophe set recency.nameKey folds, so
 * a search and a name key agree on "Don’t".
 */
export function foldText(text: string): string {
  return text.normalize('NFC').toLowerCase().replace(/[‘’ʼ´`]/g, "'");
}

/**
 * `search_match(source, value)` for a pattern `regexPattern` already accepted,
 * and `fold(value)`, the `foldText` SQLite's ASCII-only LOWER() cannot do.
 */
export function registerSearchSql(db: Database): void {
  db.function('fold', { deterministic: true }, (value: unknown) => foldText(String(value ?? '')));
  // One entry, checked on every call: a query repeats one source row after row,
  // and an interleaved statement with another source just recompiles.
  let last: SearchPattern | null = null;
  db.function('search_match', { deterministic: true }, (source: unknown, value: unknown) => {
    const src = String(source);
    if (last?.source !== src) last = regexPattern(src);
    return last.test(String(value ?? '')) ? 1 : 0;
  });
}
