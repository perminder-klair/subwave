// First-run detection — is the station set up enough to broadcast?
//
// The threshold is "Navidrome reachable" (URL + user + pass present somewhere),
// because without a music source the station can't play anything useful. LLM
// and TTS are pre-configured with sensible defaults (Ollama, Piper) so we
// don't gate on them — the wizard collects them for a complete walkthrough
// but a stack that boots with only Navidrome configured is broadcastable.

import { config } from '../config.js';
import { loadSetupConfig } from './config.js';
import * as settings from '../settings.js';

export interface SetupStatus {
  needsSetup: boolean;
  setupCompletedAt: string | null;
  // Useful for the wizard's "I see you already have NAVIDROME_URL in env" UX.
  navidromeSource: 'env' | 'setup-config' | 'unset';
}

// The Navidrome-creds threshold only applies when the active music source IS
// Navidrome/Subsonic. A source that needs no server (e.g. the local folder) is
// broadcastable with zero Navidrome config, so it never gates first-run.
// Reads settings.get() directly (sync, DEFAULTS → 'subsonic' pre-load) to keep
// setup/ off the music import graph.
function activeMusicSource(): string {
  try {
    return (settings.get() as any)?.music?.source || 'subsonic';
  } catch {
    return 'subsonic';
  }
}

export async function getSetupStatus(): Promise<SetupStatus> {
  if (activeMusicSource() !== 'subsonic') {
    return { needsSetup: false, setupCompletedAt: null, navidromeSource: 'unset' };
  }
  // config.navidrome.* is populated from env at boot; setup-config.json is the
  // wizard's persistence layer. If env supplies values, env wins.
  const envHasNavidrome = Boolean(
    process.env.NAVIDROME_URL &&
      process.env.NAVIDROME_USER &&
      process.env.NAVIDROME_PASS,
  );

  if (envHasNavidrome) {
    return {
      needsSetup: false,
      setupCompletedAt: null,
      navidromeSource: 'env',
    };
  }

  const sc = await loadSetupConfig();
  const nv = sc.navidrome || {};
  const setupConfigHasNavidrome = Boolean(nv.url && nv.user && nv.pass);

  return {
    needsSetup: !setupConfigHasNavidrome,
    setupCompletedAt: sc.setupCompletedAt || null,
    navidromeSource: setupConfigHasNavidrome ? 'setup-config' : 'unset',
  };
}

// Synchronous variant used by /state — relies on the cache populated at boot.
// Falls back to the env check if the cache hasn't loaded yet, which keeps the
// /state response safe even on the first request after a cold start.
export function getSetupStatusSync(): SetupStatus {
  if (activeMusicSource() !== 'subsonic') {
    return { needsSetup: false, setupCompletedAt: null, navidromeSource: 'unset' };
  }
  const envHasNavidrome = Boolean(
    process.env.NAVIDROME_URL &&
      process.env.NAVIDROME_USER &&
      process.env.NAVIDROME_PASS,
  );
  if (envHasNavidrome) {
    return { needsSetup: false, setupCompletedAt: null, navidromeSource: 'env' };
  }
  // Read the config we already loaded into memory rather than touching disk.
  const url = config.navidrome.url;
  const user = config.navidrome.user;
  const pass = config.navidrome.password;
  const filled = Boolean(url && user && pass && url !== 'http://navidrome:4533');
  return {
    needsSetup: !filled,
    setupCompletedAt: null,
    navidromeSource: filled ? 'setup-config' : 'unset',
  };
}
