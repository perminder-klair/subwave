// Regression test for the request-intro AIR-TIME framing clause.
// Run: `npm test -- request-intro-airtime` (tsx scripts/request-intro-airtime.test.ts).
//
// A request intro is WRITTEN when the request resolves but AIRED from
// onTrackStarted — it plays over the opening seconds of the track it
// introduces (queue.airIntro, deferred by #189). Requests also append to the
// END of `upcoming`, so an already-queued track can air in between.
//
// Two staleness modes follow. shouldDropStaleLink (scripts/stale-link.test.ts)
// only ever catches a wrongly NAMED predecessor, and it is disabled for request
// intros anyway (they carry no linkPrev). So the tense/moment staleness has to
// be PREVENTED in the prompt — which makes AIR_TIME_CLAUSE the only thing
// standing between the model and copy like "what comes through the speakers
// next" (a real logged intro: correct when written, wrong on air).
//
// These asserts pin the clause's load-bearing content so a future prompt edit
// can't quietly drop it. They deliberately do NOT assert exact wording — only
// the properties that must survive a rewrite.

import assert from 'node:assert/strict';
import { AIR_TIME_CLAUSE } from '../src/llm/internal/prompts/scripts.js';

let failures = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    failures++;
    console.error(`  ✗ ${name}\n      ${err?.message || err}`);
  }
}

function main() {
  console.log('request-intro air-time clause (AIR_TIME_CLAUSE):');

  test('states that the line airs over the track, not before it', () => {
    assert.match(AIR_TIME_CLAUSE, /airs over the opening/i);
    assert.match(AIR_TIME_CLAUSE, /not in the gap before it/i);
  });

  test('forbids future framing — the #1 observed failure ("next")', () => {
    assert.match(AIR_TIME_CLAUSE, /never as something still to come/i);
  });

  test('warns that time and another track may pass before it airs', () => {
    assert.match(AIR_TIME_CLAUSE, /minutes and another song may pass/i);
  });

  test('forbids anchoring to the moment (mood staleness, not just names)', () => {
    // The queue-side guard can only catch a NAMED wrong predecessor, so a line
    // like "we're leaning into low light now" — stale but naming nobody — has
    // to be prevented here or not at all.
    assert.match(AIR_TIME_CLAUSE, /on air at this instant|how the room feels/i);
  });

  test('offers NO example opening phrasings', () => {
    // Regression pin: an earlier draft listed present-tense openers ("this
    // is…", "that's us into…") and a live run put the SAME opener on three
    // consecutive request intros — the model reads a menu as a template. The
    // station's opener variety comes from ANGLES + the recent-opener
    // blocklist; this clause must not compete with them.
    const seeded = /"[^"]*(this is|that's|here it comes|here's)[^"]*"/i;
    assert.equal(seeded.test(AIR_TIME_CLAUSE), false,
      'clause must not quote example openers — it flattens every intro to the same shape');
  });

  test('is additive — a leading space so it appends cleanly to a prompt', () => {
    assert.equal(AIR_TIME_CLAUSE.startsWith(' '), true);
    assert.equal(AIR_TIME_CLAUSE.trim().length > 0, true);
  });

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed`);
    process.exit(1);
  }
  console.log('\nall request-intro air-time tests passed');
  process.exit(0);
}

main();
