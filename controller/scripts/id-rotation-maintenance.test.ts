import assert from 'node:assert/strict';
import cp, { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const OLD = 'KhehcqGKwAIL6Ux3Ah0yDC';
const NEW = '6owyzFEyktb6jxHvAYbn6w';
const OLD_B = 'e3b7fc2ae9447bbec37a13bf916e3cf6';
const PLAYLIST = '0000000000000000000001'; // canonical fixed point
const self = fileURLToPath(import.meta.url);
const controller = fileURLToPath(new URL('../', import.meta.url));
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function until(predicate: () => boolean | Promise<boolean>, message: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await predicate()) return;
    await pause(25);
  }
  assert.fail(message);
}

async function scenario(mode: string): Promise<void> {
  const state = process.env.STATE_DIR!;
  let rotated = !['cached', 'enrichment', 'inflight', 'noop'].includes(mode);
  const incomplete = mode === 'partial' || mode === 'malformed';
  let playlistReads = 0;
  const heldPlaylists: Array<{ response: ServerResponse; entry: ReturnType<typeof song>[] }> = [];
  const heldYears: ServerResponse[] = [];
  let yearsReleased = false;
  const releaseYears = () => {
    yearsReleased = true;
    for (const response of heldYears) response.end(JSON.stringify({ recordings: [] }));
  };
  const song = () => ({ id: rotated ? NEW : OLD, title: 'Memory Bank', artist: 'Jethro Tull',
    albumId: 'a', year: 2000, duration: 240 });
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://mock');
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/mb') {
      heldYears.push(res);
      if (yearsReleased) res.end(JSON.stringify({ recordings: [] }));
      return;
    }
    let sub: Record<string, unknown> = { status: 'ok' };
    switch (url.pathname.split('/').at(-1)) {
      case 'getSong':
        sub = url.searchParams.get('id') === OLD
          ? { status: 'failed', error: { code: 70, message: 'Song not found' } }
          : { status: 'ok', song: { ...song(), id: NEW } };
        break;
      case 'getAlbumList2':
        sub.albumList2 = { album: mode === 'empty' ? [] : [{ id: 'a' }, ...(incomplete ? [{ id: 'b' }] : [])] };
        break;
      case 'getAlbum':
        sub = url.searchParams.get('id') === 'b'
          ? mode === 'malformed' ? { status: 'ok' }
            : { status: 'failed', error: { code: 0, message: 'Temporary server error' } }
          : { status: 'ok', album: { id: 'a', isCompilation: mode === 'enrichment', song: [song()] } };
        break;
      case 'getPlaylists': sub.playlists = { playlist: [{ id: PLAYLIST, name: 'Pinned' }] }; break;
      case 'getPlaylist':
        playlistReads++;
        if (mode === 'inflight' && playlistReads === 1) {
          heldPlaylists.push({ response: res, entry: [song()] });
          return;
        }
        sub.playlist = { entry: [song()] };
        break;
      case 'getStarred2': sub.starred2 = { song: [] }; break;
      case 'getRandomSongs': sub.randomSongs = { song: [] }; break;
      default: sub.albumList2 = { album: [] }; break;
    }
    res.end(JSON.stringify({ 'subsonic-response': sub }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  const origin = `http://127.0.0.1:${addr.port}`;
  process.env.NAVIDROME_URL = origin;
  process.env.NAVIDROME_USER = 'test';
  process.env.NAVIDROME_PASS = 'test';
  process.env.LIQUIDSOAP_HOST = '127.0.0.1';
  process.env.LIQUIDSOAP_PORT = '1';
  // Both controller and real maintenance worker deny external HTTP. MusicBrainz
  // goes to a deliberately held local response, not a sleep or the live service.
  const preload = join(state, 'network.mjs');
  writeFileSync(preload, `
const request = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(String(input));
  if (url.hostname === 'musicbrainz.org') return request(${JSON.stringify(origin + '/mb')}, init);
  if (url.origin !== ${JSON.stringify(origin)}) return Promise.reject(new Error('external network disabled'));
  return request(input, init);
};
`);
  await import(preload);
  const spawn = cp.spawn;
  cp.spawn = ((command, args, opts) => {
    if (command === 'npx' && opts?.cwd === '/app') {
      return spawn(process.execPath, ['--import', 'tsx', '--import', preload, ...args!.slice(1)],
        { ...opts, cwd: controller });
    }
    return spawn(command, args, opts);
  }) as typeof cp.spawn;
  syncBuiltinESMExports();
  const db = await import('../src/music/library-db.js');
  const settings = await import('../src/settings.js');
  await settings.load();
  await settings.update({ embedding: { enrichment: { originalYear: mode === 'enrichment' } } });
  await db.open({ embeddingDim: 8, adoptStoredDim: true });
  for (const id of [OLD, OLD_B]) {
    db.upsertTrackMeta(id, { title: id === OLD ? 'Memory Bank' : 'Song B', artist: 'Jethro Tull' });
    db.upsertTrackTags(id, { moods: ['warm'], energy: 'medium', source: 'manual', confidence: 1 });
    db.upsertTrackVector(id, [1, 2, 3, 4, 5, 6, 7, 8]);
  }
  const playlist = await import('../src/music/show-playlist.js');
  if (mode === 'inflight') {
    try {
      const oldLookup = playlist.resolveShowPlaylistPool({ playlistIds: [PLAYLIST] });
      await until(() => heldPlaylists.length > 0, 'playlist fetch was not held');
      playlist.clearPlaylistCache();
      rotated = true;
      const held = heldPlaylists[0];
      held.response.end(JSON.stringify({ 'subsonic-response': { status: 'ok', playlist: { entry: held.entry } } }));
      assert.equal((await oldLookup)!.tracks[0].id, OLD);
      const fresh = await playlist.resolveShowPlaylistPool({ playlistIds: [PLAYLIST] });
      assert.equal(fresh!.tracks[0].id, NEW, 'old in-flight response must not repopulate the cleared cache');
      assert.equal(playlistReads, 2);
    } finally {
      db.close();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    return;
  }
  if (mode === 'cached' || mode === 'enrichment') {
    await settings.update({ shows: [{ name: 'Pinned show', personaId: settings.get().personas[0].id,
      playlistIds: [PLAYLIST], playlistStrict: true }] });
    await settings.update({ schedule: Array.from({ length: 7 }, () =>
      Array(24).fill(settings.get().shows[0].id)) });
    const show = settings.resolveActiveShow();
    assert.ok(show, 'the pinned show must be active');
    assert.equal((await playlist.resolveShowPlaylistPool(show))!.tracks[0].id, OLD);
    writeFileSync(join(state, 'auto.m3u'), '#EXTM3U\n' + OLD);
    rotated = true;
  }
  const maintenance = await import('../src/broadcast/tagger.js');
  try {
    assert.equal(await maintenance.considerIdRotationRecovery({ id: OLD }), 'started');
    if (mode === 'enrichment') {
      await until(() => heldYears.length > 0, 'the real child never reached MusicBrainz enrichment');
      await until(() => readFileSync(join(state, 'auto.m3u'), 'utf8').includes(NEW),
        'fallback must recover while original-year enrichment is held');
      assert.equal(maintenance.tagger.running, true, 'refresh must not wait for child exit');
      assert.equal(db.pendingIdRotations().size, 0, 'journal must settle before fallback recovery');
      releaseYears();
    }
    await until(() => !maintenance.tagger.running && maintenance.tagger.lastRun !== null,
      'maintenance did not finish');
    if (incomplete) {
      assert.equal(maintenance.tagger.lastRun!.outcome, 'failed', 'incomplete walks must fail, never prune');
      assert.deepEqual(db.getTrack(OLD_B)!.moods, ['warm']);
      assert.ok(db.requireDb().prepare('SELECT id FROM track_vectors WHERE id = ?').get(OLD_B));
      assert.equal(await maintenance.considerIdRotationRecovery({ id: OLD }), 'started', 'partial walk stays retryable');
    } else if (mode === 'empty' || mode === 'noop') {
      assert.equal(maintenance.tagger.lastRun!.outcome, 'ok', 'manual empty-walk exit semantics stay unchanged');
      assert.ok(db.getTrack(OLD));
      assert.equal(db.getTrack(NEW), null);
      await until(async () => await maintenance.considerIdRotationRecovery({ id: OLD }) === 'started',
        'empty/no-op automatic walk stays retryable after completion follow-ups');
    } else {
      await until(() => readFileSync(join(state, 'auto.m3u'), 'utf8').includes(NEW), 'fallback still holds rotated IDs');
      const m3u = readFileSync(join(state, 'auto.m3u'), 'utf8');
      assert.equal(m3u.includes(OLD), false, 'cached old playlist members must not return to the fallback');
      assert.ok(playlistReads >= 2, 'unchanged playlist ID must still fetch new members');
      assert.deepEqual(db.getTrack(NEW)!.moods, ['warm']);
      assert.equal(await maintenance.considerIdRotationRecovery({ id: OLD }), 'already-started');
    }
    await until(() => !maintenance.tagger.running, 'retry did not finish');
  } finally {
    releaseYears();
    if (maintenance.tagger.running) maintenance.stopTagger();
    await until(() => !maintenance.tagger.running, 'test worker failed to stop');
    db.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

if (process.argv[2]) {
  await scenario(process.argv[2]);
} else {
  for (const [mode, name] of [
    ['partial', 'an incomplete automatic walk preserves healthy tags and vectors and can retry'],
    ['malformed', 'a malformed album response cannot authorize pruning or suppress a retry'],
    ['empty', 'an empty successful automatic reconcile can retry without restarting the controller'],
    ['noop', 'a nonempty walk that leaves the confirmed legacy ID unchanged stays retryable'],
    ['cached', 'reconcile rebuilds a strict fallback with fresh members of an unchanged playlist ID'],
    ['enrichment', 'settled adoption recovers the fallback before unrelated MusicBrainz enrichment completes'],
    ['inflight', 'a pre-migration playlist fetch cannot repopulate an invalidated cache'],
  ]) {
    test(name, { timeout: 30_000 }, () => {
      const state = mkdtempSync(join(tmpdir(), 'rotation-maintenance-'));
      try {
        const result = spawnSync(process.execPath, ['--import', 'tsx', self, mode], {
          env: { ...process.env, STATE_DIR: state }, encoding: 'utf8', timeout: 25_000,
        });
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      } finally {
        rmSync(state, { recursive: true, force: true });
      }
    });
  }
}
