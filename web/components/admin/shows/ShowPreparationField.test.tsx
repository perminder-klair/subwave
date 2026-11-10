import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { preparationStatusSchema } from '@/lib/schemas.generated';
import { ShowPreparationField } from './ShowPreparationField';
import { hydrateShow } from './lib';
import { showKeys } from './queries';
import type { ShowsFormValues } from './types';

const show = hydrateShow({ id: 's_artist', name: 'Artist hour', personaId: 'host', preparationSkill: 'prepare' });

function Editor() {
  const form = useForm<ShowsFormValues>({ defaultValues: { shows: [show] } });
  return createElement(ShowPreparationField, {
    show, index: 0, control: form.control, personas: [],
    skills: [{ name: 'prepare', kind: 'prepare', hasTool: true, enabled: true }],
    adminFetch: async () => { throw new Error('Rendering cached status must not make a request'); },
  });
}

test('a recovered degraded catalogue status renders the editor Retry catalogue button', () => {
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, staleTime: Infinity } } });
  client.setQueryData(showKeys.preparation(), preparationStatusSchema.parse({
    kind: 'degraded', skill: 'prepare', subject: 'Chosen artist', reason: 'Catalogue unavailable',
    occurrence: { id: 'scheduled:s_artist:1', showId: show.id, source: 'scheduled', startsAt: 1, endsAt: 3600_001 },
  }));
  const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Editor)));
  assert.match(html, /Chosen artist/);
  assert.match(html, /Catalogue unavailable/);
  assert.match(html, /<button[^>]*>Retry catalogue<\/button>/);
  assert.doesNotMatch(html, /Retry preparation/);
  client.clear();
});
