// Web search skill — queries the Tavily API for something recent about the
// artist currently on air, then asks the DJ to work one detail into a
// between-track line.
//
// Needs a Tavily key (SEARCH_API_KEY). Without it the skill is inert:
// `shouldFire` returns false so the registry never picks it. It also won't
// re-search the same artist twice in a row (state.lastArtist gate), so a long
// run of one artist doesn't produce repeated segments.

import { config } from '../config.js';
import { queue } from '../broadcast/queue.js';
import { djText } from '../llm/sdk.js';
import { djSystem, buildContextLines, decoratePrompt } from '../llm/dj.js';

const TAVILY_ENDPOINT = 'https://api.tavily.com/search';

async function tavilySearch(query) {
  const res = await fetch(TAVILY_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.search.apiKey}`,
    },
    body: JSON.stringify({
      query,
      search_depth: 'basic',
      topic: 'general',
      include_answer: true,
      max_results: 5,
    }),
  });
  if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`);
  return res.json();
}

export default {
  name: 'web-search',
  label: 'Web search',
  description: 'Searches the web for something recent about the artist on air and works one detail into a between-track line. Needs a Tavily API key (SEARCH_API_KEY).',
  kind: 'web-search',
  cooldownMs: 60 * 60 * 1000,

  // No key, no artist, or the same artist we last searched → don't fire.
  shouldFire(_ctx, state) {
    if (!config.search.apiKey) return false;
    const artist = queue.current?.track?.artist;
    if (!artist || /^unknown/i.test(artist)) return false;
    return artist !== state.lastArtist;
  },

  async fetchData(_ctx, state) {
    const artist = queue.current?.track?.artist;
    if (!artist) return null;

    let data;
    try {
      data = await tavilySearch(`${artist} musician latest news`);
    } catch {
      // Leave state.lastArtist unset so the next tick retries this artist.
      return null;
    }
    state.lastArtist = artist;

    const answer = (data.answer || '').trim();
    const top = (data.results || [])
      .slice(0, 3)
      .map(r => `${r.title}: ${(r.content || '').replace(/\s+/g, ' ').trim().slice(0, 240)}`);
    if (!answer && top.length === 0) return null;
    return { artist, answer, top };
  },

  async script(ctx, data, { recap, recentOpeners }) {
    if (!data) return null;
    const lines = buildContextLines(ctx);
    lines.push(`Artist on air: ${data.artist}`);
    if (data.answer) lines.push(`What the web says: ${data.answer}`);
    if (data.top.length) lines.push(`Sources:\n${data.top.map(t => `- ${t}`).join('\n')}`);
    lines.push(`Task: work ONE genuine, current detail about ${data.artist} into a single spoken line — conversational, BBC 6 Music tone. No "I read online", no URLs, no list. If nothing above is worth saying, say nothing.`);
    return djText({
      system: djSystem(),
      prompt: decoratePrompt(lines.join('\n'), { kind: 'web_search', recap, recentOpeners }),
      temperature: 0.85,
      topP: 0.95,
      repeatPenalty: 1.2,
      kind: 'skill.web-search',
    });
  },
};
