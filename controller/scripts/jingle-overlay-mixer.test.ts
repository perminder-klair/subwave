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
    jingle_overlay_environment_safe: () => safe,
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
  assert.match(liq, /edge_fade\(amplify\(intro_overlay_gain, intro_queue\)\)/);
  assert.match(body('intro_overlay_gain'), /intro_queue.skip\(\)/);
  assert.match(body('voice_marker'), /jingle_overlay_valid\(m\["subwave_overlay_epoch"\], m\["subwave_overlay_track_at"\]\)/,
    'discarded ID never earns an actual-start marker');
});


test('live overlay safety rechecks paused music and every competing voice path', () => {
  const gates: Record<string, boolean> = {};
  const safe = predicate('jingle_overlay_environment_safe', {
    stream_on: () => !gates.offAir, idle_mode: () => !!gates.idle,
    music_starved: () => !!gates.starved, music_meta: 'music',
    bed_on_air: () => !!gates.bed, pause_talk_on_air: () => !!gates.pauseTalk,
    jingle_now_on_air: () => !!gates.manualJingle,
    source: { is_ready: () => !gates.unready, remaining: () => gates.voicePlaying ? 10 : 0 },
    voice_queue: { queue: () => gates.voiceQueued ? ['voice'] : [] },
    jingle_now_queue: { queue: () => gates.jingleQueued ? ['jingle'] : [] },
    list: { length: (items: unknown[]) => items.length }, state_dir: '/fixture',
    file: { exists: (path: string) => !!gates[path.split('/').pop()!] },
  });
  assert.equal(safe(), true);
  for (const key of ['offAir', 'idle', 'starved', 'unready', 'bed', 'pauseTalk', 'manualJingle',
    'voicePlaying', 'voiceQueued', 'jingleQueued', 'say.txt', 'intro.txt', 'jingle-now.txt']) {
    gates[key] = true;
    assert.equal(safe(), false, key);
    gates[key] = false;
  }
});
