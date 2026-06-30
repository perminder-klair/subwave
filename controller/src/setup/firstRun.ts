// First-run detection — is the station set up enough to broadcast?
//
// The threshold is "Navidrome reachable" (URL + user + pass present somewhere),
// because without a music source the station can't play anything useful. LLM
// and TTS are pre-configured with sensible defaults (Ollama, Piper) so we
// don't gate on them — the wizard collects them for a complete walkthrough
// but a stack that boots with only Navidrome configured is broadcastable.

import { config } from '../config.js';
import { loadSetupConfig } from './config.js';

export interface SetupStatus {
  needsSetup: boolean;
  setupCompletedAt: string | null;
  // Useful for the wizard's "I see you already have NAVIDROME_URL in env" UX.
  navidromeSource: 'env' | 'setup-config' | 'unset';
}

export async function getSetupStatus(): Promise<SetupStatus> {
  // config.navidrome.* is populated from env at boot; setup-config.json is the
  // wizard's persistence layer. If env supplies values, env wins.
  const hasNavidrome = !!(process.env.NAVIDROME_URL && process.env.NAVIDROME_USER && process.env.NAVIDROME_PASS);
  const hasPlex = !!(process.env.PLEX_URL && process.env.PLEX_TOKEN);

  if (hasNavidrome) {
    return {
      needsSetup: false,
      setupCompletedAt: null,
      navidromeSource: 'env',
    };
  }

  if (hasPlex) {
    return {
      needsSetup: false,
      setupCompletedAt: null,
      navidromeSource: 'unset',
    };
  }

  const sc = await loadSetupConfig();
  const nv = sc.navidrome || {};
  const setupConfigHasNavidrome = Boolean(nv.url && nv.user && nv.pass);
  const setupConfigHasPlex = Boolean(sc.plex?.url && sc.plex?.token);

  return {
    needsSetup: !(setupConfigHasNavidrome || setupConfigHasPlex),
    setupCompletedAt: sc.setupCompletedAt || null,
    navidromeSource: setupConfigHasNavidrome ? 'setup-config' : 'unset',
  };
}

// Synchronous variant used by /state — relies on the cache populated at boot.
// Falls back to the env check if the cache hasn't loaded yet, which keeps the
// /state response safe even on the first request after a cold start.
export function getSetupStatusSync(): SetupStatus {
  const envHasNavidrome = Boolean(
    process.env.NAVIDROME_URL &&
      process.env.NAVIDROME_USER &&
      process.env.NAVIDROME_PASS,
  );
  if (envHasNavidrome) {
    return { needsSetup: false, setupCompletedAt: null, navidromeSource: 'env' };
  }
  const envHasPlex = Boolean(process.env.PLEX_URL && process.env.PLEX_TOKEN);
  if (envHasPlex) {
    return { needsSetup: false, setupCompletedAt: null, navidromeSource: 'unset' };
  }
  // Read the config we already loaded into memory rather than touching disk.
  const url = config.navidrome.url;
  const user = config.navidrome.user;
  const pass = config.navidrome.password;
  const filled = Boolean(url && user && pass && url !== 'http://navidrome:4533');
  const plexFilled = Boolean(config.plex.url && config.plex.token);
  return {
    needsSetup: !(filled || plexFilled),
    setupCompletedAt: null,
    navidromeSource: filled ? 'setup-config' : 'unset',
  };
}
