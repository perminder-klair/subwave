import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = join(import.meta.dirname, '..', '..');
const locales = ['en-US', 'en-IN', 'hi-IN'];

function renderTemplate(filename: string): any {
  const source = readFileSync(join(root, filename), 'utf8')
    .replaceAll('__ALEXA_ENDPOINT_URL__', 'https://example.invalid/api/alexa')
    .replaceAll('__ALEXA_SKILL_NAME__', 'Example Radio')
    .replaceAll('__ALEXA_INVOCATION_NAME__', 'example radio')
    .replaceAll('__ALEXA_DESCRIPTION__', 'Example radio')
    .replaceAll('__ALEXA_SUMMARY__', 'Example radio')
    .replaceAll('__ALEXA_TESTING_INSTRUCTIONS__', 'Test the example radio');
  return JSON.parse(source);
}

for (const locale of locales) {
  test(`Alexa ${locale} model contains the dedication and reminder flows`, () => {
    const model = renderTemplate(`alexa-skill-package/interactionModels/custom/${locale}.json.template`).interactionModel;
    const intents = model.languageModel.intents as Array<any>;
    const dedication = intents.find(intent => intent.name === 'DedicationIntent');
    const reminder = intents.find(intent => intent.name === 'RequestReminderIntent');
    assert.ok(dedication);
    assert.ok(reminder);
    assert.ok(intents.some(intent => intent.name === 'RequestSongIntent'));
    assert.ok(intents.some(intent => intent.name === 'NowPlayingIntent'));
    assert.equal(dedication.slots.find((slot: any) => slot.name === 'requestText').type, 'AMAZON.SearchQuery');
    assert.equal(dedication.slots.find((slot: any) => slot.name === 'dedicationTarget').type, 'AMAZON.SearchQuery');
    for (const sample of dedication.samples) {
      assert.equal(sample.includes('{requestText}') && sample.includes('{dedicationTarget}'), false);
    }
    const dialog = model.dialog.intents.find((intent: any) => intent.name === 'DedicationIntent');
    assert.equal(dialog.slots.every((slot: any) => slot.elicitationRequired === true), true);
    assert.equal(model.prompts.length, 2);
    assert.equal(model.languageModel.types.some((type: any) => type.name === 'AlexaDedicationTarget'), false);
  });
}

test('Alexa manifest requests reminder permission without deployment-specific values', () => {
  const manifest = renderTemplate('alexa-skill-package/skill.json.template').manifest;
  assert.deepEqual(manifest.permissions, [{ name: 'alexa::alerts:reminders:skill:readwrite' }]);
  assert.equal(manifest.apis.custom.endpoint.uri, 'https://example.invalid/api/alexa');
  assert.deepEqual(Object.keys(manifest.apis.custom.regions).sort(), ['EU', 'FE', 'NA']);
  for (const region of Object.values(manifest.apis.custom.regions) as Array<any>) {
    assert.equal(region.endpoint.uri, 'https://example.invalid/api/alexa');
  }
  for (const locale of ['en-US', 'en-IN']) {
    assert.deepEqual(manifest.publishingInformation.locales[locale].examplePhrases, [
      'Alexa open example radio',
      'ask example radio what is playing',
      'ask example radio for help',
    ]);
  }
});
