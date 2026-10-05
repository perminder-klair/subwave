// Setup overlay — small JSON file the first-run wizard writes to capture
// Navidrome credentials and the setup-complete timestamp. Lives at
// state/setup-config.json (writable from any container UID via the existing
// state-dir perms). Multi-station profiles use only their own stored connection;
// single-station installs still let environment variables override it.
//
// Why not extend settings.ts? Settings.ts has thick schema validation for the
// admin UI's many knobs (DJ personas, shows, schedules, TTS engines, …). The
// wizard only needs a tiny structured store for fields that already had env-var
// counterparts. A separate file keeps the surfaces clean: settings.ts stays
// the runtime admin store; setup-config.json holds the music connection.

import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { NAVIDROME_PROFILE_POLICY, resolveNavidrome } from './navidrome-policy.js';
import { config, STATE_DIR, NAVIDROME_ENV_ENABLED } from '../config.js';
import { writeFileAtomic } from '../util/atomic-file.js';

const PATH = `${STATE_DIR}/setup-config.json`;

export interface SetupConfig {
  navidrome?: {
    url?: string;
    user?: string;
    pass?: string;
  };
  // ISO timestamp written when the wizard saves successfully.
  setupCompletedAt?: string;
  navidromePolicy?: typeof NAVIDROME_PROFILE_POLICY;
}

// No in-process cache: the file is ~200 bytes and only read on the rare
// /onboarding/status path (admin shell mount, onboarding page load). A
// cache here previously caused a real bug — when the CLI's `subwave setup`
// wrote the file from the host side, the controller kept serving its stale
// empty snapshot and AdminShell kept bouncing the operator back to
// /onboarding even though setup was complete.
export async function loadSetupConfig(): Promise<SetupConfig> {
  if (!existsSync(PATH)) return {};
  try {
    return JSON.parse(await readFile(PATH, 'utf8'));
  } catch {
    return {};
  }
}

export async function saveSetupConfig(patch: Partial<SetupConfig>): Promise<SetupConfig> {
  const current = await loadSetupConfig();
  // Shallow-merge top level, deep-merge navidrome to allow partial updates.
  const next: SetupConfig = {
    ...current,
    ...patch,
    navidrome: { ...(current.navidrome || {}), ...(patch.navidrome || {}) },
    ...(!NAVIDROME_ENV_ENABLED && patch.navidrome ? { navidromePolicy: NAVIDROME_PROFILE_POLICY } : {}),
  };
  await mkdir(dirname(PATH), { recursive: true });
  await writeFileAtomic(PATH, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

// Used by the controller and both maintenance entrypoints.
export async function loadNavidromeConfig(): Promise<void> {
  const sc = await loadSetupConfig();
  Object.assign(config.navidrome, resolveNavidrome(sc.navidrome, NAVIDROME_ENV_ENABLED));
}

// Kept for callers that previously invalidated the (now-removed) cache.
// No-op — every read is fresh from disk.
export function clearSetupConfigCache() {}

// Apply freshly-saved Navidrome creds to the LIVE config so Subsonic calls use
// them without a restart. Shared by the onboarding wizard's save and the admin
// Settings Music-source save — one place, so live-apply behaviour can't drift.
// Blank/absent fields keep their current live value (partial updates are fine,
// and a blank password can never clobber a working live one).
export function applyNavidromeToLiveConfig(nv: { url?: string; user?: string; pass?: string }) {
  if (nv.url) config.navidrome.url = String(nv.url).trim().replace(/\/$/, '');
  if (nv.user) config.navidrome.user = String(nv.user).trim();
  if (nv.pass) config.navidrome.password = String(nv.pass);
}
