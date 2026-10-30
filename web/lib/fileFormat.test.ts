// the Dash line for the playing file's own format, from the fields the
// controller's GET /now-playing/file projects off Navidrome's song record.
// Unknown parts are left out, never rendered as 0.
//
// Run: npm test -- fileFormat

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatFileFormat } from './fileFormat';

test('a CD-quality FLAC', () => {
  assert.equal(
    formatFileFormat({ suffix: 'flac', samplingRate: 44100, bitDepth: 16, bitRate: 979, channelCount: 2 }),
    'FLAC · 44.1 kHz · 16-bit · 979 kbps',
  );
});

test('a lossy MP3 has no bit depth to show', () => {
  assert.equal(formatFileFormat({ suffix: 'mp3', samplingRate: 44100, bitRate: 192 }), 'MP3 · 44.1 kHz · 192 kbps');
});

test('whole-kHz rates drop the decimal; thousands get a separator', () => {
  assert.equal(formatFileFormat({ suffix: 'wav', samplingRate: 48000, bitDepth: 24, bitRate: 2304 }), 'WAV · 48 kHz · 24-bit · 2,304 kbps');
  assert.equal(formatFileFormat({ suffix: 'flac', samplingRate: 88200, bitDepth: 24 }), 'FLAC · 88.2 kHz · 24-bit');
  assert.equal(formatFileFormat({ suffix: 'flac', samplingRate: 192000, bitDepth: 24 }), 'FLAC · 192 kHz · 24-bit');
});

// A 1-bit file at a multiple of 44.1 kHz is DSD: name the multiple, not the
// bit depth or a bit rate that reads as a typo.
test('DSD reads as DSD64/128/256 with its MHz rate', () => {
  assert.equal(formatFileFormat({ suffix: 'dsf', samplingRate: 5644800, bitDepth: 1, bitRate: 11290 }), 'DSF · DSD128 · 5.6 MHz');
  assert.equal(formatFileFormat({ suffix: 'dff', samplingRate: 2822400, bitDepth: 1 }), 'DFF · DSD64 · 2.8 MHz');
  assert.equal(formatFileFormat({ suffix: 'dsf', samplingRate: 11289600, bitDepth: 1 }), 'DSF · DSD256 · 11.3 MHz');
});

test('48 kHz-family DSD is named the same way, its MHz telling the family apart', () => {
  assert.equal(formatFileFormat({ suffix: 'dsf', samplingRate: 3072000, bitDepth: 1, bitRate: 6144 }), 'DSF · DSD64 · 3.1 MHz');
  assert.equal(formatFileFormat({ suffix: 'dsf', samplingRate: 6144000, bitDepth: 1 }), 'DSF · DSD128 · 6.1 MHz');
});

test('mono and multichannel are named; stereo is the silent default', () => {
  assert.equal(formatFileFormat({ suffix: 'flac', samplingRate: 44100, bitDepth: 16, channelCount: 1 }), 'FLAC · 44.1 kHz · 16-bit · mono');
  assert.equal(formatFileFormat({ suffix: 'flac', samplingRate: 48000, bitDepth: 24, channelCount: 6 }), 'FLAC · 48 kHz · 24-bit · 6 ch');
});

test('nothing known renders nothing', () => {
  assert.equal(formatFileFormat({}), null);
  assert.equal(formatFileFormat(null), null);
  assert.equal(formatFileFormat(undefined), null);
});

test('only a suffix still says something', () => {
  assert.equal(formatFileFormat({ suffix: 'm4a' }), 'M4A');
});
