// The DJ never names a compilation as the song's album (#2117). A sampler's,
// soundtrack's or box set's title read out as "from <album>" tells the
// listener the song came from a record it never did.
//
// Both spoken surfaces are pinned: the request intro's "Now starting:" line
// (llm/internal/prompts/scripts.ts generateIntro) and the link's "Album:"
// sleeve note (sleeve-notes.ts). Neither is handed tracks that carry the
// compilation flag: request picks are raw Subsonic children, and agent picks
// and queue tracks are `trackFields()` or the picker's slim projection. So
// the flag must come from the library, against a REAL library.db, or a fix
// that reads `track.isCompilation` passes these tests and never fires on air.
//
// Run: npm test -- spoken-album

import assert from 'node:assert/strict';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const dir = createTempDir(join(tmpdir(), 'subwave-spoken-album-'));
process.env.STATE_DIR = dir;

const db = await import('../src/music/library-db.js');
const library = await import('../src/music/library.js');
const settings = await import('../src/settings.js');
const dj = await import('../src/llm/dj.js');
const { albumIsCompilation } = await import('../src/music/album-facts.js');
const { sleeveNotesFor } = await import('../src/llm/internal/prompts/sleeve-notes.js');

await settings.load();
await library.load();

after(async () => {
  await removeTempDir(dir);
});

// A flagged compilation, an anthology only the WALK flagged (Navidrome's own
// flag false, the #1418 shape) and an ordinary record.
db.upsertTrackMeta('comp-1', {
  title: 'Opener', artist: 'First Act', album: 'Now That Is Music 47', isCompilation: true,
});
db.upsertTrackMeta('anth-1', {
  title: 'Get Out of My Life', artist: 'Allen Toussaint',
  album: 'The Atco Singles 1968-1974', isCompilation: false, eraUntrusted: true,
});
db.upsertTrackMeta('ok-1', {
  title: 'Idioteque', artist: 'Radiohead', album: 'Kid A', isCompilation: false,
});

// What request picks and queue tracks actually look like: no era fields.
const child = (id: string, title: string, artist: string, album: string) =>
  ({ id, title, artist, album });
const comp = child('comp-1', 'Opener', 'First Act', 'Now That Is Music 47');
const anth = child('anth-1', 'Get Out of My Life', 'Allen Toussaint', 'The Atco Singles 1968-1974');
const ordinary = child('ok-1', 'Idioteque', 'Radiohead', 'Kid A');

test('a raw child is judged by its library row', () => {
  assert.equal(albumIsCompilation(comp), true);
  assert.equal(albumIsCompilation(anth), true, 'the walk-flagged anthology, not just the tagged compilation');
  assert.equal(albumIsCompilation(ordinary), false);
});

test('stated flags win, a various-artists album artist counts, and a miss is not evidence', () => {
  assert.equal(albumIsCompilation({ ...ordinary, isCompilation: true }), true);
  assert.equal(albumIsCompilation({ ...comp, yearUntrusted: false }), false);
  assert.equal(albumIsCompilation({ ...child('not-in-db', 'Song', 'Someone', 'Sampler'), albumArtist: 'Various Artists' }), true);
  assert.equal(albumIsCompilation(child('not-in-db', 'Song', 'Someone', 'Some Record')), false);
  assert.equal(albumIsCompilation(null), false);
});

test('the link sleeve notes drop a compilation album and keep an ordinary one', () => {
  assert.ok(!sleeveNotesFor(comp).some((n) => n.startsWith('Album:')));
  assert.ok(!sleeveNotesFor(anth).some((n) => n.startsWith('Album:')));
  assert.deepEqual(sleeveNotesFor(ordinary).filter((n) => n.startsWith('Album:')), ['Album: Kid A.']);
});

// The intro prompt the model receives. One local stub stands in for the LLM.
async function introPrompt(track: Record<string, unknown>): Promise<string> {
  const originalLlm = structuredClone(settings.get().llm);
  const realFetch = globalThis.fetch;
  let prompt = '';
  try {
    await settings.update({ llm: {
      provider: 'openai-compatible', model: 'fixture-model',
      // An `auto` connection would send its detection probes here first.
      compatibleMode: 'local',
      baseUrl: 'http://127.0.0.1:9/v1', fallback: { enabled: false },
    } } as never);
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      prompt = (body.messages || []).filter((m: any) => m.role === 'user').map((m: any) => String(m.content)).join('\n');
      return new Response(JSON.stringify({
        id: 'chatcmpl-fixture', object: 'chat.completion', created: 1, model: 'fixture-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'A fixture intro.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    await dj.generateIntro({ track, context: {} });
    return prompt;
  } finally {
    globalThis.fetch = realFetch;
    await settings.update({ llm: originalLlm } as never);
  }
}

test('the request intro names an ordinary album and leaves a compilation out', async () => {
  assert.match(await introPrompt(ordinary), /Now starting: "Idioteque" by Radiohead from Kid A/);
  const compPrompt = await introPrompt(comp);
  assert.match(compPrompt, /Now starting: "Opener" by First Act/);
  assert.doesNotMatch(compPrompt, /Now That Is Music 47/);
  assert.doesNotMatch(await introPrompt(anth), /Atco Singles/);
});
