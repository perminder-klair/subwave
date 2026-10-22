import assert from 'node:assert/strict';
import { test } from 'node:test';
import { personaFromSettings, formFromSettings, personasEqual } from './helpers';
import { identLinesFromText } from './ident-lines';
import { personaSchema } from '../../../lib/schemas.generated';

const base = () => personaFromSettings({ id: 'p_test', name: 'Test DJ', soul: 'Plain spoken.' }, []);

test('typing Enter retains the empty row until the shared schema cleans saved lines', () => {
  const draft = ' First ID. \n\nSecond ID.\n';
  const lines = identLinesFromText(draft);
  assert.equal(lines.join('\n'), draft);
  assert.deepEqual(lines, [' First ID. ', '', 'Second ID.', '']);
  assert.deepEqual(personaSchema.parse({ ...base(), identMode: 'verbatim', identLines: lines }).identLines,
    ['First ID.', 'Second ID.']);
  assert.deepEqual(personaSchema.parse({ ...base(), identLines: identLinesFromText('') }).identLines, []);
});

test('settings hydration preserves station ID fields across reload and discard', () => {
  const legacy = base();
  assert.equal(legacy.identMode, 'improvise');
  assert.deepEqual(legacy.identLines, []);
  const saved = { ...legacy, identMode: 'verbatim' as const, identLines: ['First ID.', 'Second ID.'] };
  const form = formFromSettings({ values: { personas: [saved], activePersonaId: saved.id } });
  assert.deepEqual(form!.personas[0]!.identLines, saved.identLines);
  assert.equal(form!.personas[0]!.identMode, 'verbatim');
  assert.equal(personasEqual(saved, form!.personas[0]), true);
  assert.equal(personasEqual(saved, { ...saved, identLines: ['Changed ID.'] }), false);
  assert.equal(personasEqual(saved, { ...saved, identMode: 'improvise' }), false);
});
