// News / "Dispatches" loader. Reads the markdown files under web/content/news,
// parses their frontmatter, and renders the bodies to HTML. Everything here
// runs server-side at build time (the /news routes are statically generated),
// so the filesystem read never happens at request time in the standalone image.
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { marked } from 'marked';

export type NewsCategory =
  | 'Release'
  | 'Feature'
  | 'Fix'
  | 'Announcement'
  | 'Spotlight';

export interface NewsMeta {
  slug: string;
  title: string;
  date: string; // ISO yyyy-mm-dd
  category: NewsCategory;
  excerpt: string;
  version?: string;
  author?: string;
  readingMins: number;
}

export interface NewsArticle extends NewsMeta {
  html: string;
}

const NEWS_DIR = path.join(process.cwd(), 'content', 'news');

// GitHub-flavoured markdown, no header-id auto-mangling needed here.
marked.setOptions({ gfm: true, breaks: false });

// Strip an optional leading date prefix (2026-05-20-) so URLs read cleanly.
function fileToSlug(file: string): string {
  return file.replace(/\.md$/, '').replace(/^\d{4}-\d{2}-\d{2}-/, '');
}

// Normalise a frontmatter date to an ISO yyyy-mm-dd string. Unquoted YAML
// dates (date: 2026-06-01) are parsed by js-yaml into a JS Date, whose
// String() form ("Mon Jun 01 2026 …") breaks both the newest-first sort
// (it ends up comparing day-of-week names) and formatNewsDate (which can't
// re-parse it and falls back to printing the raw string). Coerce to a clean
// UTC date string here so everything downstream stays comparable + readable.
function toIsoDate(value: unknown): string {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? ''
      : value.toISOString().slice(0, 10);
  }
  return String(value ?? '').trim();
}

function readRaw(): { slug: string; raw: string }[] {
  let files: string[];
  try {
    files = fs.readdirSync(NEWS_DIR);
  } catch {
    return []; // no content dir yet → empty wire, page still renders
  }
  return files
    .filter((f) => f.endsWith('.md'))
    .map((f) => ({
      slug: fileToSlug(f),
      raw: fs.readFileSync(path.join(NEWS_DIR, f), 'utf8'),
    }));
}

function parseMeta(slug: string, raw: string): NewsMeta {
  const { data, content } = matter(raw);
  const words = content.trim().split(/\s+/).filter(Boolean).length;
  return {
    slug: (data.slug as string) || slug,
    title: String(data.title ?? slug),
    date: toIsoDate(data.date),
    category: (data.category as NewsCategory) ?? 'Announcement',
    excerpt: String(data.excerpt ?? ''),
    version: data.version ? String(data.version) : undefined,
    author: data.author ? String(data.author) : undefined,
    readingMins: Math.max(1, Math.ceil(words / 200)),
  };
}

let _cache: NewsMeta[] | null = null;

/** All articles, newest first. Metadata only (no rendered body). Memoised. */
export function getAllNews(): NewsMeta[] {
  if (_cache) return _cache;
  _cache = readRaw()
    .map(({ slug, raw }) => parseMeta(slug, raw))
    // Newest first; tie-break on slug so same-date ordering is deterministic
    // across machines (readdir order is not guaranteed).
    .sort((a, b) => (a.date !== b.date ? (a.date < b.date ? 1 : -1) : a.slug < b.slug ? -1 : 1));
  return _cache;
}

export function getNewsSlugs(): string[] {
  return getAllNews().map((a) => a.slug);
}

/** One article with its body rendered to HTML, or null if the slug is unknown. */
export function getNewsArticle(slug: string): NewsArticle | null {
  const hit = readRaw().find((r) => r.slug === slug);
  if (!hit) return null;
  const { content } = matter(hit.raw);
  const meta = parseMeta(slug, hit.raw);
  return { ...meta, html: marked.parse(content) as string };
}

/** "May 20, 2026" — the dateline format used across the news surface. */
export function formatNewsDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}
