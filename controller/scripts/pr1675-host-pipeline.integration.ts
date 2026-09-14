// Opt-in PR #1675 runtime validation. This is intentionally not a *.test.ts:
// it boots the full controller and expects a disposable production
// Liquidsoap/Icecast container to share STATE_DIR and MUSIC_LIBRARY_PATH.
//
// The driver replaces only the two Agent.run methods with deterministic local
// fixtures. Queue persistence, Piper synthesis, file IPC, the mixer, markers,
// and the Icecast stream stay real. Run only in an isolated throwaway state.

import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const STATE_DIR = process.env.STATE_DIR;
const MUSIC_DIR = process.env.MUSIC_LIBRARY_PATH;
assert(STATE_DIR, 'STATE_DIR is required');
assert(MUSIC_DIR, 'MUSIC_LIBRARY_PATH is required');
assert.equal(
  process.env.PR1675_DISPOSABLE_INTEGRATION,
  '1',
  'refusing to run without PR1675_DISPOSABLE_INTEGRATION=1',
);

const phaseFile = join(STATE_DIR, 'pr1675-integration-phase.json');
const phase = existsSync(phaseFile) ? 2 : 1;
const showId = 'e2e_show';
const skillKind = 'host-race';
const oldRequestId = 'request-old';
const freshRequestId = 'request-fresh';
const controllerOrigin = `http://127.0.0.1:${process.env.PORT || '7701'}`;

// Keep context deterministic and local. This is a fixture for the otherwise
// external weather read, not a model response; all local/controller/Icecast
// fetches continue through Node's native implementation.
const nativeFetch = globalThis.fetch;
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
  if (url.startsWith('https://api.open-meteo.com/')) {
    return Promise.resolve(new Response(JSON.stringify({
      current: { temperature_2m: 16, weather_code: 2, is_day: 1 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
  }
  if (url.startsWith('http://127.0.0.1:9/rest/')) {
    return Promise.resolve(new Response(JSON.stringify({
      'subsonic-response': { status: 'ok', version: '1.16.1', type: 'fixture' },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
  }
  return nativeFetch(input as never, init);
}) as typeof fetch;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor<T>(
  read: () => T | null | undefined | false | Promise<T | null | undefined | false>,
  label: string,
  timeoutMs = 60_000,
): Promise<T> {
  const until = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < until) {
    try {
      const value = await read();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}${lastError ? `: ${String(lastError)}` : ''}`);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function readJson(path: string): any | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

interface FileEvent {
  at: number;
  file: string;
  value: any;
}

function startStateMonitor() {
  const events: FileEvent[] = [];
  const present = new Map<string, string>();
  const handoffs = ['next.txt', 'say.txt', 'intro.txt'];
  const markers = ['now-playing.json', 'voice-playing.json'];
  const timer = setInterval(() => {
    for (const file of handoffs) {
      const path = join(STATE_DIR, file);
      if (!existsSync(path)) {
        present.delete(file);
        continue;
      }
      try {
        const value = readFileSync(path, 'utf8').trim();
        if (present.get(file) !== value) {
          present.set(file, value);
          events.push({ at: Date.now(), file, value });
        }
      } catch {}
    }
    for (const file of markers) {
      const path = join(STATE_DIR, file);
      if (!existsSync(path)) continue;
      try {
        const raw = readFileSync(path, 'utf8');
        if (present.get(file) !== raw) {
          present.set(file, raw);
          events.push({ at: Date.now(), file, value: JSON.parse(raw) });
        }
      } catch {}
    }
  }, 10);
  return {
    events,
    stop: () => clearInterval(timer),
    count: (file: string) => events.filter(event => event.file === file).length,
    since: (file: string, index: number) => events.filter(event => event.file === file).slice(index),
  };
}

function week(show: string): Record<number, string[]> {
  const schedule: Record<number, string[]> = {};
  for (let day = 0; day < 7; day++) schedule[day] = Array(24).fill(show);
  return schedule;
}

function show(personaId: string, guests: string[] = []) {
  return {
    id: showId,
    name: 'PR 1675 Isolated Show',
    topic: 'disposable integration validation',
    personaId,
    guestPersonaIds: guests,
    banter: guests.length > 0,
  };
}

function context() {
  return {
    at: new Date().toISOString(),
    time: { period: 'day', vibe: 'day', mood: 'calm' },
    clock: { spokenDaypart: 'this afternoon' },
    weather: { condition: 'cloudy', temp: 16, tempUnit: 'C', location: 'Test Lab' },
    festival: null,
    dominantMood: 'calm',
    activeShow: { id: showId, name: 'PR 1675 Isolated Show', topic: 'disposable integration validation' },
  } as any;
}

function writeSyntheticAutoPlaylist() {
  writeFileSync(join(STATE_DIR, 'auto.m3u'), [
    '#EXTM3U',
    'annotate:title="Baseline One",artist="Synthetic",album="PR1675",subsonic_id="baseline-1",liq_cross_duration="1":/music/baseline-1.wav',
    'annotate:title="Baseline Two",artist="Synthetic",album="PR1675",subsonic_id="baseline-2",liq_cross_duration="1":/music/baseline-2.wav',
    'annotate:title="Baseline Three",artist="Synthetic",album="PR1675",subsonic_id="baseline-3",liq_cross_duration="1":/music/baseline-3.wav',
    '',
  ].join('\n'));
}

mkdirSync(STATE_DIR, { recursive: true });
mkdirSync(join(STATE_DIR, 'skills', skillKind), { recursive: true });
writeFileSync(join(STATE_DIR, 'skills', skillKind, 'SKILL.md'), [
  '---',
  `name: ${skillKind}`,
  'cooldown: 0',
  '---',
  'Say one short deterministic sentence about this isolated validation.',
  '',
].join('\n'));

const settings = await import('../src/settings.js');
await settings.load();

if (phase === 1) {
  const template = settings.get().personas[0];
  // Silent at ordinary cron ticks. Phase 1 temporarily raises the host to
  // aggressive only around direct agenticTick calls, keeping every model run
  // in this harness deterministic and explicitly controlled.
  const hostA = { ...template, id: 'host_a', name: 'Host A', frequency: 'silent', skills: [skillKind] };
  const hostB = { ...template, id: 'host_b', name: 'Host B', frequency: 'silent', skills: [skillKind] };
  const guest = { ...template, id: 'guest_c', name: 'Guest C', frequency: 'silent', skills: [skillKind] };
  await settings.update({
    personas: [hostA, hostB, guest],
    activePersonaId: hostA.id,
    shows: [show(hostA.id)],
    schedule: week(showId),
    scheduleOverride: null,
    timezone: 'Europe/London',
    crossfadeDuration: 1,
    jingleRatio: 0,
    transitions: { pairDrain: false, stemBlends: false },
    tts: { enabled: true, defaultEngine: 'piper' },
    llm: { pickerAgent: true, pauseWhenEmpty: false },
    requests: {
      enabled: true,
      maxPending: 10,
      globalHourlyCap: 50,
      repeatCooldownMin: 0,
      cooldownSec: 5,
      perIpHourlyCap: 10,
      onePendingPerIp: false,
    },
    skills: { enabled: { [skillKind]: true } },
    sfx: { enabled: false },
    beds: { enabled: false, requestIntros: false },
  } as never);
  await settings.ensureLiquidsoapSettingsFile();
  writeSyntheticAutoPlaylist();
  writeFileSync(join(STATE_DIR, 'pr1675-broadcast-can-start'), new Date().toISOString());
}

const monitor = startStateMonitor();
await import('../src/server.js');

const session = await import('../src/broadcast/session.js');
const { queue } = await import('../src/broadcast/queue.js');
const { getFullContext } = await import('../src/context.js');
const { requestAgent } = await import('../src/broadcast/dj-agent/agents.js');
const { agenticTick, directorAgent, forcedDirectorAgent, runCapability } = await import('../src/skills/_agent.js');

const personas = () => settings.get().personas;
const persona = (id: string) => {
  const found = personas().find((item: any) => item.id === id);
  assert(found, `missing persona ${id}`);
  return found;
};
const hostA = () => persona('host_a');
const hostB = () => persona('host_b');
const guest = () => persona('guest_c');

async function changeHost(personaId: string, guests: string[] = []) {
  await settings.update({ shows: [show(personaId, guests)] } as never);
  session.captureHostSpeech();
  return session.captureHostSpeech();
}

async function setPersonaFrequency(frequency: string) {
  await settings.update({
    personas: personas().map((item: any) => ({ ...item, frequency })),
  } as never);
}

async function request(
  ip: string,
  text: string,
  name: string,
): Promise<{ receipt: any; result: any }> {
  const submitted = await nativeFetch(`${controllerOrigin}/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ text, name }),
  });
  const receipt = await submitted.json();
  assert.equal(submitted.status, 202, JSON.stringify(receipt));
  const result = await waitFor(async () => {
    const polled = await nativeFetch(`${controllerOrigin}/request/${receipt.requestId}`);
    const body = await polled.json();
    return body.status === 'pending' ? null : body;
  }, `request ${receipt.requestId} to resolve`);
  assert.equal(result.status, 'resolved', JSON.stringify(result));
  return { receipt, result };
}

await waitFor(async () => {
  const response = await nativeFetch(`${controllerOrigin}/health`).catch(() => null);
  return response?.ok ? true : null;
}, 'controller health');
await waitFor(() => session.getSession()?.key === `show:${showId}` ? session.getSession() : null, 'scheduled-show session');
// Synthetic coast tracks should never provoke the ordinary automatic picker;
// this harness queues every music item itself.
queue.autoPick = false;
queue.autoLink = false;
await waitFor(() => existsSync(join(STATE_DIR, 'pr1675-integration-go')), 'isolated broadcast/listener start signal');
// startScheduler refreshes the coast on boot. The fake Navidrome is
// deliberately unreachable, so restore the local synthetic list after that
// production startup path has finished and immediately before the scenarios.
writeSyntheticAutoPlaylist();

const realDirectorRun = directorAgent.run;
const realForcedRun = forcedDirectorAgent.run;
const realRequestRun = requestAgent.run;
const realSpeak = (queue as any)._speak;

try {
  if (phase === 1) {
    // Make the integration session explicit after the server's normal recover
    // path, then exercise the autonomous segment director used by talkTick.
    session.start(context());
    await setPersonaFrequency('aggressive');
    const initial = session.captureHostSpeech();
    assert.equal(initial?.personaId, hostA().id);
    assert.equal(initial?.revision, 0);

    let speakCalls = 0;
    (queue as any)._speak = async (...args: any[]) => {
      speakCalls += 1;
      return realSpeak(...args);
    };

    const generationStarted = deferred<void>();
    const generationResult = deferred<any>();
    directorAgent.run = async () => {
      generationStarted.resolve();
      return generationResult.promise;
    };
    const generationRace = agenticTick(context());
    await generationStarted.promise;
    const b1 = await changeHost(hostB().id);
    assert.equal(b1?.revision, 1);
    generationResult.resolve({
      object: {
        air: true,
        reason: 'deterministic generation fixture',
        segment: { kind: skillKind, text: 'Host A stale generation must not air.', sfx: null },
      },
      steps: 1,
      toolCalls: [],
      extras: undefined,
    });
    await generationRace;
    assert.equal(speakCalls, 0, 'stale autonomous generation must not enter TTS');

    const ttsRendered = deferred<{ wavPath: string; size: number }>();
    const releaseTts = deferred<void>();
    directorAgent.run = async () => ({
      object: {
        air: true,
        reason: 'deterministic TTS fixture',
        segment: { kind: skillKind, text: 'Host B stale rendered speech must not air.', sfx: null },
      },
      steps: 1,
      toolCalls: [],
      extras: undefined,
    });
    (queue as any)._speak = async (...args: any[]) => {
      const wavPath = await realSpeak(...args);
      ttsRendered.resolve({ wavPath, size: statSync(wavPath).size });
      await releaseTts.promise;
      return wavPath;
    };
    const handoffsBeforeTtsRace = monitor.count('say.txt') + monitor.count('intro.txt');
    const ttsRace = agenticTick(context());
    const rendered = await ttsRendered.promise;
    assert(rendered.size > 4_096, 'real Piper output must be a substantive WAV');
    const a2 = await changeHost(hostA().id);
    assert.equal(a2?.revision, 2);
    releaseTts.resolve();
    await ttsRace;
    await sleep(750);
    assert.equal(
      monitor.count('say.txt') + monitor.count('intro.txt'),
      handoffsBeforeTtsRace,
      'speech rendered for the previous host must not reach a mixer handoff',
    );

    // Stage a real HTTP listener request while the sender is held. Its words
    // belong to A/revision 2. A -> B -> A then persists revision 4 before the
    // controller exits, leaving recover() to discard only the obsolete intro.
    (queue as any)._speak = realSpeak;
    await setPersonaFrequency('silent');
    queue.senderBusy = true;
    const oldTrack = {
      id: oldRequestId,
      title: 'Recovered Listener Request',
      artist: 'Synthetic',
      album: 'PR1675',
      duration: 12,
      path: 'request-old.wav',
    };
    requestAgent.run = async () => ({
      object: {
        kind: 'track',
        id: oldTrack.id,
        ack: 'The recovered request is queued.',
        intro: 'Host A introduces the recovered listener request.',
      },
      steps: 1,
      toolCalls: [],
      extras: { seen: new Map([[oldTrack.id, oldTrack]]) },
    });
    const oldRequest = await request('198.51.100.10', 'play the recovered fixture', 'Alice');
    const staged = queue.upcoming.find(item => item.track.id === oldTrack.id);
    assert(staged, 'listener request must enter the queue');
    // The production request projection deliberately carries only Navidrome
    // fields; real playback resolves its id to a stream URL. This isolated
    // fixture uses a shared local file instead, attached after route resolution.
    staged.track.path = oldTrack.path;
    assert.equal(staged.requestedBy, 'Alice');
    assert.equal(staged.introHostSpeech?.revision, 2);
    assert.match(staged.introScript || '', /recovered listener request/i);

    queue.persist();
    await waitFor(() => {
      const stored = readJson(join(STATE_DIR, 'queue.json'));
      const item = stored?.upcoming?.find((entry: any) => entry.track?.id === oldTrack.id);
      return item?.introHostSpeech?.revision === 2 ? item : null;
    }, 'revision-2 queue snapshot before the simulated crash');

    // Deterministically hold the exact cleanup seam to model a controller
    // crash after session.json has committed A -> B -> A but before the next
    // watcher pass can rewrite queue.json. The fresh process restores the real
    // method and must reconcile the two durable snapshots on recover().
    (queue as any).invalidateObsoleteHostSpeech = () => 0;
    const b3 = await changeHost(hostB().id);
    const a4 = await changeHost(hostA().id);
    assert.equal(b3?.revision, 3);
    assert.equal(a4?.revision, 4);

    const durableSession = readJson(join(STATE_DIR, 'session.json'));
    const durableQueue = readJson(join(STATE_DIR, 'queue.json'));
    const durableItem = durableQueue?.upcoming?.find((item: any) => item.track?.id === oldTrack.id);
    assert.equal(durableSession?.persona?.id, hostA().id);
    assert.equal(durableSession?.hostRevision, 4);
    assert.equal(durableItem?.requestedBy, 'Alice');
    assert.equal(durableItem?.introHostSpeech?.revision, 2);
    assert.equal(durableItem?.sent, false);

    const report = {
      phase: 1,
      modelFixture: 'deterministic in-process Agent.run results; no real LLM/provider call',
      generationRace: { commissioned: initial, afterHostChange: b1, ttsCalls: speakCalls },
      ttsRace: { rendered, afterHostChange: a2, mixerHandoffsAdded: 0 },
      restartInterleaving: {
        request: oldRequest,
        queued: {
          id: durableItem.track.id,
          requestedBy: durableItem.requestedBy,
          introRevision: durableItem.introHostSpeech.revision,
          sent: durableItem.sent,
        },
        session: { personaId: durableSession.persona.id, hostRevision: durableSession.hostRevision },
      },
      events: monitor.events,
    };
    writeFileSync(join(STATE_DIR, 'pr1675-integration-phase1.json'), JSON.stringify(report, null, 2));
    writeFileSync(phaseFile, JSON.stringify({ next: 2, at: new Date().toISOString() }));
    console.log('PR1675_PHASE1_OK', JSON.stringify(report));
    monitor.stop();
    process.exit(0);
  }

  // Phase 2 is a genuinely fresh controller process over the same state and a
  // mixer that never restarted. Recover must retain listener provenance/music
  // while invalidating the stale host-owned intro.
  const recovered = await waitFor(() => {
    const item = queue.upcoming.find(entry => entry.track.id === oldRequestId);
    return item && item.introScript === null ? item : null;
  }, 'recovered requested item with obsolete speech removed');
  assert.equal(recovered.requestedBy, 'Alice');
  assert.equal(recovered.introPersona, null);
  assert.equal(recovered.introHostSpeech, null);
  assert.equal(session.captureHostSpeech()?.revision, 4);

  const voiceCountBeforeRecoveredTrack = monitor.count('voice-playing.json');
  const recoveredMarker = await waitFor(() => {
    const marker = readJson(join(STATE_DIR, 'now-playing.json'));
    return marker?.subsonic_id === oldRequestId ? marker : null;
  }, 'recovered listener request at the mixer live edge', 75_000);
  const recoveredQueueItem = await waitFor(() => {
    const candidates = [queue.current, ...queue.history];
    return candidates.find(item => item?.track.id === oldRequestId) ?? null;
  }, 'recovered listener request in current/history state');
  assert.equal(recoveredQueueItem.requestedBy, 'Alice');
  await sleep(1_250);
  const staleIntroVoiceMarkers = monitor.count('voice-playing.json') - voiceCountBeforeRecoveredTrack;
  assert.equal(
    staleIntroVoiceMarkers,
    0,
    'the stale recovered intro must not create a voice marker',
  );

  // A rostered guest remains independently owned. Render through real Piper,
  // pause after the WAV exists, change the host, then allow the ordinary say
  // handoff to reach Liquidsoap.
  await changeHost(hostA().id, [guest().id]);
  const guestRendered = deferred<{ wavPath: string; size: number }>();
  const releaseGuest = deferred<void>();
  forcedDirectorAgent.run = async () => ({
    object: { text: 'Guest C keeps this scheduled microphone after the host edit.', sfx: null },
    steps: 1,
    toolCalls: [],
    extras: undefined,
  });
  (queue as any)._speak = async (...args: any[]) => {
    const wavPath = await realSpeak(...args);
    guestRendered.resolve({ wavPath, size: statSync(wavPath).size });
    await releaseGuest.promise;
    return wavPath;
  };
  const guestVoiceStart = monitor.count('voice-playing.json');
  const guestRun = runCapability(skillKind, context(), {
    persona: guest(),
    automaticHostSpeech: true,
    pauseTalkEligible: false,
  });
  const guestWav = await guestRendered.promise;
  assert(guestWav.size > 4_096);
  const b5 = await changeHost(hostB().id, [guest().id]);
  assert.equal(b5?.revision, 5);
  releaseGuest.resolve();
  const guestResult = await guestRun;
  assert.equal(guestResult.queued, true);
  const guestMarker = await waitFor(() => {
    const events = monitor.since('voice-playing.json', guestVoiceStart);
    return events.find(event => event.value?.channel === 'say')?.value ?? null;
  }, 'guest voice live-edge marker');

  // Co-host speech is intentionally unstamped too. Hold the first real Piper
  // render, flip B -> A, then require both lines to cross say.txt and produce
  // distinct live-edge markers in order.
  const firstCohostRendered = deferred<{ wavPath: string; size: number }>();
  const releaseCohost = deferred<void>();
  let cohostRenders = 0;
  (queue as any)._speak = async (...args: any[]) => {
    const wavPath = await realSpeak(...args);
    cohostRenders += 1;
    if (cohostRenders === 1) {
      firstCohostRendered.resolve({ wavPath, size: statSync(wavPath).size });
      await releaseCohost.promise;
    }
    return wavPath;
  };
  const cohostVoiceStart = monitor.count('voice-playing.json');
  const exchange = queue.announceExchange([
    { persona: hostB(), text: 'Host B begins the preserved co-host exchange.' },
    { persona: guest(), text: 'Guest C completes the preserved co-host exchange.' },
  ], skillKind);
  const cohostFirstWav = await firstCohostRendered.promise;
  assert(cohostFirstWav.size > 4_096);
  const a6 = await changeHost(hostA().id, [guest().id]);
  assert.equal(a6?.revision, 6);
  releaseCohost.resolve();
  assert.equal(await exchange, true);
  const cohostMarkers = await waitFor(() => {
    const markers = monitor.since('voice-playing.json', cohostVoiceStart)
      .map(event => event.value)
      .filter(value => value?.channel === 'say');
    return new Set(markers.map(value => value.voiceId)).size >= 2 ? markers : null;
  }, 'both co-host live-edge markers');

  // Fresh listener request under the current A/revision 6: actual HTTP route,
  // deterministic request-agent result, real Piper intro, real next.txt and
  // say.txt handoffs, real now-playing/voice markers.
  (queue as any)._speak = realSpeak;
  const freshTrack = {
    id: freshRequestId,
    title: 'Fresh Listener Request',
    artist: 'Synthetic',
    album: 'PR1675',
    duration: 12,
    path: 'request-fresh.wav',
  };
  requestAgent.run = async () => ({
    object: {
      kind: 'track',
      id: freshTrack.id,
      ack: 'The fresh request is queued.',
      intro: 'Host A introduces the fresh listener request.',
    },
    steps: 1,
    toolCalls: [],
    extras: { seen: new Map([[freshTrack.id, freshTrack]]) },
  });
  const nextStart = monitor.count('next.txt');
  const sayStart = monitor.count('say.txt');
  const freshVoiceStart = monitor.count('voice-playing.json');
  queue.senderBusy = true;
  const freshRequest = await request('198.51.100.20', 'play the fresh fixture', 'Bob');
  const freshQueued = await waitFor(() => {
    const item = queue.upcoming.find(entry => entry.track.id === freshRequestId);
    return item?.introHostSpeech?.revision === 6 ? item : null;
  }, 'fresh request queued with current host provenance');
  freshQueued.track.path = freshTrack.path;
  assert.equal(freshQueued.requestedBy, 'Bob');
  queue.senderBusy = false;
  void queue.drainToLiquidsoap();

  const freshMarker = await waitFor(() => {
    const marker = readJson(join(STATE_DIR, 'now-playing.json'));
    return marker?.subsonic_id === freshRequestId ? marker : null;
  }, 'fresh listener request at the mixer live edge', 75_000);
  const freshVoice = await waitFor(() => {
    const markers = monitor.since('voice-playing.json', freshVoiceStart)
      .map(event => event.value)
      .filter(value => value?.channel === 'say');
    return markers.at(-1) ?? null;
  }, 'fresh request intro live-edge marker');
  const freshNextHandoff = monitor.since('next.txt', nextStart)
    .find(event => String(event.value).includes(`subsonic_id="${freshRequestId}"`));
  const freshSayHandoff = monitor.since('say.txt', sayStart)
    .find(event => String(event.value).includes(`subwave_voice="${freshVoice.voiceId}"`));
  assert(freshNextHandoff, 'the real mixer next.txt handoff must be observed');
  assert(freshSayHandoff, 'the request intro say.txt handoff must carry the live marker voice id');

  const status = await nativeFetch(process.env.ICECAST_STATUS_URL!).then(response => response.json()) as any;
  const sources = Array.isArray(status?.icestats?.source)
    ? status.icestats.source
    : [status?.icestats?.source].filter(Boolean);
  const mp3 = sources.find((source: any) => String(source?.listenurl).includes('/stream.mp3'));
  assert(mp3, 'Icecast MP3 mount must be online');
  assert(Number(mp3.listeners) >= 1, 'the isolated Icecast stream must have a real listener');

  const report = {
    phase: 2,
    modelFixture: 'deterministic in-process Agent.run results; no real LLM/provider call',
    recoveredRequest: {
      nowPlaying: recoveredMarker,
      requestedBy: recoveredQueueItem.requestedBy,
      staleIntroVoiceMarkers,
    },
    guest: { afterHostChange: b5, wav: guestWav, result: guestResult, marker: guestMarker },
    cohost: {
      afterHostChange: a6,
      firstWav: cohostFirstWav,
      renders: cohostRenders,
      markers: cohostMarkers,
    },
    freshRequest: {
      request: freshRequest,
      requestedBy: freshQueued.requestedBy,
      hostRevision: freshQueued.introHostSpeech?.revision,
      nowPlaying: freshMarker,
      voiceMarker: freshVoice,
      nextHandoff: freshNextHandoff,
      sayHandoff: freshSayHandoff,
    },
    icecast: {
      listenurl: mp3.listenurl,
      listeners: Number(mp3.listeners),
      bitrate: Number(mp3.bitrate),
      audioInfo: mp3.audio_info,
    },
    events: monitor.events,
  };
  writeFileSync(join(STATE_DIR, 'pr1675-integration-phase2.json'), JSON.stringify(report, null, 2));
  console.log('PR1675_PHASE2_OK', JSON.stringify(report));
  monitor.stop();
  process.exit(0);
} catch (err) {
  directorAgent.run = realDirectorRun;
  forcedDirectorAgent.run = realForcedRun;
  requestAgent.run = realRequestRun;
  (queue as any)._speak = realSpeak;
  monitor.stop();
  console.error('PR1675_INTEGRATION_FAILED', err instanceof Error ? err.stack : err);
  writeFileSync(join(STATE_DIR, `pr1675-integration-phase${phase}-failed.txt`), String(err instanceof Error ? err.stack : err));
  process.exit(1);
}
