import assert from 'node:assert/strict';
import {
  AUDIO_FORMATS,
  availabilityFor,
  deriveSiblingMounts,
  effectiveFormat,
  loadFormatPreference,
  preferenceKey,
  saveFormatPreference,
  type AudioFormat,
} from '../lib/audioFormat.ts';

const enabled = { mp3: true, opus: true, aac: false, flac: true } as const;
const supported = { mp3: true, opus: false, aac: true, flac: true } as const;

assert.deepEqual(AUDIO_FORMATS.map(x => x.id), ['mp3', 'opus', 'aac', 'flac']);
assert.deepEqual(availabilityFor(enabled, supported), {
  mp3: { available: true, reason: null },
  opus: { available: false, reason: 'Not supported by this browser' },
  aac: { available: false, reason: 'Not enabled by this station' },
  flac: { available: true, reason: null },
});
assert.notEqual(preferenceKey('/api'), preferenceKey('https://other.example/api'));

const values = new Map<string, string>();
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => { values.set(key, value); },
};
const preference: AudioFormat = 'flac';
saveFormatPreference(storage, '/api', preference);
assert.equal(loadFormatPreference(storage, '/api'), 'flac');
values.set(preferenceKey('/api'), 'wav');
assert.equal(loadFormatPreference(storage, '/api'), null);

const available = availabilityFor(enabled, supported);
assert.equal(effectiveFormat('flac', available), 'flac');
assert.equal(effectiveFormat('opus', available), 'mp3');
assert.equal(effectiveFormat(null, available), 'mp3');

assert.deepEqual(deriveSiblingMounts('/stream.mp3'), {
  mp3: '/stream.mp3',
  opus: '/stream.opus',
  aac: '/stream.aac',
  flac: '/stream.flac',
});
assert.deepEqual(deriveSiblingMounts('https://custom.example/live'), {
  mp3: 'https://custom.example/live',
  opus: null,
  aac: null,
  flac: null,
});

console.log('audio-format: all assertions passed');
