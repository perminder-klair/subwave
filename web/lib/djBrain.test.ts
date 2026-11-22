import assert from 'node:assert/strict';
import test from 'node:test';
import {
  brainVoiceWirable, djBrainSettingsPatch, isBrainRoute, isBrainVoice, isDjBrainUrl, sameBaseUrl, DJ_BRAIN_BASE_URL,
} from './djBrain';

test('a brain-only key wires the LLM and leaves the voice alone', () => {
  const p = djBrainSettingsPatch({ baseUrl: DJ_BRAIN_BASE_URL, token: 'k', voice: false, stationEngine: 'piper' });
  assert.deepEqual(p, { llm: { provider: 'openai-compatible', baseUrl: DJ_BRAIN_BASE_URL, model: 'dj-brain', apiKey: 'k' } });
});

test('a studio key wires the voice and takes the default piper engine', () => {
  const p = djBrainSettingsPatch({ baseUrl: DJ_BRAIN_BASE_URL, token: 'k', voice: true, stationEngine: 'piper' });
  assert.equal(p.tts?.defaultEngine, 'cloud');
  assert.deepEqual(p.tts?.cloud, {
    enabled: true, provider: 'openai-compatible', baseUrl: DJ_BRAIN_BASE_URL,
    model: 'dj-brain-voice', voice: '', sendSpeed: true, compatApiKey: 'k',
  });
  // The legacy slot loses to a stale compat key, so the voice never writes it.
  assert.equal('apiKey' in (p.tts?.cloud ?? {}), false);
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
  assert.equal(p.tts && 'compatApiKey' in p.tts.cloud, false);
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

test('the brain route is read from what is routed, not from a key on file', () => {
  assert.equal(isBrainRoute({ provider: 'openai-compatible', baseUrl: `${DJ_BRAIN_BASE_URL}/`, model: 'anything' }), true);
  // A brain run elsewhere still serves the brain's model id.
  assert.equal(isBrainRoute({ provider: 'openai-compatible', baseUrl: 'http://10.0.0.5:8787/v1', model: 'dj-brain' }), true);
  assert.equal(isBrainRoute({ provider: 'openai-compatible', baseUrl: 'http://10.0.0.5:8080/v1', model: 'qwen3' }), false);
  assert.equal(isBrainRoute({ provider: 'openai-compatible', baseUrl: '', model: 'dj-brain' }), false);
  // The compat URL is still the brain's, but the station moved to Ollama.
  assert.equal(isBrainRoute({ provider: 'ollama', baseUrl: DJ_BRAIN_BASE_URL, model: 'dj-brain' }), false);
});

test('the cloud voice is the brain\'s only at the brain\'s URL', () => {
  assert.equal(isBrainVoice({ provider: 'openai-compatible', baseUrl: `${DJ_BRAIN_BASE_URL}/` }, DJ_BRAIN_BASE_URL), true);
  assert.equal(isBrainVoice({ provider: 'openai-compatible', baseUrl: 'http://10.0.0.5:5000/v1' }, DJ_BRAIN_BASE_URL), false);
  assert.equal(isBrainVoice({ provider: 'openai', baseUrl: DJ_BRAIN_BASE_URL }, DJ_BRAIN_BASE_URL), false);
});

test('the voice is wired only when its key slot can be filled', () => {
  const base = { planHasVoice: true, token: '', brainVoiceKeyOnFile: false };
  // A key on file for another voice server (OpenAI, a local compat TTS) is
  // not the brain's, so a blank Save wires nothing.
  assert.equal(brainVoiceWirable(base), false);
  assert.equal(brainVoiceWirable({ ...base, token: ' k ' }), true);
  assert.equal(brainVoiceWirable({ ...base, brainVoiceKeyOnFile: true }), true);
  assert.equal(brainVoiceWirable({ ...base, planHasVoice: false, token: 'k', brainVoiceKeyOnFile: true }), false);
});
