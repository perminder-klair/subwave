// Pins the on-demand jingle path — POST /jingles/:filename/play → queue.playJingle
// → next.txt → radio.liq's on_meta jingle branch.
//
// The feature exists because the only on-demand trigger the station had was
// /sfx/:name/play, and an effect is amplified to 0.7 and mixed UNDER the
// programme with a light duck — which is why SFX_MAX_SEC caps it at 10s. An
// event announcement needs the opposite: its own item in the music chain, at
// full level, with no cap. Two things carry that, and both are pinned here:
// the annotation queue.playJingle writes, and the ORDER of the branches in
// radio.liq's on_meta that read it.
//
// node:assert-via-tsx style, matching scripts/bed-policy.test.ts.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jingleUri } from '../src/broadcast/jingles.js';
import { bedUri } from '../src/broadcast/beds.js';
import { PLAY_JINGLE_WAIT_MS, PLAY_JINGLE_POLL_MS } from '../src/broadcast/queue/pure.js';

const here = dirname(fileURLToPath(import.meta.url));
const RADIO_LIQ = join(here, '..', '..', 'liquidsoap', 'radio.liq');

// ── the annotation ───────────────────────────────────────────────────────────

const URI = jingleUri('/var/sub-wave/jingles/jingle_a1b2c3d4.wav');

// The kind key is the whole contract with radio.liq — it is what the on_meta
// branch matches on, and the branch is what keeps an announcement out of
// now-playing.json.
assert.equal(URI, 'annotate:subwave_kind="jingle":/var/sub-wave/jingles/jingle_a1b2c3d4.wav');

// The path rides raw and LAST. Liquidsoap's annotate protocol splits on the
// final colon, so a jingle stored under a path with colons in it still resolves
// — but a quoted/escaped path would not.
assert.ok(URI.endsWith(':/var/sub-wave/jingles/jingle_a1b2c3d4.wav'));

// No cue_out and no cross override, which is the difference from a bed. A bed is
// deliberately cut to the length of the link it carries; an announcement plays
// in full. This is the assertion that fails if someone "unifies" the two URIs.
assert.ok(!URI.includes('liq_cue_out'), 'a jingle is never cut short');
assert.ok(!URI.includes('liq_cross_duration'), 'a jingle takes the station crossfade');
assert.ok(bedUri('/x.mp3', { bedSec: 30, crossSec: 6 }).includes('liq_cue_out'), 'a bed still is');

// Distinct kinds — the two branches in on_meta do opposite things with
// bed_on_air, so a shared value would latch the jingle rotate off.
assert.notEqual(
  URI.match(/subwave_kind="([^"]+)"/)?.[1],
  bedUri('/x.mp3', { bedSec: 30, crossSec: 6 }).match(/subwave_kind="([^"]+)"/)?.[1],
);

// ── the wait bound ───────────────────────────────────────────────────────────

// playJingle yields the sender mutex to an in-flight drain so it can't be
// slotted between a bed and the track it ramps into. The bound has to outlast a
// slow local TTS render inside that drain, or the guard is decorative.
assert.ok(PLAY_JINGLE_WAIT_MS >= 30_000, 'must outlast a slow drain, not just a fast one');
assert.ok(PLAY_JINGLE_POLL_MS > 0 && PLAY_JINGLE_POLL_MS < PLAY_JINGLE_WAIT_MS);

// ── the branch order in radio.liq ────────────────────────────────────────────

const liq = readFileSync(RADIO_LIQ, 'utf8');

const jingleBranch = liq.indexOf('elsif m["subwave_kind"] == "jingle" then');
const titleGate = liq.indexOf('elsif title != "" or artist != "" then');
const bedBranch = liq.indexOf('if m["subwave_kind"] == "bed" then');

assert.ok(bedBranch > 0, 'on_meta still has its bed branch');
assert.ok(jingleBranch > 0, 'on_meta has an on-demand jingle branch');
assert.ok(titleGate > 0, 'on_meta still has its title/artist gate');

// THE load-bearing assertion. A jingle imported on a host without ffmpeg keeps
// its original container and its ID3 tags, so a titled upload reaching the gate
// first would publish an event announcement as the now-playing track and push
// it onto the ICY stream. Same reason the bed branch sits where it does.
assert.ok(jingleBranch < titleGate, 'the jingle branch must precede the title gate');
assert.ok(bedBranch < jingleBranch, 'bed branch first, unchanged');

// The branch writes the marker the controller's #997 collision guard reads
// (waitForJingleClear), so a boundary-aired link can't talk over the clip. The
// rotate's own on_metadata writes the same file — there is exactly one.
const branchBody = liq.slice(jingleBranch, titleGate);
assert.ok(branchBody.includes('jingle-playing.json'), 'writes the collision-guard marker');
assert.ok(branchBody.includes('jingle_now_tmp_dir'), 'own temp dir — one per writer, #1240');
assert.ok(!branchBody.includes('temp_dir=jingle_tmp_dir'), 'never shares the rotate writer\'s staging dir');
assert.ok(branchBody.includes('bed_on_air := false'), 'clears the bed latch like the untitled branch');
assert.ok(!branchBody.includes('now-playing.json'), 'an announcement is not a song');
assert.ok(!branchBody.includes('insert_metadata'), 'and never touches the ICY title');

console.log('  ✓ on-demand jingle path (annotation, wait bound, on_meta branch order)');
