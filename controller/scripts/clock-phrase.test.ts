// Unit tests for the pure clock helpers in time.ts — the shapes the DJ prompt
// layer shows the model (issue: DJs saying "thirteen oh five" with the station
// set to AM/PM, and the hourly check announcing "one in the morning" at 00:03).
// Run: `npm test -- clock-phrase` (tsx scripts/clock-phrase.test.ts).

import assert from 'node:assert/strict';
import { clockDisplay, spokenHourPhrase, spokenTimePhrase, spokenTimePhrases, spokenDaypartPhrase } from '../src/time.js';

// One minute inside each band, plus both edges of each band.
const BAND_MINUTES = [0, 4, 5, 14, 15, 24, 25, 39, 40, 49, 50, 59];

let failures = 0;
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((err) => { failures++; console.error(`  ✗ ${name}\n      ${err?.message || err}`); });
}

async function main() {
  console.log('clockDisplay 24h (en-GB default):');
  await test('afternoon stays 24-hour', () => {
    assert.equal(clockDisplay(13, 5, false), '13:05');
  });
  await test('midnight is 00:xx, zero-padded', () => {
    assert.equal(clockDisplay(0, 3, false), '00:03');
  });

  console.log('clockDisplay 12h (en-US / AM/PM):');
  await test('the reported case — 13:05 renders as 1:05 pm', () => {
    assert.equal(clockDisplay(13, 5, true), '1:05 pm');
  });
  await test('midnight is 12:xx am, never 0', () => {
    assert.equal(clockDisplay(0, 3, true), '12:03 am');
  });
  await test('noon is 12:xx pm', () => {
    assert.equal(clockDisplay(12, 0, true), '12:00 pm');
  });
  await test('morning hours are am', () => {
    assert.equal(clockDisplay(9, 30, true), '9:30 am');
  });
  await test('11pm is 11:xx pm', () => {
    assert.equal(clockDisplay(23, 59, true), '11:59 pm');
  });

  console.log('spokenHourPhrase:');
  await test('the reported case — hour 0 is midnight, not one in the morning', () => {
    assert.equal(spokenHourPhrase(0), 'midnight');
  });
  await test('hour 12 is noon', () => {
    assert.equal(spokenHourPhrase(12), 'noon');
  });
  await test('1am is one in the morning', () => {
    assert.equal(spokenHourPhrase(1), 'one in the morning');
  });
  await test('11am is eleven in the morning', () => {
    assert.equal(spokenHourPhrase(11), 'eleven in the morning');
  });
  await test('13 is one in the afternoon', () => {
    assert.equal(spokenHourPhrase(13), 'one in the afternoon');
  });
  await test('17 is five in the afternoon', () => {
    assert.equal(spokenHourPhrase(17), 'five in the afternoon');
  });
  await test('18 is six in the evening', () => {
    assert.equal(spokenHourPhrase(18), 'six in the evening');
  });
  await test('21 is nine in the evening', () => {
    assert.equal(spokenHourPhrase(21), 'nine in the evening');
  });
  await test('22 is ten at night', () => {
    assert.equal(spokenHourPhrase(22), 'ten at night');
  });
  await test('23 is eleven at night', () => {
    assert.equal(spokenHourPhrase(23), 'eleven at night');
  });
  await test('out-of-range hours normalise instead of crashing', () => {
    assert.equal(spokenHourPhrase(24), 'midnight');
    assert.equal(spokenHourPhrase(-1), 'eleven at night');
  });

  console.log('spokenTimePhrase (#1282 — minute-aware, coarse radio buckets):');
  await test('top of the hour is still "just gone"', () => {
    assert.equal(spokenTimePhrase(18, 0), 'just gone six in the evening');
    assert.equal(spokenTimePhrase(18, 4), 'just gone six in the evening');
  });
  await test('the reported case — 18:31 is no longer "just gone six"', () => {
    assert.equal(spokenTimePhrase(18, 31), 'half past six in the evening');
  });
  await test('early minutes are "just after"', () => {
    assert.equal(spokenTimePhrase(9, 8), 'just after nine in the morning');
  });
  await test('quarter past around :15-:24', () => {
    assert.equal(spokenTimePhrase(14, 17), 'quarter past two in the afternoon');
  });
  await test('past :40 leans on the next hour', () => {
    assert.equal(spokenTimePhrase(18, 45), 'quarter to seven in the evening');
    assert.equal(spokenTimePhrase(18, 55), 'coming up on seven in the evening');
  });
  await test('day edges — next-hour phrases normalise across midnight/noon', () => {
    assert.equal(spokenTimePhrase(23, 50), 'coming up on midnight');
    assert.equal(spokenTimePhrase(11, 45), 'quarter to noon');
    assert.equal(spokenTimePhrase(0, 20), 'quarter past midnight');
  });

  console.log('spokenTimePhrases (#1602 — one rounded time, several wordings):');
  await test('the canonical wording is still the first form of its band', () => {
    for (let h = 0; h < 24; h++) {
      for (let m = 0; m < 60; m++) {
        assert.equal(spokenTimePhrases(h, m)[0], spokenTimePhrase(h, m), `${h}:${m}`);
      }
    }
  });
  // Three is the floor, not two: with the no-repeat picker a two-form band
  // alternates deterministically, which is a different fixed pattern rather
  // than variation. Dropping a form that overclaims its band's first minute is
  // right, but it has to be replaced, not just removed.
  await test('every band offers at least three distinct wordings', () => {
    for (const m of BAND_MINUTES) {
      const forms = spokenTimePhrases(18, m);
      assert.ok(forms.length >= 3, `minute ${m} has ${forms.length} form(s)`);
      assert.equal(new Set(forms).size, forms.length, `minute ${m} repeats a form`);
    }
  });
  // The load-bearing pin: a wording may change the words, never the reading.
  // Every form in a band must carry the hour spokenHourPhrase chose for that
  // band — the one past :40 leans on the NEXT hour — and no other hour word.
  await test('every wording in a band names the same hour as the canonical one', () => {
    for (let h = 0; h < 24; h++) {
      for (let m = 0; m < 60; m++) {
        const expected = spokenHourPhrase(m <= 39 ? h : h + 1);
        for (const form of spokenTimePhrases(h, m)) {
          assert.ok(form.includes(expected), `${h}:${m} — "${form}" does not say "${expected}"`);
          for (let other = 0; other < 24; other++) {
            const otherPhrase = spokenHourPhrase(other);
            if (otherPhrase === expected) continue;
            // \b so "noon" doesn't match inside "afternoon".
            assert.ok(!new RegExp(`\\b${otherPhrase}\\b`).test(form),
              `${h}:${m} — "${form}" also says "${otherPhrase}"`);
          }
        }
      }
    }
  });
  // A SNAPSHOT, not a proof: it pins the lists so adding or changing a wording
  // shows up as a deliberate diff. The equivalence rule itself — every form
  // interchangeable at every minute in its band, including the minute the band
  // opens on — is not mechanically checkable and stays a human check at review
  // time; the only half that IS machine-checked is the hour word, by the test
  // above. The two refusals the table spells out (no "a minute or so past" in
  // a band that opens at :00, no "gone quarter past" in one that opens at :15,
  // no "gone half past" in one that opens at :25) are what that human check
  // looks like when it is done properly.
  await test('the wordings are pinned per band — changing one must be a deliberate diff', () => {
    assert.deepEqual(spokenTimePhrases(18, 2), [
      'just gone six in the evening',
      'just past six in the evening',
      'just turned six in the evening',
    ]);
    assert.deepEqual(spokenTimePhrases(9, 8), [
      'just after nine in the morning',
      'a few minutes past nine in the morning',
      'a little after nine in the morning',
    ]);
    // Nothing here may say "gone quarter past": the band opens ON :15.
    assert.deepEqual(spokenTimePhrases(14, 17), [
      'quarter past two in the afternoon',
      'a quarter past two in the afternoon',
      'around quarter past two in the afternoon',
    ]);
    // Nothing here may say "gone half past": the band opens at :25.
    assert.deepEqual(spokenTimePhrases(18, 31), [
      'half past six in the evening',
      'around half past six in the evening',
      'half past six in the evening, give or take',
    ]);
    assert.deepEqual(spokenTimePhrases(18, 45), [
      'quarter to seven in the evening',
      'a quarter to seven in the evening',
      'around quarter to seven in the evening',
    ]);
    assert.deepEqual(spokenTimePhrases(18, 55), [
      'coming up on seven in the evening',
      'coming up to seven in the evening',
      'nearly seven in the evening',
      'almost seven in the evening',
    ]);
  });
  await test('the day edge normalises in every wording, not just the canonical one', () => {
    for (const form of spokenTimePhrases(23, 50)) {
      assert.ok(form.includes('midnight'), form);
      assert.ok(!/twenty-four|\btwelve\b/.test(form), form);
    }
    for (const form of spokenTimePhrases(11, 45)) assert.ok(form.includes('noon'), form);
    for (const form of spokenTimePhrases(0, 20)) assert.ok(form.includes('midnight'), form);
  });
  await test('out-of-range hours and minutes normalise like the canonical phrase', () => {
    assert.deepEqual(spokenTimePhrases(24, 60), spokenTimePhrases(0, 0));
    assert.deepEqual(spokenTimePhrases(-1, -1), spokenTimePhrases(23, 59));
  });

  await test('daypart phrase — the only clock reading a station ident may speak', () => {
    assert.equal(spokenDaypartPhrase(0), 'in the morning', 'small hours follow "one in the morning"');
    assert.equal(spokenDaypartPhrase(5), 'in the morning');
    assert.equal(spokenDaypartPhrase(11), 'in the morning');
    assert.equal(spokenDaypartPhrase(12), 'in the afternoon');
    assert.equal(spokenDaypartPhrase(15), 'in the afternoon');
    assert.equal(spokenDaypartPhrase(18), 'in the evening');
    assert.equal(spokenDaypartPhrase(21), 'in the evening');
    assert.equal(spokenDaypartPhrase(22), 'at night');
    assert.equal(spokenDaypartPhrase(27), 'in the morning', 'normalises past the day edge like spokenHourPhrase');
  });
  await test('daypart phrase agrees with the suffix spokenHourPhrase speaks', () => {
    for (let h = 0; h < 24; h++) {
      if (h === 0 || h === 12) continue; // midnight / noon carry no daypart
      assert.ok(spokenHourPhrase(h).endsWith(spokenDaypartPhrase(h)), `hour ${h}`);
    }
  });

  if (failures) {
    console.error(`\n${failures} failing`);
    process.exit(1);
  }
  console.log('\nall clock-phrase pins pass');
}

main();
