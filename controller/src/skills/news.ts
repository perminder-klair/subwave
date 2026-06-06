// News feed helpers — fetch an RSS feed and hash headlines for dedup. These
// back the `getHeadlines` segment tool (llm/segment-tools.js); there is no
// standalone "news skill" object — the segment-director agent (skills/_agent.js)
// decides when a headline airs. The feed URL/max-items come from the news
// capability (overridable via state/skills/news/SKILL.md `feed:`), falling back
// to config.news (env NEWS_FEED_URL / NEWS_MAX_ITEMS, default BBC).
//
// Dependency-free RSS parsing: this matches RSS 2.0 shallow <item> blocks
// containing <title> and <description>. Atom feeds (<entry>/<summary>) are NOT
// matched and will return zero items — swap in fast-xml-parser as a follow-up
// if a richer feed is needed.

import { config } from '../config.js';

const ITEM_RE = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
const TITLE_RE = /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i;
const DESC_RE = /<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i;

function stripHtml(s) {
  return (s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function hashHeadline(title) {
  let h = 0;
  for (let i = 0; i < title.length; i++) h = ((h << 5) - h + title.charCodeAt(i)) | 0;
  return h.toString(36);
}

export async function fetchHeadlines({ feedUrl, maxItems }: { feedUrl?: string; maxItems?: number } = {}) {
  const url = feedUrl || config.news.feedUrl;
  const cap = maxItems || config.news.maxItems;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`News feed HTTP ${res.status}`);
  const xml = await res.text();
  const items: any[] = [];
  let m;
  ITEM_RE.lastIndex = 0;
  while ((m = ITEM_RE.exec(xml)) !== null && items.length < cap) {
    const body = m[1];
    const title = stripHtml((body.match(TITLE_RE) || [, ''])[1]);
    const description = stripHtml((body.match(DESC_RE) || [, ''])[1]);
    if (title) items.push({ title, description });
  }
  return items;
}
