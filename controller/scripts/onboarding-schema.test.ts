// schemas/onboarding.ts covers the two probe bodies and the rules the save
// handler used to hand-roll; the settings pass-through stays with
// settings.update(). Pins the strict/lenient pair — the probe REQUIRES the
// credentials, save must not, and both normalise identically.
import assert from 'node:assert/strict';
import test from 'node:test';

const {
  fishAudioIssue,
  llmProbeSchema,
  navidromeProbeSchema,
  normalizeNavidromeCredentials,
} = await import('../src/schemas/onboarding.js');


test('the probe requires all three credentials; save-side normalisation does not', () => {
  assert.equal(navidromeProbeSchema.safeParse({}).success, false);
  assert.equal(navidromeProbeSchema.safeParse({ url: 'http://n:4533', user: 'a' }).success, false);
  assert.equal(
    navidromeProbeSchema.safeParse({ url: 'http://n:4533', user: 'a', pass: 'p' }).success,
    true,
  );
  // Skipping Navidrome is supported: the shell posts empty strings.
  assert.deepEqual(normalizeNavidromeCredentials({ url: '', user: '', pass: '' }), {
    url: '', user: '', pass: '',
  });
});

test('probe and save agree on the normalisation, byte for byte', () => {
  // `${url}/rest/ping` against a stored `…:4533/` double-slashes and some
  // proxies 404 it, so the slash-strip has one home.
  const raw = { url: '  http://navi:4533//  ', user: '  admin ', pass: ' p ' };
  const probe = navidromeProbeSchema.parse(raw);
  const save = normalizeNavidromeCredentials(raw);
  assert.deepEqual(probe, save);
  assert.equal(save.url, 'http://navi:4533');
  assert.equal(save.user, 'admin');
  // The password is NOT trimmed — a leading/trailing space can be real.
  assert.equal(save.pass, ' p ');
});


test('provider and model are required', () => {
  assert.equal(llmProbeSchema.safeParse({}).success, false);
  assert.equal(llmProbeSchema.safeParse({ provider: 'ollama' }).success, false);
  assert.equal(llmProbeSchema.safeParse({ provider: 'ollama', model: 'llama3' }).success, true);
});

test('openai-compatible needs a baseUrl — in the schema, not a handler throw', () => {
  // As a schema rule this also holds the wizard's button shut, rather than
  // only throwing once Test is pressed.
  assert.equal(
    llmProbeSchema.safeParse({ provider: 'openai-compatible', model: 'm' }).success,
    false,
  );
  assert.equal(
    llmProbeSchema.safeParse({
      provider: 'openai-compatible', model: 'm', baseUrl: 'http://box:8080/v1',
    }).success,
    true,
  );
  // locca does not require one: the controller defaults to the host server.
  assert.equal(llmProbeSchema.safeParse({ provider: 'locca', model: 'm' }).success, true);
});


test('fishAudioIssue judges only an enabled fish-audio block', () => {
  assert.equal(fishAudioIssue(undefined), null);
  assert.equal(fishAudioIssue({ enabled: false, provider: 'fish-audio' }), null);
  assert.equal(fishAudioIssue({ enabled: true, provider: 'openai' }), null);
});

test('fishAudioIssue reports the field-specific message from its ONE home', () => {
  // The route and the wizard drifted on the message; one copy now.
  const base = { enabled: true, provider: 'fish-audio', model: 'speech-1.6', voice: 'ref123' };
  assert.equal(fishAudioIssue(base), null);
  assert.match(fishAudioIssue({ ...base, model: '' })!, /model id must be 1-100/);
  assert.match(fishAudioIssue({ ...base, voice: 'x'.repeat(101) })!, /voice reference id must be 1-100/);
  assert.match(fishAudioIssue({ ...base, model: 'a\nb' })!, /no line breaks/);
});
