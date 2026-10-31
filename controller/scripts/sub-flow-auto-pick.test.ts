// Real shortlist/pool -> verification -> durable queue, with synthetic HTTP/audio.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chatCompletionResponse } from './test-utils/llm.js';
import type { Flow } from '../src/music/sub-flow.js';

process.env.NAVIDROME_URL = 'http://flow-library.invalid';
process.env.NAVIDROME_USER = 'test';
process.env.NAVIDROME_PASS = 'test';
const mixer = createServer(socket => socket.once('data', () => socket.end('{"version":1,"pending":"","playing":""}\nEND\n')));
await new Promise<void>(resolve => mixer.listen(0, '127.0.0.1', resolve));
process.env.LIQUIDSOAP_HOST = '127.0.0.1';
process.env.LIQUIDSOAP_PORT = String((mixer.address() as AddressInfo).port);
const settings = await import('../src/settings.js');
const library = await import('../src/music/library.js');
const session = await import('../src/broadcast/session.js');
const { queue } = await import('../src/broadcast/queue.js');
const { runTrackEvent } = await import('../src/broadcast/dj-agent.js');
const { pickViaPool } = await import('../src/music/picker.js');
const { enqueuePick } = await import('../src/broadcast/dj-agent/enqueue.js');
const { discardFlow, expectFlowPlayback } = await import('../src/music/sub-flow-playback.js');
const { config } = await import('../src/config.js');
const { clearPickerSourceCache } = await import('../src/llm/tools.js');

function wav(value: number) {
  const pcm = Buffer.alloc(44100 * 4 * 2);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(value, i);
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22);
  header.writeUInt32LE(44100, 24); header.writeUInt32LE(44100 * 4, 28); header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
const songs = [0, 1, 2].map(index => ({ id: `flow-${index}`, title: `Part ${index + 1}`, artist: 'Album Artist',
  album: 'Album', albumId: 'album', duration: 2, track: index + 1, discNumber: 1 }));
const audio = songs.map((_, index) => wav(100 + index));
const definition: Flow = {
  id: 'b9ed04f7-3e85-44b2-8ec6-bd2ca327d533', name: 'Three parts', enabled: true, revision: 1,
  verification: 'verified', verificationError: null, orderVerified: true, createdAt: '', updatedAt: '',
  tracks: songs.map((song, index) => ({ id: song.id, title: song.title, artist: song.artist, album: song.album, duration: 2,
    fingerprint: { sha256: createHash('sha256').update(audio[index]!).digest('hex'), bytes: audio[index]!.length, decodedSeconds: 2 } })),
};
let discovered = 1;
let modelPayloads: string[] = [];
const originalFetch = globalThis.fetch;
test.before(async () => {
  await settings.load();
  await settings.update({ tts: { enabled: false }, llm: {
    provider: 'openai-compatible', model: 'flow-test', baseUrl: 'http://flow-model.invalid/v1', apiKey: 'test',
    fallback: { enabled: false }, noRepeatWindow: 0, artistVarietyWindow: 0,
    trackSelection: 'shortlist', shortlistPasses: 1,
  } });
  await library.load();
  writeFileSync(join(config.stateDir, 'sub-flows.json'), JSON.stringify([definition]));
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.open-meteo.com') return Response.json({ current: { temperature_2m: 15, weather_code: 0, is_day: 1 } });
    if (url.hostname === 'flow-library.invalid') {
      const endpoint = url.pathname.split('/').at(-1);
      const id = url.searchParams.get('id');
      if (endpoint === 'stream') return new Response(audio[songs.findIndex(song => song.id === id)], { headers: { 'content-type': 'audio/wav' } });
      const data = endpoint === 'getRandomSongs' ? { randomSongs: { song: [songs[discovered]] } }
        : endpoint === 'getStarred2' ? { starred2: { song: [songs[discovered]] } }
          : endpoint === 'getAlbumList2' ? { albumList2: { album: [{ id: 'album' }] } }
            : endpoint === 'getSong' ? { song: songs.find(song => song.id === id) }
              : endpoint === 'getAlbum' ? { album: { id: 'album', songCount: 3, song: songs } } : {};
      return Response.json({ 'subsonic-response': { status: 'ok', version: '1.16.1', ...data } });
    }
    assert.equal(url.hostname, 'flow-model.invalid');
    modelPayloads.push(String(init?.body));
    const body = JSON.parse(String(init?.body));
    const tools = body.tools ?? [];
    const discoveredAlready = body.messages.some((message: any) => message.role === 'tool');
    const toolName = tools.some((tool: any) => tool.function.name === 'randomSongs') && !discoveredAlready ? 'randomSongs'
      : tools.some((tool: any) => tool.function.name === 'done') ? 'done' : null;
    if (toolName) return chatCompletionResponse({ message: { role: 'assistant', content: null, tool_calls: [{ id: 'flow-call', type: 'function',
      function: { name: toolName, arguments: JSON.stringify(toolName === 'randomSongs' ? {} : { id: 'flow-0', reason: 'The continuous album sequence.' }) } }] } });
    return chatCompletionResponse(JSON.stringify({ id: 'flow-0', musicalReason: 'its continuous album sequence fits the surrounding music naturally',
      reason: 'The continuous album sequence.', transition: 'sweep' }));
  }) as typeof fetch;
});
test.after(async () => {
  globalThis.fetch = originalFetch; expectFlowPlayback(false); library.shutdown();
  await new Promise<void>(resolve => mixer.close(() => resolve()));
});

function snapshot() {
  const q = Object.create(queue);
  q.current = null; q.upcoming = []; q.history = []; q._recentPlays = []; q.senderBusy = true;
  return q;
}
const context = { at: new Date().toISOString(), activeShow: null, dominantMood: null, time: { period: 'day' } };

test('discovering only member two or three queues all three from the first without transition effects', async () => {
  for (const member of [0, 1, 2]) {
    discovered = member; clearPickerSourceCache(); modelPayloads = [];
    const q = snapshot();
    try {
      session.start(context as any);
      await runTrackEvent(q, context, { wantLink: false });
      assert.deepEqual(q.upcoming.map((item: any) => item.track.id), songs.map(song => song.id));
      assert.ok(q.upcoming.every((item: any) => item.flow && item.aiPicked && !item.track.sweep));
      assert.ok(modelPayloads.some(payload => payload.includes('Three parts')), 'the model sees the sequence before choosing');
      assert.equal(q.upcoming[0].flow.index, 0);
    } finally {
      if (q._persistTimer) clearTimeout(q._persistTimer);
      if (q.upcoming[0]?.flow) await discardFlow(q.upcoming[0].flow);
      expectFlowPlayback(false);
    }
  }
});

test('pool recovery also resolves the complete Flow before its model and queue admission', async () => {
  discovered = 2; clearPickerSourceCache(); modelPayloads = [];
  const q = snapshot();
  try {
    const selected = await pickViaPool(q, context);
    assert.equal(selected?.song.id, 'flow-0');
    assert.ok((selected?.song as any).subFlow);
    assert.ok(modelPayloads.some(payload => payload.includes('Three parts')));
    assert.notEqual(await enqueuePick(q, selected!.song, selected!.reason, 'pool'), -1);
    assert.deepEqual(q.upcoming.map((item: any) => item.track.id), songs.map(song => song.id));
  } finally {
    if (q._persistTimer) clearTimeout(q._persistTimer);
    if (q.upcoming[0]?.flow) await discardFlow(q.upcoming[0].flow);
    expectFlowPlayback(false);
  }
});


test('the Agentic tool loop also sees and queues the ordered unit when discovery returns member three', async () => {
  await settings.update({ llm: { trackSelection: 'agentic' } });
  discovered = 2; clearPickerSourceCache(); modelPayloads = [];
  const q = snapshot();
  try {
    session.start(context as any);
    await runTrackEvent(q, context, { wantLink: false });
    assert.deepEqual(q.upcoming.map((item: any) => item.track.id), songs.map(song => song.id));
    assert.ok(q.upcoming.every((item: any) => item.flow && item.aiPicked));
    assert.ok(modelPayloads.some(payload => payload.includes('randomSongs')), 'Agentic discovery actually ran');
    assert.ok(modelPayloads.some(payload => payload.includes('Three parts')));
  } finally {
    if (q._persistTimer) clearTimeout(q._persistTimer);
    if (q.upcoming[0]?.flow) await discardFlow(q.upcoming[0].flow);
    expectFlowPlayback(false);
  }
});
