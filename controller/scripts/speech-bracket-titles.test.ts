// Regression coverage for bracketed-title speech-cue sanitation.
// Unknown bracketed text can be a real title: it must remain readable in the
// booth log, while the speech form removes cue-shaped brackets but keeps words.
// Run: npm test -- speech-bracket-titles

import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeForDisplay, normalizeForSpeech } from '../src/audio/speech-text.js';

const terminal = 'That was Sigur Rós with [Untitled].';
const middle = 'From [Untitled], this is track two.';
const numbered = 'From [Track 2], this is the closing movement.';
const production = 'On this track [fade out] keep talking.';

test('display sanitation preserves a terminal bracketed title', () => {
  assert.equal(normalizeForDisplay(terminal), terminal);
});

test('speech sanitation preserves terminal bracketed-title words without a cue-shaped tag', () => {
  assert.equal(normalizeForSpeech(terminal), 'That was Sigur Rós with Untitled.');
});

test('display sanitation preserves a mid-sentence bracketed title', () => {
  assert.equal(normalizeForDisplay(middle), middle);
});

test('speech sanitation preserves mid-sentence bracketed-title words without a cue-shaped tag', () => {
  assert.equal(normalizeForSpeech(middle), 'From Untitled, this is track two.');
});

test('an explicit numbered title remains literal despite containing the word track', () => {
  assert.equal(normalizeForDisplay(numbered), numbered);
  assert.equal(normalizeForSpeech(numbered), 'From Track 2, this is the closing movement.');
});

test('title-like sentence context never rescues a known production action', () => {
  assert.equal(normalizeForDisplay(production), 'On this track keep talking.');
  assert.equal(normalizeForSpeech(production), 'On this track keep talking.');
});
