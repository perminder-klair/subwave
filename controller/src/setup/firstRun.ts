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
import { currentSelection, readSelection, routerSelectionComplete, stationNavidromeIsComplete } from './music-source.js';
import type { MusicMode } from '../schemas/music-source.js';

export interface SetupStatus {
  needsSetup: boolean;
  setupCompletedAt: string | null;
  // Useful for the wizard's "I see you already have NAVIDROME_URL in env" UX.
  navidromeSource: 'env' | 'setup-config' | 'unset';
  // Which backend the station plays from (#692).
  musicMode: MusicMode;
}

// Environment configuration only applies to a legacy single-station install.
export function envHasNavidrome(): boolean {
  return Object.values(navidromeEnvLocks(NAVIDROME_ENV_ENABLED)).every(Boolean);
}

// A router-mode station is set up once it has a source to play — and, when
// that source is its own Navidrome (the default), a complete connection.
export async function getSetupStatus(): Promise<SetupStatus> {
  const sc = await loadSetupConfig();
  const selection = readSelection(sc);
  const nv = resolveNavidrome(sc.navidrome, NAVIDROME_ENV_ENABLED);
  const navidromeFilled = hasNavidrome({ ...nv, pass: nv.password });
  const filled = selection.mode === 'router' ? routerSelectionComplete(selection, navidromeFilled) : navidromeFilled;
  return {
    needsSetup: !filled,
    setupCompletedAt: sc.setupCompletedAt || null,
    navidromeSource: !navidromeFilled ? 'unset' : envHasNavidrome() ? 'env' : 'setup-config',
    musicMode: selection.mode,
  };
}

// /state reads the effective connection already hydrated at boot or save.
export function getSetupStatusSync(): SetupStatus {
  const selection = currentSelection();
  const nv = config.navidrome;
  const connected = hasNavidrome({ ...nv, pass: nv.password });
  const stationNavidrome = stationNavidromeIsComplete();
  const filled = selection.mode === 'router' ? connected && routerSelectionComplete(selection, stationNavidrome) : connected;
  return {
    needsSetup: !filled,
    setupCompletedAt: null,
    navidromeSource: !stationNavidrome ? 'unset' : envHasNavidrome() ? 'env' : 'setup-config',
    musicMode: selection.mode,
  };
}
