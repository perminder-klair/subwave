// The first boot freezes a cohort and its effective legacy connections BEFORE
// changing any profile. The private journal survives partial writes/restarts;
// completion discards its credential snapshot. No permanent env fallback.
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { STATION_ID_RE } from './pure.js';
import { NAVIDROME_PROFILE_POLICY, resolveNavidrome } from '../setup/navidrome-policy.js';
import { writeFileAtomicSync } from '../util/atomic-file.js';

const objectSchema = z.record(z.string(), z.unknown());
const snapshotSchema = z.object({
  navidrome: z.object({ url: z.string(), user: z.string(), pass: z.string() }),
  navidromePolicy: z.literal(NAVIDROME_PROFILE_POLICY),
}).passthrough();
const journalSchema = z.discriminatedUnion('phase', [
  z.object({ version: z.literal(1), phase: z.literal('complete') }),
  z.object({
    version: z.literal(1), phase: z.literal('pending'),
    profiles: z.array(z.object({
      id: z.string().regex(STATION_ID_RE),
      setup: snapshotSchema,
    })),
  }),
]);

export const NAVIDROME_MIGRATION_FILE = 'navidrome-migration.json';
export const NAVIDROME_MIGRATION_ERROR =
  'Navidrome upgrade migration is incomplete. Check the state volume permissions and JSON files, then restart. See docs/multi-station.md for recovery.';

// Reject links rather than replacing a file outside the profile. Missing files
// are normal; malformed/unreadable ones must remain available for recovery.
function readObject(path: string): z.infer<typeof objectSchema> {
  try {
    if (!lstatSync(path).isFile()) throw new Error('not a regular file');
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return {};
    throw err;
  }
  return objectSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

function independent(dir: string): boolean {
  return readObject(join(dir, 'station.json')).navidromePolicy === NAVIDROME_PROFILE_POLICY
    || readObject(join(dir, 'setup-config.json')).navidromePolicy === NAVIDROME_PROFILE_POLICY;
}

export function migrateNavidromeProfiles(
  root: string,
  write: typeof writeFileAtomicSync = writeFileAtomicSync,
): void {
  const stations = join(root, 'stations');
  if (!existsSync(stations)) return;
  try {
    const path = join(stations, NAVIDROME_MIGRATION_FILE);
    let journal: z.infer<typeof journalSchema>;
    if (existsSync(path)) {
      journal = journalSchema.parse(readObject(path));
    } else {
      const profiles = readdirSync(stations, { withFileTypes: true })
        .filter(e => e.isDirectory() && STATION_ID_RE.test(e.name))
        .sort((a, b) => a.name.localeCompare(b.name))
        .flatMap(e => {
          const dir = join(stations, e.name);
          if (independent(dir)) return [];
          const setup = readObject(join(dir, 'setup-config.json'));
          // Pre-#1777: each truthy env field overrides its saved counterpart.
          // Absent/empty env fields use saved values, then the compose URL
          // default / empty credentials. Passwords preserve whitespace.
          const nv = resolveNavidrome(setup.navidrome, true, { reportIssue: false });
          return [{ id: e.name, setup: {
            ...setup,
            navidrome: { url: nv.url, user: nv.user, pass: nv.password },
            navidromePolicy: NAVIDROME_PROFILE_POLICY,
          } satisfies z.infer<typeof snapshotSchema> }];
        });
      journal = { version: 1, phase: 'pending', profiles };
      try {
        write(path, JSON.stringify(journal, null, 2), { mode: 0o600, durable: true, replace: false });
      } catch (err) {
        // A concurrent maintenance/controller boot may have claimed the cohort.
        // Use its snapshot, even if it has already completed the migration.
        if (!(err instanceof Error && 'code' in err && err.code === 'EEXIST')) throw err;
        journal = journalSchema.parse(readObject(path));
      }
    }
    if (journal.phase === 'complete') return;
    for (const profile of journal.profiles) {
      const dir = join(stations, profile.id);
      // Deleted profiles stay deleted; a new stamped profile with a reused id
      // or an explicit repair after a failed migration must not be overwritten.
      if (!existsSync(dir)) continue;
      if (!lstatSync(dir).isDirectory()) throw new Error('not a profile directory');
      const setupPath = join(dir, 'setup-config.json');
      if (independent(dir)) continue;
      write(setupPath, JSON.stringify(profile.setup, null, 2), { mode: 0o600, durable: true });
    }
    write(path, JSON.stringify({ version: 1, phase: 'complete' }), { mode: 0o600, durable: true });
  } catch {
    // JSON errors can include the source text; neither they nor env URLs may
    // expose credentials through startup stderr or the booth log.
    throw new Error(NAVIDROME_MIGRATION_ERROR);
  }
}
