// First-run detection — is the station set up enough to broadcast?
//
// The threshold is "Navidrome reachable" (URL + user + pass present somewhere),
// because without a music source the station can't play anything useful. LLM
// and TTS are pre-configured with sensible defaults (Ollama, Piper) so we
// don't gate on them — the wizard collects them for a complete walkthrough
// but a stack that boots with only Navidrome configured is broadcastable.

import { hasNavidrome, resolveNavidrome, navidromeEnvLocks } from './navidrome-policy.js';
import { config, NAVIDROME_ENV_ENABLED } from '../config.js';
import { loadSetupConfig } from './config.js';

export interface SetupStatus {
  needsSetup: boolean;
  setupCompletedAt: string | null;
  // Useful for the wizard's "I see you already have NAVIDROME_URL in env" UX.
  navidromeSource: 'env' | 'setup-config' | 'unset';
}

// Environment configuration only applies to a legacy single-station install.
export function envHasNavidrome(): boolean {
  return Object.values(navidromeEnvLocks(NAVIDROME_ENV_ENABLED)).every(Boolean);
}

export async function getSetupStatus(): Promise<SetupStatus> {
  const sc = await loadSetupConfig();
  const nv = resolveNavidrome(sc.navidrome, NAVIDROME_ENV_ENABLED);
  const filled = hasNavidrome({ ...nv, pass: nv.password });
  return {
    needsSetup: !filled,
    setupCompletedAt: sc.setupCompletedAt || null,
    navidromeSource: !filled ? 'unset' : envHasNavidrome() ? 'env' : 'setup-config',
  };
}

// /state reads the effective connection already hydrated at boot or save.
export function getSetupStatusSync(): SetupStatus {
  const nv = config.navidrome;
  const filled = hasNavidrome({ ...nv, pass: nv.password });
  return {
    needsSetup: !filled,
    setupCompletedAt: null,
    navidromeSource: !filled ? 'unset' : envHasNavidrome() ? 'env' : 'setup-config',
  };
}
