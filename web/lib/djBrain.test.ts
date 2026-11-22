import assert from 'node:assert/strict';
import test from 'node:test';
import { djBrainSettingsPatch, isDjBrainUrl, sameBaseUrl, DJ_BRAIN_BASE_URL } from './djBrain';

test('a brain-only key wires the LLM and leaves the voice alone', () => {
  const p = djBrainSettingsPatch({ baseUrl: DJ_BRAIN_BASE_URL, token: 'k', voice: false, stationEngine: 'piper' });
  assert.deepEqual(p, { llm: { provider: 'openai-compatible', baseUrl: DJ_BRAIN_BASE_URL, model: 'dj-brain', apiKey: 'k' } });
});

test('a studio key wires the voice and takes the default piper engine', () => {
  const p = djBrainSettingsPatch({ baseUrl: DJ_BRAIN_BASE_URL, token: 'k', voice: true, stationEngine: 'piper' });
  assert.equal(p.tts?.defaultEngine, 'cloud');
  assert.deepEqual(p.tts?.cloud, {
    enabled: true, provider: 'openai-compatible', baseUrl: DJ_BRAIN_BASE_URL,
    model: 'dj-brain-voice', voice: '', sendSpeed: true, apiKey: 'k',
  });
});

test('a deliberate engine choice is never taken over', () => {
  const p = djBrainSettingsPatch({ baseUrl: DJ_BRAIN_BASE_URL, token: 'k', voice: true, stationEngine: 'kokoro' });
  assert.equal(p.tts && 'defaultEngine' in p.tts, false);
  assert.equal(p.tts?.cloud.enabled, true);
});

test('a blank token keeps the key on file', () => {
  const p = djBrainSettingsPatch({ baseUrl: DJ_BRAIN_BASE_URL, token: '  ', voice: true, stationEngine: 'cloud' });
  assert.equal('apiKey' in p.llm, false);
  assert.equal(p.tts && 'apiKey' in p.tts.cloud, false);
});

test('isDjBrainUrl ignores a trailing slash and whitespace', () => {
  assert.equal(isDjBrainUrl(' https://my.getsubwave.com/v1/ '), true);
  assert.equal(isDjBrainUrl('http://localhost:8080/v1'), false);
});

test('a brain-only key unwires a voice that was the brain\'s, back to piper', () => {
  const p = djBrainSettingsPatch({ baseUrl: DJ_BRAIN_BASE_URL, token: '', voice: false, stationEngine: 'cloud', voiceWiredToBrain: true });
  assert.deepEqual(p.tts, { defaultEngine: 'piper', cloud: { enabled: false } });
  const kept = djBrainSettingsPatch({ baseUrl: DJ_BRAIN_BASE_URL, token: '', voice: false, stationEngine: 'kokoro', voiceWiredToBrain: true });
  assert.deepEqual(kept.tts, { cloud: { enabled: false } });
});

test('sameBaseUrl matches any brain URL, never two blanks', () => {
  assert.equal(sameBaseUrl('http://brain.lan:8080/v1/', 'http://brain.lan:8080/v1'), true);
  assert.equal(sameBaseUrl('', ''), false);
  assert.equal(sameBaseUrl('http://a/v1', 'http://b/v1'), false);
});
