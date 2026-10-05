// Exercise the real pick/start runners, handoff generator and voice placement.
// Model/context calls are controlled in child processes so module mocks cannot
// leak into other tests. TTS and voice publication use the queue's existing seams.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mock, test } from 'node:test';

const mode = process.argv[2];

async function scenario() {
  const settings = await import('../src/settings.js');
  const session = await import('../src/broadcast/session.js');
  const context = await import('../src/context.js');
  const djAgent = await import('../src/broadcast/dj-agent.js');
  const { currentTalkAir } = await import('../src/broadcast/talk-air.js');
  const { writeSilentWav } = await import('../src/audio/wav-silence.js');
  const template = settings.get().personas[0];
  const outgoing = { ...template, id: 'p_outgoing', name: 'Outgoing' };
  const incoming = { ...template, id: 'p_incoming', name: 'Incoming' };
  const outShow = { id: 's_outgoing', name: 'Outgoing show', topic: '', personaId: outgoing.id };
  const inShow = { id: 's_incoming', name: 'Incoming show', topic: '', personaId: incoming.id };
  const now = Date.now();
  const nextHour = Math.floor(now / 3_600_000) * 3_600_000 + 3_600_000;
  const betweenTracks = mode?.endsWith('between-tracks') === true;
  const overdue = mode?.startsWith('overdue');
  const schedule: Record<number, string[]> = {};
  for (let day = 0; day < 7; day++) schedule[day] = Array(24).fill(overdue ? inShow.id : outShow.id);
  const next = new Date(nextHour);
  if (!overdue) schedule[next.getUTCDay()][next.getUTCHours()] = inShow.id;
  await settings.update({
    timezone: 'UTC', personas: [outgoing, incoming], activePersonaId: outgoing.id,
    shows: [outShow, inShow],
    schedule: overdue ? Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, Array(24).fill(outShow.id)])) : schedule,
    djTalkOnlyBetweenTracks: betweenTracks,
  } as never);
  function getContext(at = new Date()) {
    return {
      at: at.toISOString(), time: { period: 'evening', vibe: 'evening', mood: 'warm' },
      weather: null, festival: null, dominantMood: 'warm', date: {}, clock: {}, listeners: 1,
      activeShow: settings.resolveActiveShow(at),
    } as session.SessionContext;
  }
  session.start({ ...getContext(), activeShow: outShow } as session.SessionContext);
  if (overdue) await settings.update({ schedule } as never);
  const placements: string[] = [];
  let generations = 0;
  mock.module(new URL('../src/context.ts', import.meta.url).href, {
    namedExports: { ...context, getFullContext: async (at?: Date) => getContext(at) },
  });
  mock.module(new URL('../src/broadcast/dj-agent.ts', import.meta.url).href, {
    namedExports: {
      ...djAgent,
      runTrackEvent: async () => {},
      runPersonaHandoff: async (queue: unknown, ctx: session.SessionContext) => {
        placements.push(currentTalkAir());
        await djAgent.runPersonaHandoff(queue, ctx, {
          generateSignoff: async () => { generations++; return 'The hour is yours.'; },
          generateHandoffGreeting: async () => { generations++; return 'Thanks for the handover.'; },
        });
      },
    },
  });
  const { queue } = await import('../src/broadcast/queue.js');
  const wav = join(process.env.STATE_DIR!, 'voice.wav');
  await writeSilentWav(wav, 25);
  const writes: string[] = [];
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  let releaseReplacement!: () => void;
  const replacementWaiting = new Promise<void>(resolve => { releaseReplacement = resolve; });
  let replacementRendering = false;
  let introRenders = 0;
  queue._speak = async text => {
    if (text === 'Replacement intro') {
      replacementRendering = true;
      await replacementWaiting;
    }
    if (text === 'Final track intro') {
      introRenders++;
      if (mode?.startsWith('pending-render') || mode === 'pending-bed-render') await waiting;
      if (mode === 'failed-render') throw new Error('controlled intro render failure');
    }
    return wav;
  };
  queue._airVoice = async (_target, _wav, text) => {
    if (text === 'Final track intro' && (mode === 'pending-publication' || mode === 'pending-bed-publication')) await waiting;
    writes.push(text);
    return { voiceId: 'stub', clipMs: 1, aired: Promise.resolve(null) };
  };
  queue.autoLink = false;
  // Fixed iteration bounds work even if a fixture later freezes Date.now.
  async function waitFor(check: () => boolean) {
    for (let n = 0; n < 300 && !check(); n++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(check(), `scenario ${mode} did not settle`);
  }
  if (overdue) {
    const skipped = { id: 'skipped', title: 'Skipped final track', artist: 'Artist' };
    assert.equal(session.armBoundaryHandoff(getContext(), skipped), true);
    const record = session.getSession()!.boundaryHandoff!;
    record.boundaryAt = now - 7 * 60_000;
    record.at = now - 10 * 60_000;
    const originalContextAt = record.contextAt;
    await session.maybeRoll(getContext());
    queue.current = {
      track: { id: 'playing', title: 'Playing', artist: 'Artist', duration: 300 },
      startedAt: new Date(now - 200_000).toISOString(), source: 'auto',
    };
    const held = { track: { id: 'held', title: 'Held', artist: 'Artist', duration: 300 }, aiPicked: true };
    queue.upcoming = [held];
    // Operator/scheduler reads and both generic pick paths must leave it armed.
    session.pendingHandoff();
    session.boundaryHandoffStatus();
    session.handoffInProgress();
    queue.runPickCycle({ isAutonomous: true, pickAnchorItem: held });
    await waitFor(() => !queue.pickerBusy);
    queue.runPickCycle({ isAutonomous: true });
    await waitFor(() => !queue.pickerBusy);
    assert.equal(generations, 0, 'no handoff generation before another confirmed start');
    assert.deepEqual(writes, [], 'no voice publication from a generic deadline pick');
    assert.equal(session.boundaryHandoffAwaitsTrack(), true);
    assert.deepEqual(record.finalTrack, skipped);
    assert.equal(record.contextAt, originalContextAt, 'reads must not refresh speech context');
    // An untracked auto-playlist fallback is also confirmed playback.
    queue.autoPick = false;
    queue.upcoming = [];
    queue.onTrackStarted({ subsonic_id: 'fallback', title: 'Fallback', artist: 'Artist' });
    await waitFor(() => writes.length === 2);
    assert.equal(generations, 2);
    assert.deepEqual(placements, [betweenTracks ? 'next-track' : 'immediate']);
    assert.deepEqual(writes, ['The hour is yours.', 'Thanks for the handover.']);
    assert.equal(record.finalTrack?.id, 'fallback', 'generic callers remain gated during rendering');
    assert.ok(Date.parse(record.contextAt!) >= now, 'context is refreshed by confirmation');
    await waitFor(() => record.aired);
  } else {
    const item = {
      track: { id: 'final', title: 'Final', artist: 'Artist', duration: (nextHour - now) / 1000 + 60 },
      introScript: 'Final track intro', introKind: 'link', introPersona: outgoing,
      introSessionKey: `show:${outShow.id}`, aiPicked: true, sent: true,
    };
    if (mode === 'retry-muted') {
      await settings.update({ tts: { ...settings.get().tts, enabled: false } } as never);
      await queue.airIntro(item);
      assert.deepEqual(writes, []);
      await settings.update({ tts: { ...settings.get().tts, enabled: true } } as never);
      await queue.airIntro(item);
      assert.deepEqual(writes, ['Final track intro'], 'a completed no-op must not block a later intro');
      return;
    }
    queue.upcoming = [item];
    if (mode?.startsWith('pending-bed')) {
      Object.assign(item, { bedded: true, bedEntrySec: 0 });
      const { config } = await import('../src/config.js');
      writeFileSync(config.liquidsoap.bedPlayingFile, JSON.stringify({ startedAt: Date.now() / 1000 }));
      queue.onBedStarted();
      await waitFor(() => introRenders === 1);
    }
    // The drain gave up waiting for this render; track-start must reuse it.
    if (mode?.startsWith('pending-render')) queue.startIntroRender(item);
    queue.onTrackStarted({ subsonic_id: item.track.id, title: item.track.title, artist: item.track.artist });
    await waitFor(() => !queue.pickerBusy);
    if (mode !== 'failed-render') {
      assert.deepEqual(writes, [], 'handoff publication must wait for the final intro');
      if (mode === 'pending-render-superseded') {
        session.getSession()!.boundaryHandoff!.boundaryAt = Date.now() - 7 * 60_000;
        queue.autoPick = false;
        queue.upcoming = [{
          ...item, track: { ...item.track, id: 'replacement', title: 'Replacement' },
          introScript: 'Replacement intro',
        }];
        queue.onTrackStarted({ subsonic_id: 'replacement', title: 'Replacement', artist: 'Artist' });
        await waitFor(() => replacementRendering);
        release();
        await waitFor(() => writes.length === 1);
        assert.deepEqual(writes, ['Final track intro']);
        assert.equal(generations, 0, 'the old runner must not overtake the replacement intro');
        releaseReplacement();
        await waitFor(() => writes.length === 4);
        assert.deepEqual(writes, ['Final track intro', 'Replacement intro', 'The hour is yours.', 'Thanks for the handover.']);
        assert.equal(session.getSession()!.boundaryHandoff!.finalTrack?.id, 'replacement');
        assert.equal(generations, 2);
        await waitFor(() => session.boundaryHandoffStatus()?.state === 'aired');
        return;
      }
      if (betweenTracks) session.getSession()!.boundaryHandoff!.boundaryAt = Date.now() - 1;
      release();
    }
    if (betweenTracks) {
      await waitFor(() => queue._pendingVoice?.kind === 'handoff');
      assert.deepEqual(writes, ['Final track intro'], 'the pair stays deferred after the intro');
      assert.equal(queue._pendingVoice?.clips.length, 2, 'the complete pair occupies one slot');
      assert.equal(session.boundaryHandoffStatus()?.state, 'queued');
      queue.autoPick = false;
      queue.onTrackStarted({ subsonic_id: 'next', title: 'Incoming song', artist: 'Artist' });
    }
    await waitFor(() => writes.length === (mode === 'failed-render' ? 2 : 3));
    assert.deepEqual(writes, [
      ...(mode === 'failed-render' ? [] : ['Final track intro']),
      'The hour is yours.', 'Thanks for the handover.',
    ]);
    assert.equal(introRenders, 1, 'pending TTS is reused rather than rendered twice');
    assert.equal(generations, 2, 'the track-start and on-air runners publish only one pair');
    await waitFor(() => session.boundaryHandoffStatus()?.state === 'aired');
  }
}

if (mode) {
  await scenario();
  // Production persistence timers are irrelevant once all behavioral assertions
  // settle; exiting also keeps child module mocks out of the parent runner.
  process.exit(0);
} else {
  for (const scenarioName of ['overdue-immediate', 'overdue-between-tracks', 'pending-render', 'pending-render-between-tracks', 'pending-render-superseded', 'pending-publication', 'pending-bed-render', 'pending-bed-publication', 'retry-muted', 'failed-render']) {
    test(`handoff release: ${scenarioName}`, () => {
      const root = mkdtempSync(join(tmpdir(), 'subwave-handoff-release-'));
      try {
        const result = spawnSync(process.execPath, [
          '--experimental-test-module-mocks', '--import', 'tsx', fileURLToPath(import.meta.url), scenarioName,
        ], { env: { ...process.env, STATE_DIR: root }, encoding: 'utf8', timeout: 15_000 });
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}
