// Offline regression checks for the mixer lifecycle. Execute its scalar safety
// predicates and pin their audio/command wiring; this does not replace a real
// Liquidsoap render (the executable is not available in every contributor env).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const liq = readFileSync(new URL('../../liquidsoap/radio.liq', import.meta.url), 'utf8');
function body(name: string): string {
  const match = liq.match(new RegExp(`^def ${name}\\([^\\n]*\\) =\\n([\\s\\S]*?)^end$`, 'm'));
  assert.ok(match, `missing mixer function ${name}`);
  return match[1];
}
function predicate(name: string, scope: Record<string, unknown>): (...args: string[]) => boolean {
  const expr = body(name).replace(/^\s*#.*$/gm, '')
    .replace(/"([^"\n]*#\{[^"\n]*)"/g, (_, s: string) => '`' + s.replace(/#\{/g, '${') + '`')
    .replace(/\band\b/g, '&&').replace(/\bnot\b/g, '!');
  return new Function(...Object.keys(scope), `return (epoch, song_stamp) => (${expr});`)(...Object.values(scope));
}

test('an accepted lead-in/ID stays cancelled after idle/off-air even when wall-clock holds expire', () => {
  let epoch = 1;
  let song = 100;
  let safe = true;
  const valid = predicate('jingle_overlay_valid', {
    jingle_overlay_epoch: () => epoch,
    overlay_music_timestamp: () => song,
    jingle_overlay_live_safe: () => safe,
  });
  assert.equal(valid('1', '100'), true);
  // Check the production cancellation generation change. There is no
  // wall-clock input: expiry of voice_until cannot resurrect this offer.
  const cancellation = body('cancel_jingle_overlay');
  assert.match(cancellation, /jingle_overlay_epoch := jingle_overlay_epoch\(\) \+ 1/);
  epoch++;
  assert.equal(valid('1', '100'), false, 'same-song resume must not restart a cancelled ID');
  assert.equal(valid('2', '100'), true, 'a fresh offer has its own generation');
  song++;
  assert.equal(valid('2', '100'), false, 'a different song cannot inherit an accepted ID');
  song--;
  safe = false;
  assert.equal(valid('2', '100'), false, 'speech queued during the pause vetoes playback');

  for (const command of ['idle_on', 'idle_off', 'stream_off', 'stream_on']) {
    const commandBody = liq.slice(liq.indexOf(`  "${command}",`)).split('\n)')[0];
    assert.match(commandBody, /cancel_jingle_overlay\(\)/, `${command} invalidates before changing playback`);
    const gateChange = command === 'idle_on' ? 'idle_mode := true' : command === 'idle_off' ? 'idle_mode := false'
      : command === 'stream_off' ? 'stream_down()' : 'stream_up()';
    assert.ok(commandBody.indexOf('cancel_jingle_overlay()') < commandBody.indexOf(gateChange));
  }
});

test('both intro requests carry cancellation identity and cancelled audio is muted before mic processing', () => {
  const poll = body('poll_intro');
  assert.match(poll, /subwave_overlay_epoch/);
  assert.match(poll, /leadin = .*subwave_jingle_overlay/);
  assert.match(poll, /intro_queue.push\(request.create\(leadin\)\)/);
  assert.match(liq, /intro_queue.on_metadata\(synchronous=true, fun\(m\) -> intro_overlay_metadata := m\)/);
  assert.match(body('intro_overlay_gain'), /jingle_overlay_valid/);
  assert.match(body('intro_overlay_gain'), /cancel_jingle_overlay\(\)/, 'an unsafe frame permanently cancels its whole offer');
  assert.match(liq, /edge_fade\(amplify\(override=null, intro_overlay_gain, intro_queue\)\)/);
  assert.match(body('intro_overlay_gain'), /intro_queue.skip\(\)\s*intro_overlay_metadata := \[\]/);
  assert.match(body('voice_marker'), /jingle_overlay_valid\(m\["subwave_overlay_epoch"\], m\["subwave_overlay_track_at"\]\)/,
    'discarded ID never earns an actual-start marker');
});


function mixerScope(gates: Record<string, boolean>) {
  return {
    stream_on: () => !gates.offAir, idle_mode: () => !!gates.idle,
    music_starved: () => !!gates.starved, music_meta: 'music',
    bed_on_air: () => !!gates.bed, pause_talk_on_air: () => !!gates.pauseTalk,
    jingle_now_on_air: () => !!gates.manualJingle,
    source: { is_ready: () => !gates.unready, remaining: (q: { remaining: () => number }) => q.remaining() },
    voice_queue: { queue: () => gates.voiceQueued ? ['voice'] : [], remaining: () => gates.voicePlaying ? 10 : 0 },
    intro_queue: { queue: () => gates.introQueued ? ['intro'] : [], remaining: () => gates.introPlaying ? 10 : 0 },
    jingle_now_queue: { queue: () => gates.jingleQueued ? ['jingle'] : [] },
    list: { length: (items: unknown[]) => items.length }, state_dir: '/fixture',
    file: { exists: (path: string) => !!gates[path.split('/').pop()!] },
    time: () => 100, voice_until: () => gates.voiceDeadline ? 200 : 0,
  };
}
const AIRING = ['offAir', 'idle', 'starved', 'unready', 'bed', 'pauseTalk', 'voicePlaying', 'voiceQueued'];
const BOUNDARY_ONLY = ['manualJingle', 'jingleQueued', 'say.txt', 'intro.txt', 'jingle-now.txt'];

test('live overlay safety rechecks paused music and competing voice every frame, with no file I/O', () => {
  const gates: Record<string, boolean> = {};
  const live = predicate('jingle_overlay_live_safe', mixerScope(gates));
  assert.equal(live(), true);
  for (const key of AIRING) {
    gates[key] = true;
    assert.equal(live(), false, key);
    gates[key] = false;
  }
  // A press waits for a track boundary and for this ID's voice_until, so it can
  // never meet the ID mid-clip: cutting the ID for it would only lose the ID.
  for (const key of BOUNDARY_ONLY) {
    gates[key] = true;
    assert.equal(live(), true, `${key} must not cut an ID already playing`);
    gates[key] = false;
  }
  // The per-frame gate runs on Liquidsoap's single streaming thread.
  assert.doesNotMatch(body('jingle_overlay_live_safe'), /file\.|jingle_now/);
  assert.match(body('intro_overlay_gain'), /jingle_overlay_valid/);
  assert.match(body('jingle_overlay_valid'), /jingle_overlay_live_safe\(\)/);
});

test('the offer gate checks presses, handoff files and both voice queues once, when the ID is consumed', () => {
  const gates: Record<string, boolean> = {};
  const offer = predicate('jingle_overlay_safe', { ...mixerScope(gates),
    jingle_overlay_live_safe: predicate('jingle_overlay_live_safe', mixerScope(gates)) });
  assert.equal(offer(), true);
  for (const key of [...AIRING, ...BOUNDARY_ONLY, 'voiceDeadline', 'introQueued', 'introPlaying']) {
    gates[key] = true;
    assert.equal(offer(), false, key);
    gates[key] = false;
  }
  assert.match(body('poll_intro'), /jingle_overlay_safe\(\)/);
});

test('the overlay marker carries the measured length, 0. when unmeasured, never the voice gate fallback', () => {
  const marker = body('voice_marker');
  assert.match(marker, /durationSec = jingle_duration\(fname\)/);
  assert.doesNotMatch(marker, /durationSec = dur\b/);
  assert.match(body('jingle_duration'), /null\.get\(default=0\./);
});
