import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TTS_CLOUD_PROVIDERS } from '../lib/schemas.generated';
import {
  allowsBlankVoice,
  decideCloudSave,
  normalizeCloudProvider,
} from '../components/admin/settings/cloudSavePayload';

// These rules are transcribed from the controller's own validation in
// `settings.ts`. If the controller's rules change, this file is wrong — which is
// why each case below names the controller check it mirrors rather than asserting
// a shape in isolation.

test('a provider the enum accepts is sent as-is', () => {
  for (const provider of TTS_CLOUD_PROVIDERS) {
    assert.equal(normalizeCloudProvider(provider, 'openai'), provider);
  }
});

test('a stale provider id restores the SAVED provider, not a hardcoded default', () => {
  // The regression: a form hydrated by an older build carries `gemini`, which is
  // an ENGINE and not a member of the `tts.cloud.provider` enum. Falling straight
  // back to 'openai' would silently REPOINT a station that was on Fish or a
  // BYO-compatible endpoint, which is a far worse outcome than saving a stale
  // form slightly wrong.
  assert.equal(normalizeCloudProvider('gemini', 'fish-audio'), 'fish-audio');
  assert.equal(normalizeCloudProvider('gemini', 'openai-compatible'), 'openai-compatible');
  assert.equal(normalizeCloudProvider('gemini', ''), TTS_CLOUD_PROVIDERS[0],
    'with nothing saved, the enum head is the only defensible answer');
  assert.equal(normalizeCloudProvider('gemini', 'also-stale'), TTS_CLOUD_PROVIDERS[0],
    'an invalid SAVED provider is no better than an invalid form one');
});

test('a stale provider id is not mistaken for a provider transition', () => {
  // The key-erasure bug. `clearInlineCloudKey` compared the RAW form provider
  // against the saved one, so a stale `gemini` read as a change from `openai`
  // and the save sent `apiKey: ''` — erasing a stored credential when the
  // provider had not moved at all. The comparison is against the normalized
  // provider now, so a stale form leaves the key alone.
  const stale = decideCloudSave({
    provider: 'gemini', savedProvider: 'openai', model: 'tts-1', voice: 'alloy',
  });
  assert.equal(stale.provider, 'openai');
  assert.equal(stale.clearInlineKey, false,
    'a stale form is not a provider transition and must not clear the inline key');

  // A REAL transition still clears it.
  const moved = decideCloudSave({
    provider: 'elevenlabs', savedProvider: 'openai', model: 'eleven_turbo_v2', voice: 'rachel',
  });
  assert.equal(moved.clearInlineKey, true);

  // And a genuine no-op keeps it.
  const same = decideCloudSave({
    provider: 'openai', savedProvider: 'openai', model: 'tts-1', voice: 'alloy',
  });
  assert.equal(same.clearInlineKey, false);
});

test('Fish always clears the legacy shared key slot', () => {
  // Fish owns a scoped credential slot, so the shared inline key is cleared on
  // every save regardless of transition. That is credential PLACEMENT, not a
  // provider change, and it must not depend on the comparison above.
  const fish = decideCloudSave({
    provider: 'fish-audio', savedProvider: 'fish-audio', model: 'speech-1', voice: 'speech-1', isFish: true,
  });
  assert.equal(fish.clearInlineKey, true);
});

test('a blank model is omitted when nothing moved, and SENT on a transition', () => {
  // `settings.ts`: `if (v.length < 1 || v.length > 100) throw` — unconditionally,
  // so there is no provider for which a blank model is valid. On a same-provider
  // save, omitting the key leaves the controller holding the value it already has,
  // which beats 400-ing the entire save (and with it the unrelated LLM and
  // provider settings the operator opened the page to change).
  for (const provider of TTS_CLOUD_PROVIDERS) {
    const d = decideCloudSave({ provider, savedProvider: provider, model: '', voice: 'v' });
    assert.equal('model' in d, false, `${provider}: nothing moved, so keep the stored model`);
  }
  // A present model is sent verbatim.
  assert.equal(
    decideCloudSave({ provider: 'openai', savedProvider: 'openai', model: ' gpt-4o-mini-tts ', voice: 'alloy' }).model,
    'gpt-4o-mini-tts', 'the model is trimmed on the way out',
  );
});

test('a genuine provider TRANSITION must not inherit the old provider\'s fields', () => {
  // The regression this module was first written to prevent, reintroduced by the
  // fix for the stale-form 400.
  //
  // `settings.ts` merges the cloud block field by field (`if (c.model !== undefined)`,
  // `if (c.voice !== undefined)`), so OMITTING a key means the controller KEEPS the
  // stored value. On a transition that stored value belongs to the provider being
  // switched AWAY from. Saving OpenAI -> Fish with a blank voice therefore wrote
  // `provider: 'fish-audio'` and inherited voice `alloy`: silently wrong, and not
  // invalid in isolation, so the controller has no reason to reject it. A station
  // with a configured Fish key would save "successfully" and then voice every
  // segment with an OpenAI id.
  //
  // Previously this 400'd, which is loud and correct. That is restored here.
  const toFish = decideCloudSave({
    provider: 'fish-audio', savedProvider: 'openai', model: '', voice: '',
  });
  assert.equal(toFish.provider, 'fish-audio');
  assert.equal(toFish.isTransition, true);
  assert.ok('model' in toFish, 'a blank model on a transition must be SENT, so the controller rejects it');
  assert.ok('voice' in toFish, 'a blank voice on a transition must be SENT, not inherited from openai');
  assert.equal(toFish.voice, '', 'and sent blank, not backfilled with the previous provider id');
  assert.equal(toFish.clearInlineKey, true);

  // Same for a compat server whose base URL is configured and whose model was cleared.
  const toCompat = decideCloudSave({
    provider: 'openai-compatible', savedProvider: 'openai', model: '', voice: 'ref-1',
  });
  assert.equal(toCompat.isTransition, true);
  assert.equal(toCompat.model, '', 'a transition must not inherit the previous provider\'s model');
  assert.ok('model' in toCompat);
});

test('stale-form recovery is not a transition, because it normalises to the saved provider', () => {
  // The two cases that justify omission. Both leave the server holding the value
  // that already belongs to it, so preserving is correct rather than merely safe.
  const stale = decideCloudSave({
    provider: 'gemini', savedProvider: 'fish-audio', model: '', voice: '',
  });
  assert.equal(stale.provider, 'fish-audio');
  assert.equal(stale.isTransition, false, 'recovering the saved provider did not move anything');
  assert.equal('model' in stale, false);
  assert.equal('voice' in stale, false);
  assert.equal(stale.clearInlineKey, false);

  const same = decideCloudSave({
    provider: 'openai', savedProvider: 'openai', model: '', voice: 'alloy',
  });
  assert.equal(same.isTransition, false);
  assert.equal('model' in same, false);
  assert.equal(same.voice, 'alloy');
});

test('a blank voice is sent only for the one provider that accepts it', () => {
  // `settings.ts`: `allowEmpty = provider === 'openai-compatible'` — that
  // provider's voices are server-specific (arbitrary cloning ref names) and may
  // legitimately be blank, with the server picking its own default. Everywhere
  // else a blank voice is a 400, so it is omitted instead.
  assert.equal(allowsBlankVoice('openai-compatible'), true);
  for (const provider of TTS_CLOUD_PROVIDERS.filter((p) => p !== 'openai-compatible')) {
    assert.equal(allowsBlankVoice(provider), false, `${provider} must not accept a blank voice`);
    const d = decideCloudSave({ provider, savedProvider: provider, model: 'm', voice: '  ' });
    assert.equal('voice' in d, false, `${provider}: a blank voice must be omitted, not sent`);
  }
  // The compat provider keeps the blank, because clearing a server-specific voice
  // back to the server default is a real operation an operator performs.
  const compat = decideCloudSave({
    provider: 'openai-compatible', savedProvider: 'openai-compatible', model: 'm', voice: '',
  });
  assert.equal(compat.voice, '', 'openai-compatible must be able to CLEAR its voice');
});

test('omitted keys really are absent from the JSON body', () => {
  // `save()` serialises with `JSON.stringify`, which drops `undefined` but KEEPS a
  // key whose value is an empty string. The distinction the whole module rests on
  // — omit versus send blank — is only real if it survives serialisation, so it
  // is asserted against the wire format rather than the intermediate object.
  const d = decideCloudSave({
    provider: 'openai', savedProvider: 'openai', model: '', voice: 'alloy',
  });
  const body = JSON.stringify({ tts: { cloud: d } });
  assert.doesNotMatch(body, /"model"/, 'a blank model must not appear in the request body');
  assert.match(body, /"voice":"alloy"/, 'a real voice must appear in the request body');

  const compat = decideCloudSave({
    provider: 'openai-compatible', savedProvider: 'openai-compatible', model: '', voice: '',
  });
  assert.match(JSON.stringify(compat), /"voice":""/,
    'the one deliberate blank must survive as an explicit empty string');

  // The transition blank must survive too, or the controller retains the old
  // provider's field and the entire point of sending it is lost.
  const tb = JSON.stringify(decideCloudSave({
    provider: 'fish-audio', savedProvider: 'openai', model: '', voice: '',
  }));
  assert.match(tb, /"model":""/, 'a transition blank model must reach the wire as an empty string');
  assert.match(tb, /"voice":""/, 'a transition blank voice must reach the wire as an empty string');
});