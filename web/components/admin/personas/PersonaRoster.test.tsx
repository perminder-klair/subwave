import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PersonaRoster } from './PersonaRoster';
import type { Persona } from './types';

const persona: Persona = {
  id: 'p_night',
  name: 'Night DJ',
  tagline: 'After dark',
  frequency: 'moderate',
  scriptLength: 'concise',
  djMode: false,
  humour: 5,
  localColour: 5,
  warmth: 5,
  soul: 'Calm and observant.',
  language: '',
  avatar: '',
  tts: {
    engine: 'piper',
    cloudProvider: 'openai',
    voice: '',
    gainDb: 0,
    speed: 1,
  },
  skills: [],
  tags: ['late-night'],
};

test('the persona cap uses the unfiltered total, not the visible matches', () => {
  const html = renderToStaticMarkup(createElement(PersonaRoster, {
    roster: [{ persona, index: 17, position: 1 }],
    total: 64,
    sort: 'az',
    onSortChange: () => {},
    query: '',
    onQueryChange: () => {},
    tags: ['late-night'],
    selectedTags: ['late-night'],
    onTagsChange: () => {},
    filtered: true,
    onClearFilters: () => {},
    activePersonaId: persona.id,
    onAirPersonaId: persona.id,
    avatarTick: 0,
    isPersonaInvalid: () => false,
    onOpenPrompt: () => {},
    onAdd: () => {},
    onSelect: () => {},
    communityCount: 0,
    onCommunity: () => {},
  }));

  const labelAt = html.indexOf('+ Add persona');
  assert.notEqual(labelAt, -1);
  const openingButton = html.slice(0, labelAt).slice(html.slice(0, labelAt).lastIndexOf('<button'));
  assert.match(openingButton, /disabled=""/);
});
