// Conservative identity-first Wikipedia source client. It accepts no page
// instructions as commands; returned text is untrusted source data for a later,
// evidence-bounded researcher.
import { lookupMusicBrainzUrlRelations } from '../music/musicbrainz.js';
import { researchWikipediaUrlSchema } from '../schemas/sleeve-notes-corrections.js';
import { fetchWithTimeout } from '../util/fetch-timeout.js';

const API = 'https://en.wikipedia.org/w/api.php';
const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
const USER_AGENT = 'Subwave Sleeve Notes/1.13 (https://github.com/Jaz666/subwave)';
const TIMEOUT_MS = 8_000;
const HEADERS = { 'User-Agent': USER_AGENT, Accept: 'application/json' };
const WIKIPEDIA_REST = 'https://en.wikipedia.org/w/rest.php/v1/revision';

async function fetchJson(url: string): Promise<unknown | null> {
  const response = await fetchWithTimeout(url, { timeoutMs: TIMEOUT_MS, headers: HEADERS });
  if (!response.ok) {
    // Identity or page absence is a clean miss; throttling and server errors
    // are transient and should leave the durable research job retryable.
    if (response.status === 404) return null;
    throw new Error(`HTTP ${response.status}`);
  }
  const payload=await response.json() as {error?:{code?:string}};
  if (payload?.error) throw new Error(`Wikipedia API error: ${payload.error.code??'unknown'}`);
  return payload;
}

export interface WikipediaArticleDocument {
  title: string;
  url: string;
  revisionId: string;
  retrievedAt: string;
  text: string;
  attribution: string;
  sourceFormatVersion: number;
}

/** Kept as an alias for the existing artist-source call sites. */
export type WikipediaArtistDocument = WikipediaArticleDocument;

export function projectWikipediaArticleDocument(payload: unknown, metadataOnly = false): WikipediaArticleDocument | null {
  const pages = (payload as { query?: { pages?: Record<string, unknown> } })?.query?.pages;
  if (!pages || typeof pages !== 'object') return null;
  const page = Object.values(pages)[0] as Record<string, unknown> | undefined;
  if (!page || page.missing !== undefined || page.ns !== undefined && page.ns !== 0
    || (page.pageprops && Object.hasOwn(page.pageprops as object, 'disambiguation'))) return null;
  const title = typeof page.title === 'string' ? page.title : null;
  const url = typeof page.fullurl === 'string' ? page.fullurl : null;
  const text = typeof page.extract === 'string' ? page.extract.trim() : null;
  const revision = Array.isArray(page.revisions) ? page.revisions[0] as Record<string, unknown> | undefined : undefined;
  const revisionId = typeof revision?.revid === 'number' || typeof revision?.revid === 'string' ? String(revision.revid) : null;
  if (!title || !url || !revisionId || !metadataOnly && !text) return null;
  return {
    title,
    url,
    revisionId,
    retrievedAt: new Date().toISOString(),
    text: metadataOnly ? '' : text!.slice(0, 250_000),
    attribution: `Wikipedia contributors, “${title}”, CC BY-SA`,
    sourceFormatVersion: 1,
  };
}

function decodeHtml(value: string): string {
  const named: Record<string, string> = {
    amp: '&', apos: "'", copy: '©', gt: '>', hellip: '…', lt: '<', mdash: '—',
    nbsp: ' ', ndash: '–', quot: '"', reg: '®', rsquo: '’', lsquo: '‘',
    rdquo: '”', ldquo: '“', trade: '™',
  };
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/giu, (entity, code: string) => {
    if (code[0] === '#') {
      const hex = code[1]?.toLowerCase() === 'x';
      const point = Number.parseInt(code.slice(hex ? 2 : 1), hex ? 16 : 10);
      try { return Number.isFinite(point) ? String.fromCodePoint(point) : entity; } catch { return entity; }
    }
    return named[code.toLowerCase()] ?? entity;
  });
}

/** Reduce revision HTML to article prose while preserving block quotations. */
export function wikipediaHtmlToProse(html: string, maxCharacters = 250_000): string {
  const tokens = html.replace(/<!--[\s\S]*?-->/gu, '').match(/<[^>]+>|[^<]+/gu) ?? [];
  const ignoredTags = new Set(['script', 'style', 'nav', 'table', 'ol', 'ul', 'sup', 'figure', 'noscript']);
  const ignoredClasses = /(?:^|\s)(?:mw-editsection|reference|mw-references-wrap|navbox|infobox|metadata|ambox|hatnote|shortdescription|toc|vertical-navbox)(?:\s|$)/u;
  const stack: Array<{ tag: string; ignored: boolean }> = [];
  const paragraphs: string[] = [];
  let text = '';
  let quote = false;
  let heading = false;
  let total = 0;
  const flush = () => {
    const value = text.replace(/\s+/gu, ' ').trim();
    text = '';
    if (!value || total >= maxCharacters) return;
    const line = heading ? `${'='.repeat(2)} ${value} ${'='.repeat(2)}` : quote ? `> ${value}` : value;
    const bounded = line.slice(0, maxCharacters - total);
    if (bounded) { paragraphs.push(bounded); total += bounded.length + 2; }
  };
  const ignoredNow = () => stack.some((entry) => entry.ignored);
  for (const token of tokens) {
    if (token.startsWith('<')) {
      const match = token.match(/^<\s*(\/)?\s*([a-z][\w:-]*)\b([^>]*)>/iu);
      if (!match) continue;
      const closing = !!match[1];
      const tag = match[2].toLowerCase();
      if (closing) {
        const index = stack.map((entry) => entry.tag).lastIndexOf(tag);
        if (index >= 0) stack.splice(index);
        if (!ignoredNow()) {
          if (/^h[1-6]$/u.test(tag)) { heading = true; flush(); heading = false; }
          else if (['p', 'blockquote', 'br', 'div'].includes(tag)) flush();
          if (tag === 'blockquote') quote = false;
        }
      } else {
        const attrs = match[3] ?? '';
        const classValue = attrs.match(/\bclass\s*=\s*(["'])(.*?)\1/iu)?.[2] ?? '';
        const ignored = ignoredTags.has(tag) || ignoredClasses.test(classValue) || ignoredNow();
        if (!ignored && /^h[1-6]$/u.test(tag)) { flush(); heading = true; }
        if (!ignored && tag === 'blockquote') { flush(); quote = true; }
        stack.push({ tag, ignored });
        if (!ignored && tag === 'br') text += ' ';
        if (/\/\s*>$/u.test(token) || ['br', 'hr', 'img', 'meta', 'link', 'input', 'wbr'].includes(tag)) {
          if (stack.at(-1)?.tag === tag) stack.pop();
        }
      }
      continue;
    }
    if (ignoredNow()) continue;
    const decoded = decodeHtml(token).replace(/\s+/gu, ' ');
    if (decoded.trim()) text += `${text && !/\s$/u.test(text) ? ' ' : ''}${decoded}`;
  }
  flush();
  return paragraphs.join('\n\n').slice(0, maxCharacters);
}

/** Existing artist projection API. */
export function projectWikipediaArtistDocument(payload: unknown): WikipediaArtistDocument | null {
  return projectWikipediaArticleDocument(payload);
}

/** Extract a Wikidata item from a MusicBrainz entity's explicit URL relation. */
export function wikidataIdFromMusicBrainzEntity(payload: unknown): string | null {
  const relations = (payload as { relations?: unknown })?.relations;
  if (!Array.isArray(relations)) return null;
  for (const relation of relations) {
    const row = relation as { type?: unknown; url?: { resource?: unknown } };
    if (row.type !== 'wikidata' || typeof row.url?.resource !== 'string') continue;
    const match = row.url.resource.match(/(?:wiki\/|entity\/)(Q\d+)(?:$|[?#])/i);
    if (match) return match[1].toUpperCase();
  }
  return null;
}

/** Extract an artist's Wikidata item from MusicBrainz's explicit URL relation. */
export function wikidataIdFromMusicBrainzArtist(payload: unknown): string | null {
  return wikidataIdFromMusicBrainzEntity(payload);
}

/** Extract an album concept's Wikidata item from its release-group relations. */
export function wikidataIdFromMusicBrainzReleaseGroup(payload: unknown): string | null {
  return wikidataIdFromMusicBrainzEntity(payload);
}

/** Read only the canonical English-Wikipedia sitelink from the resolved item. */
export function englishWikipediaTitleFromWikidata(payload: unknown, wikidataId: string): string | null {
  const entity = (payload as { entities?: Record<string, { sitelinks?: { enwiki?: { title?: unknown } } }> })
    ?.entities?.[wikidataId];
  const title = entity?.sitelinks?.enwiki?.title;
  return typeof title === 'string' && title.trim() ? title.trim() : null;
}

/** Accept only an explicit English article relation, never a guessed title. */
function englishWikipediaTitleFromMusicBrainzEntity(payload: unknown): string | null {
  const relations = (payload as { relations?: unknown })?.relations;
  if (!Array.isArray(relations)) return null;
  for (const relation of relations) {
    const row = relation as { type?: unknown; url?: { resource?: unknown } };
    if (row.type !== 'wikipedia' || typeof row.url?.resource !== 'string') continue;
    try {
      const url = new URL(row.url.resource);
      if (!['https:', 'http:'].includes(url.protocol) || url.hostname !== 'en.wikipedia.org'
        || url.username || url.password || url.port || url.search || url.hash
        || !url.pathname.startsWith('/wiki/')) continue;
      const title = decodeURIComponent(url.pathname.slice('/wiki/'.length)).replaceAll('_', ' ').trim();
      if (title && !/[|#\u0000-\u001f\u007f]/u.test(title)) return title;
    } catch { /* Malformed relations are a clean miss. */ }
  }
  return null;
}

async function fetchWikipediaDocumentFromMusicBrainzEntity(
  entityPath: 'artist' | 'release-group', musicBrainzId: string, metadataOnly = false,
): Promise<WikipediaArticleDocument | null> {
  const entityId = musicBrainzId.trim();
  if (!entityId) return null;
  const entityPayload = await lookupMusicBrainzUrlRelations(entityPath,entityId);
  if (!entityPayload) return null;
  const wikidataId = entityPath === 'artist'
    ? wikidataIdFromMusicBrainzArtist(entityPayload)
    : wikidataIdFromMusicBrainzReleaseGroup(entityPayload);
  let title: string | null = null;
  if (wikidataId) {
    const wikidataPayload = await fetchJson(`${WIKIDATA_API}?${new URLSearchParams({
      action: 'wbgetentities', format: 'json', ids: wikidataId, props: 'sitelinks', sitefilter: 'enwiki', origin: '*',
    })}`);
    if (wikidataPayload) title = englishWikipediaTitleFromWikidata(wikidataPayload, wikidataId);
  }
  // Stage-name and personal identities can have separate Wikidata items. Use
  // MusicBrainz's own article relation if its item has no English sitelink.
  // Transient errors still throw above and retain the normal retry/backoff.
  title ??= englishWikipediaTitleFromMusicBrainzEntity(entityPayload);
  if (!title) return null;
  return fetchWikipediaTitleDocument(title,metadataOnly);
}

async function fetchWikipediaTitleDocument(title: string, metadataOnly = false): Promise<WikipediaArticleDocument | null> {
  const params = new URLSearchParams({
    action:'query',format:'json',prop:metadataOnly?'info|revisions|pageprops':'extracts|info|revisions|pageprops',ppprop:'disambiguation',
    inprop:'url',explaintext:'1',rvprop:'ids',rvslots:'main',maxlag:'5',redirects:'1',titles:title,
  });
  const articlePayload = await fetchJson(`${API}?${params}`);
  const projected = articlePayload ? projectWikipediaArticleDocument(articlePayload,metadataOnly) : null;
  if (!projected || metadataOnly) return projected;
  const response = await fetchWithTimeout(`${WIKIPEDIA_REST}/${encodeURIComponent(projected.revisionId)}/html`, {
    timeoutMs: TIMEOUT_MS,
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
  });
  if (!response.ok) {
    if (response.status === 404) return null;
    throw new Error(`HTTP ${response.status}`);
  }
  const text = wikipediaHtmlToProse(await response.text());
  if (!text) return null;
  return {
    ...projected,
    text: `<!-- subwave-wikipedia-source-format:2 -->\n${text}`,
    sourceFormatVersion: 2,
  };
}

export function fetchWikipediaArtistDocument(musicBrainzArtistId: string, wikipediaUrl?: string, options?: {metadataOnly?:boolean}): Promise<WikipediaArtistDocument | null> {
  if (wikipediaUrl) {
    const valid=researchWikipediaUrlSchema.parse(wikipediaUrl);
    return fetchWikipediaTitleDocument(decodeURIComponent(new URL(valid).pathname.slice(6)).replaceAll('_',' '),options?.metadataOnly);
  }
  return fetchWikipediaDocumentFromMusicBrainzEntity('artist', musicBrainzArtistId ?? '',options?.metadataOnly);
}

/** Resolve an album through its release group's explicit Wikidata/Wikipedia links. */
export function fetchWikipediaReleaseGroupDocument(musicBrainzReleaseGroupId: string): Promise<WikipediaArticleDocument | null> {
  return fetchWikipediaDocumentFromMusicBrainzEntity('release-group', musicBrainzReleaseGroupId);
}
