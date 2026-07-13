// Unit tests for the pure clock helpers in time.ts — the shapes the DJ prompt
// layer shows the model (issue: DJs saying "thirteen oh five" with the station
// set to AM/PM, and the hourly check announcing "one in the morning" at 00:03).
// Run: `npm test -- clock-phrase` (tsx scripts/clock-phrase.test.ts).

import assert from 'node:assert/strict';
import { clockDisplay, spokenHourPhrase } from '../src/time.js';

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

  if (failures) {
    console.error(`\n${failures} failing`);
    process.exit(1);
  }
  console.log('\nall clock-phrase pins pass');
}

main();
