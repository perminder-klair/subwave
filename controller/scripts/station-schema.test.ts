// Station create/rename moved onto a shared zod schema (controller/src/schemas/
// station.ts), mirrored into web/lib/schemas.generated.ts. These tests pin the
// three surfaces that must agree: the schema itself, the route-boundary
// middleware's fieldErrors payload, and manager.createStation /
// manager.renameStation — the chokepoint reachable without a route.
//
// Run: npx tsx scripts/station-schema.test.ts (auto-discovered by npm test).
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createTempDir } from './test-utils/temp-dir.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.STATE_DIR = createTempDir(join(tmpdir(), 'subwave-station-schema-'));

const {
  MAX_STATIONS,
  STATION_ID_RE,
  STATION_NAME_MAX,
  slugifyStationName,
  stationCreateSchema,
  stationRenameSchema,
} = await import('../src/schemas/station.js');
const { stationCapMessage, uniqueStationId } = await import('../src/schemas/station-server.js');
const { validateBody } = await import('../src/middleware/validate.js');
const manager = await import('../src/stations/manager.js');

// --- the schema -------------------------------------------------------------

test('create: accepts a name and defaults mode to fresh', () => {
  const r = stationCreateSchema.parse({ name: 'Night Loop' });
  assert.equal(r.name, 'Night Loop');
  assert.equal(r.mode, 'fresh');
});

test('create: trims the name', () => {
  assert.equal(stationCreateSchema.parse({ name: '  Night Loop  ' }).name, 'Night Loop');
});

test('create: rejects an empty or whitespace-only name', () => {
  assert.equal(stationCreateSchema.safeParse({ name: '' }).success, false);
  assert.equal(stationCreateSchema.safeParse({ name: '   ' }).success, false);
  assert.equal(stationCreateSchema.safeParse({}).success, false);
});

test('create: rejects an over-long name (the old path silently truncated at 80)', () => {
  // Deliberate tightening. `.trim().slice(0, 80)` cut the name and carried on,
  // so an operator only found out by reading the rack afterwards.
  assert.equal(stationCreateSchema.safeParse({ name: 'x'.repeat(STATION_NAME_MAX) }).success, true);
  assert.equal(
    stationCreateSchema.safeParse({ name: 'x'.repeat(STATION_NAME_MAX + 1) }).success,
    false,
  );
});

test('create: rejects an unrecognised mode (the old path coerced it to fresh)', () => {
  // Also deliberate. `mode === 'duplicate' ? 'duplicate' : 'fresh'` meant a
  // typo'd or future mode built an EMPTY station instead of refusing — the
  // expensive direction, since the operator asked for a copy.
  assert.equal(stationCreateSchema.safeParse({ name: 'X', mode: 'duplicate' }).success, true);
  assert.equal(stationCreateSchema.safeParse({ name: 'X', mode: 'clone' }).success, false);
});

test('rename: same name rule, and nothing else in the body', () => {
  assert.equal(stationRenameSchema.parse({ name: '  Graveyard ' }).name, 'Graveyard');
  assert.equal(stationRenameSchema.safeParse({ name: '' }).success, false);
  // Unknown keys are stripped, so a stray `mode` can't ride a rename.
  assert.deepEqual(Object.keys(stationRenameSchema.parse({ name: 'A', mode: 'duplicate' })), [
    'name',
  ]);
});

// --- slugify: the function the admin preview now shares ----------------------

test('slugify: every result is a legal station id', () => {
  for (const name of ['Late Night FM', 'SUB/WAVE', '  ***  ', 'Ünïcode Béats!!', 'x'.repeat(80)]) {
    assert.ok(STATION_ID_RE.test(slugifyStationName(name)), name);
  }
});

test('slugify: nothing usable falls back to "station"', () => {
  // The bug the shared schema fixes. StationsPanel carried a hand-copied
  // reimplementation that omitted this fallback, so "!!!" previewed as an empty
  // slug and then arrived from the server as /station.
  assert.equal(slugifyStationName('!!!'), 'station');
  assert.equal(slugifyStationName(''), 'station');
});

// --- the server-only rules --------------------------------------------------

test('uniqueStationId: appends -2, -3 … past a collision', () => {
  assert.equal(uniqueStationId([], 'Night Loop'), 'night-loop');
  assert.equal(uniqueStationId(['night-loop'], 'Night Loop'), 'night-loop-2');
  assert.equal(uniqueStationId(['night-loop', 'night-loop-2'], 'Night Loop'), 'night-loop-3');
});

test('uniqueStationId: a suffixed id still fits STATION_ID_RE', () => {
  const long = 'a'.repeat(80);
  const taken = [slugifyStationName(long)];
  const id = uniqueStationId(taken, long);
  assert.ok(STATION_ID_RE.test(id), id);
  assert.ok(id.endsWith('-2'));
});

test('uniqueStationId: counts non-directory entries too', () => {
  // It replaced an existsSync() check against the stations dir, which saw
  // active.json and mixer-restart-failed.json as well as station dirs.
  assert.equal(uniqueStationId(['active.json', 'main'], 'main'), 'main-2');
});

test('stationCapMessage: null below the cap, a message at or above it', () => {
  assert.equal(stationCapMessage(MAX_STATIONS - 1), null);
  assert.match(String(stationCapMessage(MAX_STATIONS)), /capped at 8 stations/);
  assert.match(String(stationCapMessage(MAX_STATIONS + 3)), /capped at 8 stations/);
});

// --- the route boundary: fieldErrors keyed by dotted path -------------------
//
// This is the claim #1323 left untested. applyServerFieldErrors was wired but
// unreachable from Webhooks (both sides run the same schema, so the server had
// no rule the client hadn't already caught), and the note on #1337 asks whoever
// converts the next form to CONFIRM the dotted path lands on the right input
// rather than assume it. react-hook-form's setError takes exactly these keys,
// so pinning the payload shape here is pinning that behaviour.

interface FakeRes {
  code: number;
  body: { error?: string; fieldErrors?: Record<string, string> };
}

function runValidate(schema: Parameters<typeof validateBody>[0], body: unknown) {
  const res: FakeRes = { code: 0, body: {} };
  const req = { body } as { body: unknown };
  let nexted = false;
  validateBody(schema)(
    req as never,
    {
      status(c: number) {
        res.code = c;
        return this;
      },
      json(b: FakeRes['body']) {
        res.body = b;
        return this;
      },
    } as never,
    () => {
      nexted = true;
    },
  );
  return { res, nexted, req };
}

test('route: a bad name 400s with fieldErrors keyed "name"', () => {
  const { res, nexted } = runValidate(stationCreateSchema, { name: '' });
  assert.equal(nexted, false);
  assert.equal(res.code, 400);
  assert.deepEqual(Object.keys(res.body.fieldErrors ?? {}), ['name']);
  assert.match(String(res.body.fieldErrors?.name), /required/i);
  // The flat string every existing client already reads stays populated.
  assert.match(String(res.body.error), /^name: /);
});

test('route: a bad mode 400s with fieldErrors keyed "mode"', () => {
  const { res } = runValidate(stationCreateSchema, { name: 'X', mode: 'clone' });
  assert.equal(res.code, 400);
  assert.deepEqual(Object.keys(res.body.fieldErrors ?? {}), ['mode']);
});

test('route: a valid body calls next() with the PARSED value on req.body', () => {
  const { nexted, req } = runValidate(stationCreateSchema, { name: '  Night Loop  ' });
  assert.equal(nexted, true);
  // Trimmed and defaulted — the handler must see the schema's output, not the
  // raw body, or the two disagree about what was saved.
  assert.deepEqual(req.body, { name: 'Night Loop', mode: 'fresh' });
});

test('route: rename validates the same way', () => {
  assert.equal(runValidate(stationRenameSchema, { name: '' }).res.code, 400);
  assert.equal(runValidate(stationRenameSchema, { name: 'Graveyard' }).nexted, true);
});

// --- the chokepoint: manager runs the schema too ----------------------------

const withRoot = async (fn: (root: string) => Promise<void> | void) => {
  const root = createTempDir(join(tmpdir(), 'subwave-station-schema-root-'));
  try {
    await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test('createStation validates its own arguments, route or no route', async () => {
  await withRoot(async (root) => {
    mkdirSync(join(root, 'stations', 'main'), { recursive: true });
    writeFileSync(join(root, 'stations', 'active.json'), JSON.stringify({ activeId: 'main' }));

    await assert.rejects(
      manager.createStation(root, { name: '   ', mode: 'fresh', currentName: 'X' }),
      /name/i,
    );
    await assert.rejects(
      manager.createStation(root, {
        name: 'x'.repeat(STATION_NAME_MAX + 1),
        mode: 'fresh',
        currentName: 'X',
      }),
      /80 characters/,
    );
    // Nothing partial left behind by either refusal — the name is rejected
    // before any directory is minted.
    assert.deepEqual(readdirSync(join(root, 'stations')).sort(), ['active.json', 'main']);
  });
});

test('createStation throws a readable line, not a ZodError blob', async () => {
  await withRoot(async (root) => {
    mkdirSync(join(root, 'stations', 'main'), { recursive: true });
    writeFileSync(join(root, 'stations', 'active.json'), JSON.stringify({ activeId: 'main' }));
    try {
      await manager.createStation(root, { name: '', mode: 'fresh', currentName: 'X' });
      assert.fail('expected a throw');
    } catch (e) {
      const msg = (e as Error).message;
      assert.ok(!msg.includes('\n'), `expected one line, got:\n${msg}`);
      assert.equal((e as Error & { issues?: unknown }).issues, undefined);
    }
  });
});

test('a duplicate with no source is attributed to the mode field', async () => {
  // The one create failure a form field can actually fix (pick Fresh instead),
  // and one only the server can detect — it reads the live pointer off disk.
  // This is what exercises applyServerFieldErrors end to end.
  await withRoot(async (root) => {
    mkdirSync(join(root, 'stations', 'alpha'), { recursive: true });
    writeFileSync(join(root, 'stations', 'active.json'), 'corrupt');
    try {
      await manager.createStation(root, { name: 'Copy', mode: 'duplicate', currentName: 'X' });
      assert.fail('expected a throw');
    } catch (e) {
      assert.ok(e instanceof manager.StationCreateError);
      assert.equal((e as InstanceType<typeof manager.StationCreateError>).field, 'mode');
      assert.match((e as Error).message, /no active station to duplicate from/);
    }
  });
});

test('a full rack carries NO field — nothing typed in the dialog fixes it', async () => {
  await withRoot(async (root) => {
    mkdirSync(join(root, 'stations'), { recursive: true });
    for (let i = 0; i < MAX_STATIONS; i++) mkdirSync(join(root, 'stations', `s${i}`));
    writeFileSync(join(root, 'stations', 'active.json'), JSON.stringify({ activeId: 's0' }));
    try {
      await manager.createStation(root, { name: 'One Too Many', mode: 'fresh', currentName: 'X' });
      assert.fail('expected a throw');
    } catch (e) {
      assert.ok(e instanceof manager.StationCreateError);
      assert.equal((e as InstanceType<typeof manager.StationCreateError>).field, undefined);
    }
  });
});

test('renameStation refuses what it used to repair silently', async () => {
  // It resolved an empty name to the station's own SLUG ("night-shift") and cut
  // an over-long one at 80. Both now refuse, so the operator sees it happen.
  await withRoot(async (root) => {
    mkdirSync(join(root, 'stations', 'night-shift'), { recursive: true });
    writeFileSync(join(root, 'stations', 'active.json'), JSON.stringify({ activeId: 'other' }));

    assert.equal(manager.renameStation(root, 'night-shift', '  Graveyard  '), 'Graveyard');
    assert.throws(() => manager.renameStation(root, 'night-shift', '   '), /name/i);
    assert.throws(
      () => manager.renameStation(root, 'night-shift', 'x'.repeat(STATION_NAME_MAX + 1)),
      /80 characters/,
    );
    // The refusals left the last good name in place.
    assert.equal(manager.listStations(root, 'X')[0].name, 'Graveyard');
  });
});
