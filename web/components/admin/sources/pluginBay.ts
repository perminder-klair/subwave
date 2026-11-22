// Pure derivations behind Admin → Music sources → Plugins, the plugin bay:
// which module sits in which slot, what its lamp says, and what it backs.
// Kept out of the components so the rules are tested without rendering.

import type { MusicCapabilities, MusicEndpointCoverage, MusicPluginInfo, RouterStatus } from '../../../lib/schemas.generated';

/** on air: serving the station now · standby: loaded, not serving · fault: its manifest or module did not load. */
export type ModuleState = 'onair' | 'standby' | 'fault';

export type CellState = 'full' | 'degraded' | 'unsupported' | 'unknown';

export interface Coverage {
  full: number;
  degraded: number;
  unsupported: number;
  unknown: number;
  total: number;
  /** One per endpoint, in the router's order, for the strip and the printout. */
  cells: Array<{ endpoint: string; group: string; state: CellState; needs: string | null; feature: string | null }>;
}

export interface BayModule {
  /** 1-based slot in the rack. */
  slot: number;
  plugin: MusicPluginInfo;
  state: ModuleState;
  /** Live health for an on-air module. */
  health: RouterStatus['active'][number]['health'] | null;
  rawIds: boolean;
  capabilities: MusicCapabilities | null;
  coverage: Coverage;
}

export function moduleCoverage(endpoints: readonly MusicEndpointCoverage[], caps: MusicCapabilities | null): Coverage {
  const cells = endpoints.map((e) => {
    const state: CellState = !e.needs ? 'full' : !caps ? 'unknown' : caps[e.needs] ? 'full' : (e.whenMissing ?? 'unsupported');
    return { endpoint: e.endpoint, group: e.group, state, needs: e.needs, feature: e.feature ?? null };
  });
  const count = (s: CellState) => cells.filter((c) => c.state === s).length;
  return { full: count('full'), degraded: count('degraded'), unsupported: count('unsupported'), unknown: count('unknown'), total: cells.length, cells };
}

/**
 * The rack, top to bottom: the modules on air in the station's order, then the
 * rest — built-ins before installed — alphabetical. A module that failed to
 * load keeps its slot, lamp red, so the fault is where the operator looks.
 */
export function buildBay(status: RouterStatus, onAirMode: boolean): BayModule[] {
  const active = onAirMode ? status.active : [];
  const rank = (p: MusicPluginInfo) => {
    const i = active.findIndex((a) => a.plugin === p.name);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  const ordered = [...status.plugins].sort(
    (a, b) => rank(a) - rank(b) || Number(b.builtin) - Number(a.builtin) || a.label.localeCompare(b.label),
  );
  return ordered.map((plugin, i) => {
    const live = active.find((a) => a.plugin === plugin.name);
    const capabilities = live?.capabilities ?? plugin.capabilities ?? null;
    return {
      slot: i + 1,
      plugin,
      state: plugin.error ? 'fault' : live ? 'onair' : 'standby',
      health: live?.health ?? null,
      rawIds: live?.rawIds ?? false,
      capabilities,
      coverage: moduleCoverage(status.endpoints, capabilities),
    };
  });
}

export function bayReadout(modules: readonly BayModule[]) {
  return {
    slots: modules.length,
    onAir: modules.filter((m) => m.state === 'onair').length,
    faults: modules.filter((m) => m.state === 'fault').length,
    installed: modules.filter((m) => !m.plugin.builtin).length,
  };
}

export const slotLabel = (n: number) => `SLOT ${String(n).padStart(2, '0')}`;
