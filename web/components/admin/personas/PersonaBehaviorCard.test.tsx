import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useForm } from 'react-hook-form';
import { PersonaBehaviorCard } from './PersonaBehaviorCard';
import { personaFromSettings } from './helpers';
import { personaSchema } from '../../../lib/schemas.generated';
import type { PersonasFormValues, Persona } from './types';

function renderBehavior(persona: Persona, error?: string) {
  let identMode: Persona['identMode'] | undefined;
  function Form() {
    const form = useForm<PersonasFormValues>({ defaultValues: { personas: [persona], djPrompts: [] } });
    if (error) form.setError('personas.0.identLines', { type: 'validate', message: error });
    identMode = form.getValues('personas.0.identMode');
    return createElement(PersonaBehaviorCard, { index: 0, control: form.control });
  }
  const html = renderToStaticMarkup(createElement(Form));
  return { html, identMode };
}

const base = () => personaFromSettings({ id: 'p_test', name: 'Test DJ', soul: 'Plain spoken.' }, []);

test('legacy hydration defaults to improvising and hides the line editor', () => {
  const persona = base();
  assert.equal(persona.identMode, 'improvise');
  assert.deepEqual(persona.identLines, []);
  const { html, identMode } = renderBehavior(persona);
  assert.equal(identMode, 'improvise');
  assert.match(html, /Station ID mode/);
  assert.match(html, /Choose how this persona delivers station IDs/);
  assert.doesNotMatch(html, /<textarea/);
});

test('verbatim mode renders the operator lines and connects their description', () => {
  const persona = { ...base(), identMode: 'verbatim' as const, identLines: ['First ID.', 'Second ID.', ''] };
  const { html, identMode } = renderBehavior(persona);
  assert.equal(identMode, 'verbatim');
  assert.match(html, /Station ID mode/);
  assert.match(html, /Choose how this persona delivers station IDs/);
  assert.match(html, /Station ID lines/);
  assert.match(html, /<textarea[^>]*aria-describedby="[^"]+"[^>]*>First ID\.\nSecond ID\.\n<\/textarea>/);
  assert.match(html, /One complete ID per line/);
  assert.match(html, /With no lines, IDs remain improvised/);
});

test('Improvise keeps retained invalid lines and their validation error visible', () => {
  const line = 'x'.repeat(301);
  const persona = { ...base(), identMode: 'improvise' as const, identLines: [line] };
  const result = personaSchema.safeParse(persona);
  assert.equal(result.success, false);
  if (result.success) throw new Error('301-character line must be invalid');
  const error = result.error.issues.find(issue => issue.path[0] === 'identLines')!.message;
  const { html } = renderBehavior(persona, error);
  assert.match(html, /Station ID lines/);
  assert.match(html, /<textarea[^>]*aria-invalid="true"/);
  assert.ok(html.includes(line));
  assert.ok(html.includes(error));
  assert.match(html, /These lines are unused in Improvise mode/);
});

test('Improvise keeps valid retained lines visible without an error', () => {
  const { html } = renderBehavior({ ...base(), identLines: ['Saved ID.'] });
  assert.match(html, /<textarea[^>]*>Saved ID\.<\/textarea>/);
  assert.match(html, /These lines are unused in Improvise mode/);
});

test('Improvise keeps an active lines error visible even with no retained lines', () => {
  const { html } = renderBehavior(base(), 'Fix station ID lines.');
  assert.match(html, /<textarea[^>]*aria-invalid="true"/);
  assert.match(html, /Fix station ID lines/);
});
