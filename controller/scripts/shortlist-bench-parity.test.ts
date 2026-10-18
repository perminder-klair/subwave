// Exercise /compare over HTTP. Only external services are synthetic; the
// route, registry, preparation strategy and one-shot selector are real.
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
const root = mkdtempSync(join(tmpdir(), 'subwave-shortlist-bench-'));
process.env.STATE_DIR = root;
process.env.NAVIDROME_URL = 'http://bench-library.invalid';
process.env.SUBWAVE_DISCOVERY_BENCH = '1';
process.env.ADMIN_USER = 'bench';
process.env.ADMIN_PASS = 'test-only';
const settings = await import('../src/settings.js');
const library = await import('../src/music/library.js');
const session = await import('../src/broadcast/session.js');
const { queue } = await import('../src/broadcast/queue.js');
const { router } = await import('../src/routes/debug.js');
const realFetch = globalThis.fetch;
const realRandom = Math.random;
let server: Server | undefined;
after(async () => {
  globalThis.fetch = realFetch; Math.random = realRandom;
  await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
  library.shutdown(); rmSync(root, { recursive: true, force: true });
});

test('Discovery Bench includes live targeted searches, operator recap and exploration without queueing', async () => {
  await settings.load();
  const at = Date.now();
  const show = { id: 's_bench', name: 'Bench hour', topic: 'Explore Portishead tracks', personaId: settings.get().personas[0].id };
  await settings.update({ shows: [show], scheduleOverride: { showId: show.id, startedAt: at - 60_000, expiresAt: at + 3600_000 },
    tts: { enabled: false }, djBehaviour: { recapLimit: 1, recapChars: 40 },
    llm: { provider: 'openai-compatible', compatibleMode: 'local', model: 'bench-test', baseUrl: 'http://bench-model.invalid/v1',
      apiKey: 'test', fallback: { enabled: false }, noRepeatWindow: 0, artistVarietyWindow: 0,
      trackSelection: 'shortlist', shortlistPasses: 3, shortlistSearchPreparation: true } });
  await library.load();
  session.start({ activeShow: settings.resolveActiveShow(), dominantMood: null, time: { period: 'day' } } as any);
  session.appendTurn({ role: 'segment', kind: 'banter', text: 'An aired guitar thread' });
  session.appendTurn({ role: 'event', kind: 'pick', text: 'Now playing Seed by Seed Artist. Pick the track to play next.' });
  queue.current = { track: { id: 'bench-seed', title: 'Seed', artist: 'Seed Artist', duration: 240 } } as any;
  queue.upcoming = []; queue.history = [];
  const songs = Array.from({ length: 6 }, (_, i) => ({ id: `bench-${i}`, title: `Track ${i}`, artist: `Artist ${i}`, duration: 240 }));
  const selections: any[] = [];
  let preparations = 0;
  const queries: string[] = [];
  const answer = (name: string, value: unknown) => Response.json({ id: 'bench', object: 'chat.completion', created: 0, model: 'bench-test',
    choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
      tool_calls: [{ id: 'bench-tool', type: 'function', function: { name, arguments: JSON.stringify(value) } }],
    } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === '127.0.0.1') return realFetch(input, init);
    if (url.hostname === 'api.open-meteo.com') return Response.json({ current: { temperature_2m: 15, weather_code: 0, is_day: 1 } });
    if (url.hostname === 'bench-library.invalid') {
      const endpoint = url.pathname.split('/').at(-1);
      if (endpoint === 'search3') queries.push(url.searchParams.get('query') || '');
      const data = endpoint === 'search3' ? { searchResult3: { song: songs } }
        : endpoint === 'getRandomSongs' ? { randomSongs: { song: songs } }
          : endpoint === 'getStarred2' ? { starred2: { song: songs } }
            : endpoint === 'getSimilarSongs2' ? { similarSongs2: { song: songs } } : {};
      return Response.json({ 'subsonic-response': { status: 'ok', version: '1.16.1', ...data } });
    }
    assert.equal(url.hostname, 'bench-model.invalid');
    const body = JSON.parse(String(init?.body));
    const user = body.messages.find((message: any) => message.role === 'user')?.content || '';
    if (String(user).startsWith('{"brief"')) {
      return answer(body.tools[0].function.name, { accepted: JSON.parse(user).proposals.map((proposal: any) => proposal.index) });
    }
    if (String(user).startsWith('{"topic"')) {
      preparations++;
      return answer(body.tools[0].function.name, { searches: [{ kind: 'library', intent: 'artist', query: 'Portishead', evidence: show.topic }] });
    }
    if (String(user).startsWith('{"context"')) {
      selections.push(JSON.parse(user.split('\n')[0]));
      return answer(body.tools[0].function.name, { id: songs[0].id, musicalReason: 'its patient guitar carries the groove into a warmer room', transition: null });
    }
    const names = body.tools?.map((tool: any) => tool.function.name) ?? [];
    if (names.includes('randomSongs')) return answer('randomSongs', {});
    assert.ok(names.includes('done'), JSON.stringify(names));
    return answer('done', { id: songs[0].id, reason: 'a warm guitar step', transition: null });
  };
  Math.random = () => 0;
  const app = express(); app.use(express.json()); app.use(router);
  server = await new Promise<Server>(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
  const port = (server.address() as { port: number }).port;
  const response = await fetch(`http://127.0.0.1:${port}/debug/discovery/compare`, {
    method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from('bench:test-only').toString('base64') },
  });
  const body = await response.json() as any;
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(preparations, 1);
  assert.ok(queries.includes('Portishead'));
  assert.equal(selections.length, 1);
  assert.deepEqual(selections[0].context.conversation, ['An aired guitar thread']);
  assert.equal(selections[0].context.explore, true);
  assert.ok(selections[0].shortlist.some((track: any) => track.source === 'searchLibrary'));
  assert.equal(queue.upcoming.length, 0);
  assert.equal(body.agentic.selected.id, songs[0].id);
  assert.equal(body.shortlist.selected.id, songs[0].id);
});
