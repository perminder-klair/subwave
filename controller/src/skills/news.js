// News skill — fetches BBC News RSS (configurable via NEWS_FEED_URL), picks
// the top unseen headline, and asks the DJ to read it in character.
//
// Dependency-free RSS parsing: the BBC feed is RSS 2.0 with shallow <item>
// blocks containing <title> and <description>. We regex-extract those two
// fields and that's all we need. If a richer feed surfaces, swap in
// fast-xml-parser as a follow-up.

import { config } from '../config.js';
import { djText } from '../llm/sdk.js';
import { djSystem, buildContextLines, decoratePrompt } from '../llm/dj.js';

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

function hashHeadline(title) {
  let h = 0;
  for (let i = 0; i < title.length; i++) h = ((h << 5) - h + title.charCodeAt(i)) | 0;
  return h.toString(36);
}

async function fetchHeadlines() {
  const res = await fetch(config.news.feedUrl);
  if (!res.ok) throw new Error(`News feed HTTP ${res.status}`);
  const xml = await res.text();
  const items = [];
  let m;
  ITEM_RE.lastIndex = 0;
  while ((m = ITEM_RE.exec(xml)) !== null && items.length < config.news.maxItems) {
    const body = m[1];
    const title = stripHtml((body.match(TITLE_RE) || [, ''])[1]);
    const description = stripHtml((body.match(DESC_RE) || [, ''])[1]);
    if (title) items.push({ title, description });
  }
  return items;
}

export default {
  name: 'news',
  kind: 'news',
  cooldownMs: 45 * 60 * 1000,

  shouldFire() {
    return true;
  },

  async fetchData(_ctx, state) {
    const items = await fetchHeadlines();
    if (!items.length) return null;
    if (!state.seen) state.seen = new Set();
    const fresh = items.find(it => !state.seen.has(hashHeadline(it.title)));
    if (!fresh) return null;
    state.seen.add(hashHeadline(fresh.title));
    if (state.seen.size > 80) {
      // Trim memory — keep the most recent ~40 hashes
      state.seen = new Set(Array.from(state.seen).slice(-40));
    }
    return fresh;
  },

  async script(ctx, item, { recap, recentOpeners }) {
    if (!item) return null;
    const lines = buildContextLines(ctx);
    lines.push(`Headline: ${item.title}`);
    if (item.description) lines.push(`Detail: ${item.description}`);
    lines.push('Task: read this in 1 sentence, BBC 6 Music tone — no editorialising, no anchor voice, no "in other news". Then let the music answer.');
    return djText({
      system: djSystem(),
      prompt: decoratePrompt(lines.join('\n'), { kind: 'news', recap, recentOpeners }),
      temperature: 0.85,
      topP: 0.95,
      repeatPenalty: 1.2,
      kind: 'skill.news',
    });
  },
};
