import assert from 'node:assert/strict';
import {
  AUDIO_MIME_TYPES,
  AUDIO_FORMATS,
  availabilityFor,
  browserSupportFor,
  currentPlaybackTarget,
  deriveSiblingMounts,
  effectiveFormat,
  loadFormatPreference,
  preferenceKey,
  resolveFormatPreference,
  saveFormatPreference,
  type AudioFormat,
} from '../lib/audioFormat.ts';

const codecs = { mp3: 'probably', opus: 'probably', aac: 'maybe', flac: '' } as const;
assert.deepEqual(browserSupportFor(codecs, { ios: false, firefox: false }), {
  mp3: true, opus: true, aac: true, flac: false,
});
assert.equal(browserSupportFor(codecs, { ios: true, firefox: false }).opus, false);
assert.equal(browserSupportFor(codecs, { ios: false, firefox: true }).opus, false);
assert.deepEqual(
  browserSupportFor({ ...codecs, flac: 'probably' }, { ios: false, firefox: false, safari: true }),
  { mp3: true, opus: false, aac: true, flac: false },
);
assert.equal(AUDIO_MIME_TYPES.flac, 'audio/ogg; codecs=flac');

const enabled = { mp3: true, opus: true, aac: false, flac: true } as const;
const supported = { mp3: true, opus: false, aac: true, flac: true } as const;

assert.deepEqual(AUDIO_FORMATS.map(x => x.id), ['mp3', 'opus', 'aac', 'flac']);
assert.deepEqual(availabilityFor(enabled, supported), {
  mp3: { available: true, reason: null },
  opus: { available: false, reason: 'Not supported by this browser' },
  aac: { available: false, reason: 'Not enabled by this station' },
  flac: { available: true, reason: null },
});
assert.deepEqual(availabilityFor(enabled, supported, new Set<AudioFormat>(['flac'])).flac, {
  available: false,
  reason: 'Stream failed; using MP3',
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

const allEnabled = { mp3: true, opus: true, aac: true, flac: true } as const;
const allSupported = { mp3: true, opus: true, aac: true, flac: true } as const;
const streams = {
  mp3: '/stream.mp3',
  opus: '/stream.opus',
  aac: '/stream.aac',
  flac: '/stream.flac',
} as const;
assert.deepEqual(resolveFormatPreference('flac', allEnabled, allSupported, streams), {
  format: 'flac',
  streamUrl: '/stream.flac',
});
assert.deepEqual(resolveFormatPreference('aac', allEnabled, allSupported, {
  ...streams,
  aac: null,
}), {
  format: 'mp3',
  streamUrl: '/stream.mp3',
});
assert.deepEqual(resolveFormatPreference('opus', allEnabled, allSupported, streams, new Set<AudioFormat>(['opus'])), {
  format: 'mp3',
  streamUrl: '/stream.mp3',
});
assert.deepEqual(resolveFormatPreference('flac', { ...allEnabled, flac: false }, allSupported, streams), {
  format: 'mp3',
  streamUrl: '/stream.mp3',
});
assert.deepEqual(resolveFormatPreference('flac', allEnabled, { ...allSupported, flac: false }, streams), {
  format: 'mp3',
  streamUrl: '/stream.mp3',
});
assert.deepEqual(resolveFormatPreference(null, allEnabled, allSupported, streams), {
  format: 'mp3',
  streamUrl: '/stream.mp3',
});

// Restoration can update refs before React rerenders. The first tune must use
// those authoritative values rather than the render-captured defaults.
const streamUrlRef = { current: '/stream.mp3' };
const volumeRef = { current: 1 };
const renderSnapshot = { streamUrl: streamUrlRef.current, volume: volumeRef.current };
streamUrlRef.current = '/stream.aac';
volumeRef.current = 0.35;
assert.deepEqual(currentPlaybackTarget(streamUrlRef, volumeRef), {
  streamUrl: '/stream.aac',
  volume: 0.35,
});
assert.deepEqual(renderSnapshot, { streamUrl: '/stream.mp3', volume: 1 });

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
