// A show's listener description (#2358): the plain-text blurb listeners read on
// the schedule and the On Now card. `topic` stays the DJ's brief, so the
// description must survive a round trip, reach exactly the public shapes that
// already carry `topic`, and never reach a model.
//
// Run: `npm test -- show-description`.

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listen } from './test-utils/http.js';
import { removeTempDir } from './test-utils/temp-dir.js';

const root = mkdtempSync(join(tmpdir(), 'subwave-show-description-'));
process.env.STATE_DIR = root;
delete process.env.ADMIN_USER;
delete process.env.ADMIN_PASS;

const express = (await import('express')).default;
const settings = await import('../src/settings.js');
const { setCache } = await import('../src/settings/store.js');
const { router: publicRouter } = await import('../src/routes/public.js');
const { getFullContext } = await import('../src/context.js');
const { pickSystem } = await import('../src/broadcast/dj-agent/schemas.js');
const { showSchema, repairShowForLoad, SHOW_DESCRIPTION_MAX } = await import('../src/schemas/show.js');

after(async () => {
  const db = await import('../src/music/library-db.js'); db.close();
  await removeTempDir(root);
});

const LATE = 's_late';
const BRIEF = 'Keep the energy low. Reach for search_library before tracksByMood.';
const BLURB = 'Ambient and downtempo to see you through the small hours.';

const shapeOnly = { personaIds: null, moodNames: null, themeIds: null, minTrackSeconds: null };

async function lateOnAir(over: Record<string, unknown> = {}) {
  await settings.load();
  const at = Date.now();
  const show = { id: LATE, name: 'The late shift', topic: BRIEF, personaId: settings.get().personas[0].id, ...over };
  await settings.update({
    shows: [show],
    scheduleOverride: { showId: LATE, startedAt: at - 60_000, expiresAt: at + 3600_000 },
  } as never);
}

async function withPublic<T>(fn: (url: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use(publicRouter);
  const { server, url } = await listen(app);
  try {
    return await fn(url);
  } finally {
    server.close();
  }
}

test('the schema trims, caps and defaults description to empty', () => {
  const parse = (description: unknown) =>
    showSchema(shapeOnly).safeParse({ name: 'A show', personaId: 'p', description });
  assert.equal((parse(`  ${BLURB}  `) as any).data.description, BLURB);
  assert.equal((parse(undefined) as any).data.description, '');
  assert.equal((parse(null) as any).data.description, '');
  assert.equal(parse('x'.repeat(SHOW_DESCRIPTION_MAX)).success, true);
  assert.equal(parse('x'.repeat(SHOW_DESCRIPTION_MAX + 1)).success, false, 'the save path refuses an over-long description');
});

test('the load path repairs a malformed or over-long description instead of dropping the show', () => {
  const long = repairShowForLoad({ description: ` ${'y'.repeat(SHOW_DESCRIPTION_MAX + 50)}` }, null);
  assert.equal((long.description as string).length, SHOW_DESCRIPTION_MAX);
  assert.equal(repairShowForLoad({ description: 42 }, null).description, undefined);
});

test('description survives settings cold load', async () => {
  await lateOnAir({ description: BLURB });
  setCache(null);
  await settings.load();
  const stored = (settings.get().shows as any[]).find((s) => s.id === LATE);
  assert.equal(stored.description, BLURB);
  assert.equal(stored.topic, BRIEF);
});

test('a show saved without a description stores it empty', async () => {
  await lateOnAir();
  const stored = (settings.get().shows as any[]).find((s) => s.id === LATE);
  assert.equal(stored.description, '');
});

test('/schedule carries description beside topic', async () => {
  await lateOnAir({ description: BLURB });
  await withPublic(async (url) => {
    const body = await (await fetch(`${url}/schedule`)).json() as any;
    const entry = body.shows.find((s: any) => s.id === LATE);
    assert.equal(entry.description, BLURB);
    assert.equal(entry.topic, BRIEF, 'topic stays for older clients and the mobile app');
  });
});

test('/now-playing joins description onto context.activeShow only', async () => {
  await lateOnAir({ description: BLURB });
  await withPublic(async (url) => {
    const body = await (await fetch(`${url}/now-playing`)).json() as any;
    assert.equal(body.context.activeShow.id, LATE);
    assert.equal(body.context.activeShow.topic, BRIEF);
    assert.equal(body.context.activeShow.description, BLURB);
    // The reshaped top-level activeShow never carried topic, so it gains nothing.
    assert.equal('description' in (body.activeShow ?? {}), false);
    assert.equal('topic' in (body.activeShow ?? {}), false);
  });
});

test('the model-facing show shape never carries description', async () => {
  await lateOnAir({ description: BLURB });
  const resolved = settings.resolveActiveShow() as any;
  assert.equal(resolved.id, LATE);
  assert.equal('description' in resolved, false);
  assert.equal('description' in (settings.resolvePickShow() as any), false);
  const ctx = await getFullContext() as any;
  assert.equal(ctx.activeShow.id, LATE);
  assert.equal('description' in ctx.activeShow, false);
  assert.equal(JSON.stringify(ctx).includes(BLURB), false, 'the prompt context never holds the blurb');
});

test('the pick system prompt reads topic and never description', async () => {
  await lateOnAir({ description: BLURB });
  const prompt = pickSystem();
  assert.ok(prompt.includes(BRIEF), 'the brief reaches the DJ');
  assert.equal(prompt.includes(BLURB), false, 'the listener blurb never does');
});
