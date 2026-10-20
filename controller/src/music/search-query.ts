// The query language of the Library tab search:
// liqe parses it (Lucene-like, public AST), this module compiles the AST to SQL
// over library-db `tracks`. Never liqe's own filter/test: they run regex nodes
// through native RegExp, and every regex here goes through util/search-pattern
// (RE2, linear time).
//
//   live                      title, artist or album contains "live"
//   title:live                that field contains it; `*` = one or more chars,
//   artist:the*b              `?` = one char, unanchored (liqe's wildcard rule)
//   artist:="ABBA"            exact name (folded like the blocklist's name keys)
//   title:/\((live|remix)\)/  RE2 regex, case-insensitive, unanchored, over the
//                             folded name (one apostrophe, one space); one per query
//   genre:punk                genre or a refinement of it ("Punk Rock", not "Trap");
//                             no wildcards in a genre (use /regex/)
//   tag:christmas mood:calm   tag = genres + moods + audio moods + Last.fm tags;
//                             substring like title (tag:=x is the exact tag)
//   energy:high bpm:>140      numbers take :> :>= :< :<= := and [a TO b] ranges
//   year:[1990 TO 1999]       the era year (original year, as the picker judges it)
//   -genre:pop  NOT x  a OR b  (grouping)  implicit AND between terms
//
// Deliberate differences from liqe's own semantics: quoted values are
// case-insensitive (liqe: case-sensitive), so search and rules agree; `:=` on a
// text field is an exact name (liqe defines `:=` for numbers only). liqe does not
// parse field-scoped groups: write `title:live OR title:remix`, or
// `title:/live|remix/`, not `title:(live OR remix)`.
//
import { parse, SyntaxError as LiqeSyntaxError, type LiqeQuery, type TagToken } from 'liqe';
import { foldText, regexPattern, wildcardSource } from '../util/search-pattern.js';
import { MANUAL_TAG_ENERGIES } from '../schemas/library.js';
import { nameKey } from './recency.js';
import { normGenre } from './genre-fold.js';
import { ERA_YEAR_SQL } from './library-db/browse.js';
import { KEY_SEP } from './library-db/search-keys.js';

// `syntax`: text with no query field in it that liqe could not parse, most
// often a plain name with a `/` or a quote in it, so the box offers to search it
// as written. `incomplete`: the text stops mid-query (a trailing AND/OR/NOT, an
// open quote or bracket), most often because it is still being typed, so it
// gets no such offer. `meaning`: a query we do not run (an unknown field, a
// value of the wrong kind, a field-scoped group, a second regex, a query with a
// field that liqe could not parse), where the text as written would not find
// what was meant either.
export type QueryErrorKind = 'syntax' | 'incomplete' | 'meaning';
export class QuerySyntaxError extends Error {
  constructor(message: string, readonly offset: number, readonly kind: QueryErrorKind = 'meaning') {
    super(message);
  }
}

export interface CompiledSql {
  sql: string;
  params: unknown[];
}

// SQLite caps an expression tree at 1000 deep; a search box never needs this much.
export const QUERY_MAX = 500;
// A field name (as liqe spells one) and its `:` right before the offset liqe
// stopped at, and every one that starts a term.
const FIELD_BEFORE = /([$A-Z_a-z][\w$.-]*):$/;
const FIELD_NAMES = /(?:^|[\s(-])([$A-Z_a-z][\w$.-]*):/g;
// What may sit right before a `/` that opens a regex, or a quote that opens a
// string: the start, whitespace, `(`, `-` and a comparison's last character
// (liqe's own set is narrower; this one errs toward counting).
const TERM_START = /[\s(\-:=<>]/;

// liqe lets a regex body hold any character, `/` included, so once a regex has
// opened, every later `/` that could open one could also sit inside the first.
// Two regexes are then several readings: liqe builds every one (they double
// with each regex, so 22 `/a/` in 87 characters ran the controller out of
// memory) and throws "Ambiguous results." So a query takes one regex, counted
// here in one pass before liqe sees the text. Returns the second opener's offset,
// or -1. A quoted string hides its `/` only while no regex is open: after one,
// in some reading that quote is inside the regex, and the readings multiply in
// the string just the same.
function secondRegexAt(text: string): number {
  let open = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (i > 0 && !TERM_START.test(text[i - 1]!)) continue;
    if (c === '/') {
      if (++open === 2) return i;
      // To the first `/` that could close it, past `\` escapes, as liqe reads one.
      for (i++; i < text.length && text[i] !== '/'; i++) if (text[i] === '\\') i++;
    } else if ((c === '"' || c === "'") && open === 0) {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === '\\') i++;
    }
  }
  return -1;
}

export function parseQuery(text: string): LiqeQuery {
  if (typeof text !== 'string') throw new TypeError('parseQuery takes a string');
  if (text.length > QUERY_MAX) throw new QuerySyntaxError(`A query is at most ${QUERY_MAX} characters`, QUERY_MAX, 'meaning');
  const second = secondRegexAt(text);
  if (second !== -1) {
    const field = FIELD_BEFORE.exec(text.slice(0, text.indexOf('/')))?.[1] ?? '';
    throw new QuerySyntaxError(`A query takes one /regex/: put the alternatives in one, as ${field && `${field}:`}/a|b/`, second, 'meaning');
  }
  try {
    return parse(text);
  } catch (err) {
    // Input that ends early never lands here: liqe reports it as "Found no parsings."
    if (err instanceof LiqeSyntaxError) {
      // liqe does not parse a field-scoped group (`title:(live OR remix)`).
      const field = text[err.offset] === '(' ? FIELD_BEFORE.exec(text.slice(0, err.offset))?.[1] : undefined;
      if (field && knownField(field.toLowerCase())) {
        throw new QuerySyntaxError(`${field}:( … ) is not supported: write ${field}:a OR ${field}:b, or ${field}:/a|b/`, err.offset, 'meaning');
      }
      // Text that names a field was meant as a query (`year:[1990 TO *]`):
      // searching it as written would find nothing.
      const query = [...text.matchAll(FIELD_NAMES)].some(m => knownField(m[1]!.toLowerCase()));
      throw new QuerySyntaxError(`"${text[err.offset]}" is not query syntax here`, err.offset, query ? 'meaning' : 'syntax');
    }
    // liqe's "Found no parsings." carries no position: the input ended mid-token.
    if ((err as Error)?.message === 'Found no parsings.') {
      throw new QuerySyntaxError('The query ends early (an unclosed quote or bracket, or a trailing AND/OR/NOT?)', text.length, 'incomplete');
    }
    // Anything else liqe throws on a string ("Ambiguous results.", which the
    // count above leaves unreachable) is still about the text, never a 500.
    throw new QuerySyntaxError('This query could not be read', 0, 'meaning');
  }
}

// Null-prototype: a field name is user input, and `constructor:x` must miss.
const table = <T>(o: Record<string, T>): Record<string, T> => Object.assign(Object.create(null), o);
const NUMERIC = table({ year: ERA_YEAR_SQL, bpm: 'bpm' });
const ENERGY_LEVELS: readonly string[] = MANUAL_TAG_ENERGIES;
const COMPARE = table({ ':>': '>', ':>=': '>=', ':<': '<', ':<=': '<=', ':=': '=', ':': '=' });

// The genre list as keysOf reads it (a list, else none); `genre` is only
// generated from its first entry.
const GENRES_LIST = `CASE WHEN json_valid(genres) THEN CASE json_type(genres) WHEN 'array' THEN genres END END`;
// genre, mood and tag each have a stored key list (`<field>_keys`).
const LIST_FIELDS: readonly string[] = ['genre', 'mood', 'tag'];
const TEXT_COLUMNS = ['title', 'artist', 'album'] as const;
const knownField = (name: string) =>
  (TEXT_COLUMNS as readonly string[]).includes(name) || LIST_FIELDS.includes(name) || !!NUMERIC[name] || name === 'energy';

const escapeLike = (s: string) => s.replace(/[\\%_]/g, '\\$&');
// One whole entry in a KEY_SEP-delimited key list.
const entry = (key: string) => `%${KEY_SEP}${escapeLike(key)}${KEY_SEP}%`;
const hasWildcard = (node: TagToken) =>
  node.expression.type === 'LiteralExpression' && !node.expression.quoted && /[*?]/.test(String(node.expression.value));

function text(node: TagToken): string {
  const { expression } = node;
  if (expression.type !== 'LiteralExpression') throw new QuerySyntaxError('Expected a value', start(node));
  return String(expression.value);
}

function start(node: TagToken): number {
  return node.expression.location.start;
}

// `:` on text: unanchored substring; an unquoted `*`/`?` is liqe's wildcard.
function containsPattern(node: TagToken): string {
  const e = node.expression;
  const value = escapeLike(foldText(text(node)));
  const body = e.type === 'LiteralExpression' && !e.quoted ? value.replace(/\*+/g, '_%').replace(/\?/g, '_') : value;
  return `%${body}%`;
}

// liqe keeps the delimiters and any flags (`/x/i`); matching is always
// case-insensitive RE2 (apostrophes folded on both sides, like the keys), so the
// flags are dropped. Compiled here only to refuse a pattern RE2 cannot run, with
// the offset.
function regexSource(raw: string, node: TagToken): string {
  const source = raw.slice(1, raw.lastIndexOf('/'));
  try {
    return regexPattern(source).source;
  } catch (err) {
    throw new QuerySyntaxError(`${raw}: ${(err as Error).message}`, start(node));
  }
}

const opError = (field: string, node: TagToken) =>
  new QuerySyntaxError(`${field} takes text, not ${node.operator.operator.slice(1)}`, node.operator.location.start);

function textField(column: string, node: TagToken): CompiledSql {
  const op = node.operator.operator;
  if (node.expression.type === 'RegexExpression') {
    // Over the name key, as every other text form matches, so `/don't/` finds "Don’t".
    return { sql: `search_match(?, ${column}_key)`, params: [regexSource(node.expression.value, node)] };
  }
  if (op === ':=') {
    const key = nameKey(text(node));
    // An artist is the whole credit or any act credited after feat.
    if (column === 'artist') return { sql: `artist_keys LIKE ? ESCAPE '\\'`, params: [entry(key)] };
    return { sql: `${column}_key = ?`, params: [key] };
  }
  if (op !== ':') throw opError(column, node);
  return { sql: `${column}_key LIKE ? ESCAPE '\\'`, params: [containsPattern(node)] };
}

function listField(field: string, node: TagToken): CompiledSql {
  const op = node.operator.operator;
  const e = node.expression;
  if (e.type === 'RegexExpression' && field === 'genre') {
    // The stored genre keys are folded to ASCII letters and digits, too far for
    // a regex: walk the genres, each spaced as a name key is.
    return {
      sql: `EXISTS (SELECT 1 FROM json_each(${GENRES_LIST}) WHERE type = 'text' AND search_match(?, collapse_space(value)))`,
      params: [regexSource(e.value, node)],
    };
  }
  // A regex, or a wildcard (which on the joined list could run from one tag into
  // the next), is tested tag by tag over the stored keys.
  if (e.type === 'RegexExpression') {
    return { sql: `search_match_entry(?, ${field}_keys, ?)`, params: [regexSource(e.value, node), KEY_SEP] };
  }
  if (field !== 'genre' && hasWildcard(node) && op === ':') {
    // The same LIKE over the whole list first: it holds wherever one tag
    // matches, and turns most rows away natively before the per-tag check runs
    // JS on them (37 tag wildcards over 150k tracks took 9.5 s without it).
    return {
      sql: `(${field}_keys LIKE ? ESCAPE '\\' AND search_match_entry(?, ${field}_keys, ?))`,
      params: [containsPattern(node), wildcardSource(text(node)), KEY_SEP],
    };
  }
  if (op !== ':' && op !== ':=') throw opError(field, node);
  if (field !== 'genre') {
    // tag and mood: an exact entry, or a Unicode-folded substring of one.
    return op === ':='
      ? { sql: `${field}_keys LIKE ? ESCAPE '\\'`, params: [entry(nameKey(text(node)))] }
      : { sql: `${field}_keys LIKE ? ESCAPE '\\'`, params: [containsPattern(node)] };
  }
  // genre keeps show-filter's fold (ASCII letters and digits only) and its
  // direction: the genre or a word-aligned refinement ("Punk Rock" for punk,
  // not "Trap" for rap) — genre_runs holds every run genreMatches accepts.
  // Wildcards would vanish in that fold, so refuse them.
  const value = text(node);
  const target = normGenre(value);
  if (!target || hasWildcard(node)) {
    throw new QuerySyntaxError('genre takes a genre name; use /regex/ for a pattern', start(node));
  }
  return { sql: `${op === ':=' ? 'genre_keys' : 'genre_runs'} LIKE ? ESCAPE '\\'`, params: [entry(target)] };
}

function numericField(field: string, node: TagToken): CompiledSql {
  const col = NUMERIC[field]!;
  const e = node.expression;
  if (e.type === 'RangeExpression') {
    const { min, max, minInclusive, maxInclusive } = e.range;
    return { sql: `IFNULL(${col} ${minInclusive ? '>=' : '>'} ? AND ${col} ${maxInclusive ? '<=' : '<'} ?, 0)`, params: [min, max] };
  }
  const raw = e.type === 'LiteralExpression' ? String(e.value) : '';
  if (!/^-?\d+(\.\d+)?$/.test(raw)) throw new QuerySyntaxError(`${field} takes a number`, start(node));
  const n = Number(raw);
  // IFNULL: a track with no year or bpm is not a match, and stays one under NOT
  // (SQL's NOT NULL is NULL, which would hide it from `-bpm:>140` too).
  return { sql: `IFNULL(${col} ${COMPARE[node.operator.operator]} ?, 0)`, params: [n] };
}

function tag(node: TagToken): CompiledSql {
  if (node.field.type === 'ImplicitField') {
    const parts = TEXT_COLUMNS.map((c) => textField(c, { ...node, operator: { ...node.operator, operator: ':' } }));
    return { sql: `(${parts.map((p) => p.sql).join(' OR ')})`, params: parts.flatMap((p) => p.params) };
  }
  const name = node.field.name.toLowerCase();
  if ((TEXT_COLUMNS as readonly string[]).includes(name)) return textField(name, node);
  if (LIST_FIELDS.includes(name)) return listField(name, node);
  if (NUMERIC[name]) return numericField(name, node);
  if (name === 'energy') {
    if (node.operator.operator !== ':' && node.operator.operator !== ':=') throw opError(name, node);
    const level = foldText(text(node));
    if (!ENERGY_LEVELS.includes(level)) throw new QuerySyntaxError(`energy is one of ${ENERGY_LEVELS.join(', ')}`, start(node));
    return { sql: 'IFNULL(energy = ?, 0)', params: [level] };
  }
  const at = node.field.location.start;
  if (name === 'playlist') throw new QuerySyntaxError('playlist is not searchable here', at);
  throw new QuerySyntaxError(`Unknown field "${node.field.name}"`, at);
}

export function compileSql(ast: LiqeQuery): CompiledSql {
  switch (ast.type) {
    case 'EmptyExpression':
      return { sql: '1', params: [] };
    case 'Tag':
      return tag(ast);
    case 'UnaryOperator': {
      const inner = compileSql(ast.operand);
      return { sql: `NOT (${inner.sql})`, params: inner.params };
    }
    case 'ParenthesizedExpression':
      return compileSql(ast.expression);
    case 'LogicalExpression': {
      const left = compileSql(ast.left);
      const right = compileSql(ast.right);
      const op = ast.operator.type === 'BooleanOperator' && ast.operator.operator === 'OR' ? 'OR' : 'AND';
      return { sql: `(${left.sql} ${op} ${right.sql})`, params: [...left.params, ...right.params] };
    }
  }
}

// A regex body that is plain text once its escapes are dropped.
const LITERAL = /((?:[^\\^$.*+?()[\]{}|/]|\\[\\^$.*+?()[\]{}|/])+)/.source;
const REGEX_READINGS: Array<[RegExp, string]> = [
  [new RegExp(String.raw`^\^${LITERAL}\$$`), 'is'],
  [new RegExp(String.raw`^\^${LITERAL}$`), 'starts with'],
  [new RegExp(String.raw`^${LITERAL}\$$`), 'ends with'],
  [new RegExp(String.raw`^\\b${LITERAL}\\b$`), 'has the word'],
  [new RegExp(String.raw`^${LITERAL}$`), 'contains'],
];

function readRegex(raw: string): string {
  const source = raw.slice(1, raw.lastIndexOf('/'));
  for (const [re, verb] of REGEX_READINGS) {
    const m = re.exec(source);
    // RE2's \b is ASCII-only, so "the word" is only true of an ASCII word.
    if (m && verb === 'has the word' && !/^[\x20-\x7e]+$/.test(m[1]!)) continue;
    if (m) return `${verb} "${m[1]!.replace(/\\(.)/g, '$1')}"`;
  }
  return `matches ${raw.slice(0, raw.lastIndexOf('/') + 1)}`;
}

function readTag(node: TagToken): string {
  const e = node.expression;
  const field = node.field.type === 'ImplicitField' ? 'anywhere' : node.field.name.toLowerCase();
  const op = node.operator?.operator ?? ':';
  if (e.type === 'RegexExpression') return `${field} ${readRegex(e.value)}`;
  if (e.type === 'RangeExpression') {
    const { min, max, minInclusive, maxInclusive } = e.range;
    return minInclusive && maxInclusive
      ? `${field} ${min}–${max}`
      : `${field} ${minInclusive ? '≥' : '>'} ${min} and ${maxInclusive ? '≤' : '<'} ${max}`;
  }
  const value = e.type === 'LiteralExpression' ? String(e.value) : '';
  if (op !== ':' && op !== ':=') return `${field} ${op.slice(1)} ${value}`;
  if (NUMERIC[field] || field === 'energy') return `${field} ${value}`;
  if (field === 'genre' && op === ':') return `genre ${value} (or a kind of ${value})`;
  if (op === ':=') return `${field} is "${value}"`;
  if (e.type === 'LiteralExpression' && !e.quoted && /[*?]/.test(value)) return `${field} matches ${value}`;
  return field === 'anywhere' ? `anywhere "${value}"` : `${field} contains "${value}"`;
}

/** The query in plain words, for the search box to echo back ('' for an empty query). */
export function describeQuery(ast: LiqeQuery): string {
  switch (ast.type) {
    case 'EmptyExpression':
      return '';
    case 'Tag':
      return readTag(ast);
    case 'ParenthesizedExpression':
      return `(${describeQuery(ast.expression)})`;
    case 'UnaryOperator':
      // liqe binds NOT to a tag or a parenthesised group, which brings its own ( ).
      return `not ${describeQuery(ast.operand)}`;
    case 'LogicalExpression': {
      // liqe groups left to right with no AND-over-OR precedence: a child that
      // mixes the other operator is shown in ( ) so it reads as it runs.
      const isOr = (n: LiqeQuery) => n.type === 'LogicalExpression' && n.operator.type === 'BooleanOperator' && n.operator.operator === 'OR';
      const or = isOr(ast);
      const side = (n: LiqeQuery) => (n.type === 'LogicalExpression' && isOr(n) !== or ? `(${describeQuery(n)})` : describeQuery(n));
      return `${side(ast.left)}${or ? ' or ' : ' · '}${side(ast.right)}`;
    }
  }
}

/**
 * What the Library search box runs: the query, or — when the text is not a
 * valid query (most often a plain name with `/`, `'`, `:` or a bracket in it:
 * "AC/DC", "Guns N' Roses", "Re:Stacks") — the whole text as one plain substring
 * over title, artist and album, with the error alongside for the UI to show.
 */
export function compileSearch(text: string): { query: CompiledSql; error: QuerySyntaxError | null; readsAs: string } {
  try {
    const ast = parseQuery(text);
    return { query: compileSql(ast), error: null, readsAs: describeQuery(ast) };
  } catch (err) {
    if (!(err instanceof QuerySyntaxError)) throw err;
    const pattern = `%${escapeLike(foldText(text.trim()))}%`;
    const query = {
      sql: TEXT_COLUMNS.map((c) => `${c}_key LIKE ? ESCAPE '\\'`).join(' OR '),
      params: TEXT_COLUMNS.map(() => pattern),
    };
    return { query, error: err, readsAs: '' };
  }
}
