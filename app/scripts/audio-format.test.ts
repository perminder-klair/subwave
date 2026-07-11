// @ts-nocheck -- Executed directly by Node with type stripping.
import assert from 'node:assert/strict';
import {
  FORMAT_OPTIONS, availabilityFor, resolveFormatPreference,
  streamPreferenceKey, streamUrlFor, type StreamUrls,
} from '../src/lib/audioFormat.ts';

const enabled = { mp3: true, opus: true, aac: true, flac: true } as const;
const urls: StreamUrls = {
  mp3: 'https://radio.test/stream.mp3',
  opus: 'https://radio.test/stream.opus',
  aac: 'https://radio.test/stream.aac',
  flac: 'https://radio.test/stream.flac',
};
assert.deepEqual(FORMAT_OPTIONS.map((f) => f.id), ['mp3', 'opus', 'aac', 'flac']);
for (const platform of ['ios', 'android'] as const) {
  const a = availabilityFor(platform, enabled, new Set());
  assert.equal(a.mp3.available, true);
  assert.equal(a.aac.available, true);
  assert.deepEqual(a.opus, { available: false, reason: 'device' });
  assert.deepEqual(a.flac, { available: false, reason: 'device' });
}
assert.equal(availabilityFor('ios', { ...enabled, aac: false }, new Set()).aac.reason, 'station');
assert.equal(availabilityFor('ios', enabled, new Set(['aac'])).aac.reason, 'failed');
assert.equal(resolveFormatPreference('aac', availabilityFor('ios', enabled, new Set())), 'aac');
assert.equal(resolveFormatPreference('opus', availabilityFor('ios', enabled, new Set())), 'mp3');
assert.equal(streamPreferenceKey('https://RADIO.test/'), 'subwave.audio-format.v1:https://radio.test');
const canonicalPreferenceKey = 'subwave.audio-format.v1:https://radio.test';
for (const base of [
  'radio.test',
  ' https://RADIO.test/ ',
  'https://radio.test/listen/path?source=app#player',
  'https://listener:secret@radio.test:443/private',
]) {
  assert.equal(streamPreferenceKey(base), canonicalPreferenceKey);
}
const credentialedKey = streamPreferenceKey('https://listener:secret@radio.test/private');
assert.equal(credentialedKey.includes('listener'), false);
assert.equal(credentialedKey.includes('secret'), false);
assert.equal(credentialedKey.includes('/private'), false);
assert.equal(streamUrlFor(urls, 'flac'), 'https://radio.test/stream.flac');
console.log('audio-format tests passed');
