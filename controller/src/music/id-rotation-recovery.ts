// Detection and single-flight policy for Navidrome's 0.64 canonical-ID
// migration. The authoritative repair remains the normal library walk; this
// module only decides when a failed handoff has supplied enough evidence to
// start one automatically.

import { canonicalId } from './id-canonical.js';

export interface RotatedIdEvidence {
  storedId: string;
  canonicalId: string;
}

type SongLookup = (id: string) => Promise<{ id?: unknown } | null>;

export function isMissingSongError(err: unknown): boolean {
  const e = err as { message?: unknown; subsonicCode?: unknown } | null;
  if (Number(e?.subsonicCode) === 70) return true;
  const message = typeof e?.message === 'string' ? e.message : '';
  return /\b(?:song|requested data) not found\b/i.test(message);
}

export type RotationRecoveryResult =
  | 'ignored'
  | 'busy'
  | 'checking'
  | 'not-rotation'
  | 'started'
  | 'already-started';

export interface RotationRecoveryDeps {
  maintenanceRunning: () => boolean;
  getSong: SongLookup;
  /** Returns false when maintenance won the race between detection and start. */
  startReconcile: (evidence: RotatedIdEvidence) => boolean;
  log: (message: string) => void;
}

export interface RotationRecovery {
  inspect: (track: { id?: string | null; title?: string | null; artist?: string | null }) => Promise<RotationRecoveryResult>;
  automaticReconcileFailed: () => void;
}

export async function detectRotatedNavidromeId(
  storedId: string,
  getSong: SongLookup,
): Promise<RotatedIdEvidence | null> {
  const canonical = canonicalId(storedId);
  if (canonical === storedId) return null;

  try {
    if (await getSong(storedId)) return null;
  } catch (err) {
    // Navidrome reports a missing song inside an HTTP-200 Subsonic envelope.
    // A transport/auth/server failure is not proof of rotation, even if a later
    // request happens to recover.
    if (!isMissingSongError(err)) return null;
  }

  try {
    const replacement = await getSong(canonical);
    if (String(replacement?.id ?? '') !== canonical) return null;
  } catch {
    return null;
  }

  return { storedId, canonicalId: canonical };
}

export function createIdRotationRecovery(deps: RotationRecoveryDeps): RotationRecovery {
  let checking: Promise<RotationRecoveryResult> | null = null;
  let started = false;

  return {
    async inspect(track) {
      if (started) return 'already-started';
      if (checking) return 'checking';
      if (deps.maintenanceRunning()) return 'busy';
      const storedId = typeof track.id === 'string' ? track.id : '';
      if (!storedId) return 'ignored';

      const run = (async (): Promise<RotationRecoveryResult> => {
        const evidence = await detectRotatedNavidromeId(storedId, deps.getSong);
        if (!evidence) return 'not-rotation';
        if (deps.maintenanceRunning() || !deps.startReconcile(evidence)) return 'busy';

        started = true;
        const label = [track.title, track.artist].filter(Boolean).join(' — ');
        deps.log(
          `Navidrome rotated its track IDs${label ? ` (detected on "${label}")` : ''}: ` +
          `${evidence.storedId} now resolves as ${evidence.canonicalId}; reconciling the library automatically`,
        );
        return 'started';
      })();
      checking = run;
      try {
        return await run;
      } finally {
        if (checking === run) checking = null;
      }
    },

    automaticReconcileFailed() {
      started = false;
    },
  };
}
