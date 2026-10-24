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

// recency.nameKey's apostrophes, which it folds to one `'`.
const APOSTROPHES = /[‘’ʼ´`]/g;
const foldApostrophes = (text: string) => text.replace(APOSTROPHES, "'");
// A run of whitespace as one space, as recency.nameKey keys it.
const collapseSpace = (text: string) => text.replace(/\s+/g, ' ');

/**
 * A case-insensitive, unanchored RE2 regex over NFC text, with apostrophes
 * folded on both sides as a name key folds them, so `/don't/` finds "Don’t".
 * Throws `not a valid pattern: …` when RE2 refuses it.
 */
export function regexPattern(source: string): SearchPattern {
  if (!source) throw new Error('empty pattern');
  let re: RE2JS;
  try {
    re = RE2JS.compile(foldApostrophes(source.normalize('NFC')), RE2JS.CASE_INSENSITIVE);
  } catch (err) {
    throw new Error(`not a valid pattern: ${(err as Error).message}`);
  }
  return { source, test: (text) => re.test(foldApostrophes(text.normalize('NFC'))) };
}

/**
 * Unicode case fold for plain-text search: NFC (a decomposed Å is one Å), lower
 * case, one apostrophe and one space — recency.nameKey's fold less its trim (a
 * search may mean the space at its edge), so a search and a name key agree on
 * "Don’t" and on "Hip  Hop".
 */
export function foldText(text: string): string {
  return collapseSpace(foldApostrophes(text.normalize('NFC').toLowerCase()));
}

/**
 * liqe's unanchored wildcard as an RE2 source for `regexPattern`, over folded
 * text: `*` is one or more characters, `?` exactly one, the rest literal.
 */
export function wildcardSource(text: string): string {
  return foldText(text).split(/(\*+|\?)/)
    .map(part => part[0] === '*' ? '.+' : part === '?' ? '.' : RE2JS.quote(part))
    .join('');
}

/**
 * `search_match(source, value)` for a pattern `regexPattern` already accepted,
 * `search_match_entry(source, list, sep)`, the same over each entry of a
 * `sep`-delimited key list (true when one matches), and `collapse_space(value)`,
 * for a regex over a raw value that should see a name key's spacing.
 */
export function registerSearchSql(db: Database): void {
  db.function('collapse_space', { deterministic: true }, (value: unknown) => collapseSpace(String(value ?? '')));
  // Compiled once per source: a query repeats its few sources row after row (a
  // regex and any number of list wildcards). The cap is far above what one
  // 500-character query can hold, so a full map just starts over between queries.
  const compiled = new Map<string, SearchPattern>();
  const pattern = (source: unknown): SearchPattern => {
    const src = String(source);
    let p = compiled.get(src);
    if (!p) {
      if (compiled.size >= 256) compiled.clear();
      p = regexPattern(src);
      compiled.set(src, p);
    }
    return p;
  };
  db.function('search_match', { deterministic: true }, (source: unknown, value: unknown) =>
    pattern(source).test(String(value ?? '')) ? 1 : 0);
  db.function('search_match_entry', { deterministic: true }, (source: unknown, list: unknown, sep: unknown) => {
    const re = pattern(source);
    return String(list ?? '').split(String(sep)).some(entry => entry !== '' && re.test(entry)) ? 1 : 0;
  });
}
