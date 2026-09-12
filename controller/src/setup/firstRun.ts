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
  // Which music source the threshold above was judged for (settings.music.source).
  musicSource?: string;
}

// The Navidrome-creds threshold only applies when the active music source IS
// Navidrome/Subsonic. Another source (Spotify) is configured through its own
// credentials, so it never gates first-run on Navidrome. Reads settings.get()
// directly (sync, DEFAULTS → 'subsonic' pre-load) to keep setup/ off the music
// import graph. Mirrors upstream #843's hunk.
function activeMusicSource(): string {
  try {
    return (settings.get() as any)?.music?.source || 'subsonic';
  } catch {
    return 'subsonic';
  }
}

// A non-Navidrome source NEVER gates first-run (upstream #843's rule, and a
// measured one): the wizard's first screen is Navidrome, and the only place a
// Spotify station can enter its credentials is the admin Settings page — which
// the shell redirects AWAY from while needsSetup is true. Gating on "Spotify
// connected" therefore locked the operator out of the page that connects it.
// Whether Spotify is actually connected is the doctor's and the settings
// section's job to report, not the redirect's.
function nonSubsonicStatus(source: string): SetupStatus {
  return {
    needsSetup: false,
    setupCompletedAt: null,
    navidromeSource: 'unset',
    musicSource: source,
  };
}

// Env-supplied Navidrome creds configure the whole INSTALL, not one station —
// env always wins at boot no matter which station dir is active. The stations
// listing uses this to mark every station configured on env-driven installs
// (which never write setup-config.json, so the per-dir check alone reads as
// "needs setup" on a perfectly healthy station).
export function envHasNavidrome(): boolean {
  return Boolean(
    process.env.NAVIDROME_URL &&
      process.env.NAVIDROME_USER &&
      process.env.NAVIDROME_PASS,
  );
}

export async function getSetupStatus(): Promise<SetupStatus> {
  const source = activeMusicSource();
  if (source !== 'subsonic') return nonSubsonicStatus(source);
  // config.navidrome.* is populated from env at boot; setup-config.json is the
  // wizard's persistence layer. If env supplies values, env wins.
  if (envHasNavidrome()) {
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
  const source = activeMusicSource();
  if (source !== 'subsonic') return nonSubsonicStatus(source);
  if (envHasNavidrome()) {
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
