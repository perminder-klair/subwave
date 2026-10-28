// The two tool-loop agent definitions: the track picker and the listener-request
// matcher. Both run the same harness, so they accept native output on the same
// terms.

import * as settings from '../../settings.js';
import { defineAgent } from '../../llm/agent.js';
import { buildPickerTools, type PickerScope } from '../../llm/tools.js';
import { agenticDiscoverySchema, pickSystem, requestSchema, requestSystem } from './schemas.js';
import { agentDeadline } from './breaker.js';
import type { Persona } from '../queue/types.js';

// What pickViaSelectionRoute hands the picker each run. `scope` is the whole constraint
// set as ONE value, passed through to the discovery tools untouched. Do not
// unpack it into per-field keys: a lock named in one list and forgotten in
// another silently stops being enforced on the agent path while the pool
// picker still honours it. See llm/internal/tools/picker/scope.ts.
export interface PickerRunArgs {
  scope: PickerScope;
  editorial?: string;
  // Forecast air time for the pick's link, prompt only — not a discovery
  // constraint, so it stays outside the scope.
  showAt?: Date | null;
}

export interface RequestRunArgs {
  scope: PickerScope;
  // Captured before the asynchronous request run so its prompt cannot switch
  // hosts halfway through and then relabel the resulting intro.
  persona: Persona | null;
  // Evidence requests may use only the web-backed local-identity tool. This
  // prevents a film/lyric miss from falling through to a random or mood
  // stand-in before the deterministic cascade gets a chance to refuse it.
  evidenceOnly?: boolean;
}

// What buildTools hands back for the caller to resolve the chosen id against.
export interface PickerExtras {
  seen: Map<string, any>;
  // Optional keeps test and third-party agent adapters source-compatible;
  // production picker tools always provide the collection.
  failures?: unknown[];
}

export const pickerAgent = defineAgent<PickerRunArgs, PickerExtras>({
  kind: 'djAgentPick',
  // Function form: resolved per run so the transition coaching follows the
  // on-air persona's djMode and the say length its scriptLength.
  schema: () => agenticDiscoverySchema(),
  // Advisory floor only — on the done-tool path the cap is DERIVED per provider
  // (gatedMaxStepsFor in provider/capabilities.ts), so this reaches the model
  // only as the Math.max floor on the native leg.
  maxSteps: 2,
  // Opt in to the per-provider discovery budget; it never applies implicitly,
  // since a caller's pinned step cap can be load-bearing.
  providerDiscoveryBudget: true,
  timeoutMs: agentDeadline,
  // Discovery deliberately has no Musical Leanings. They are applied exactly
  // once by the constrained final selector after this tool loop has surfaced
  // its real candidate set.
  buildSystem: ({ showAt, scope, editorial }) => pickSystem(showAt ?? null, !!scope?.playlistTracks?.length, false, { host: null, guest: null, promptValue: null })
    + (scope.episodeSource ? '\nLead with episodeArtistTracks; choose only the prepared artist catalogue.' : '')
    + (editorial ?? ''),
  buildTools: ({ scope }) => {
    const { tools, seen, failures } = buildPickerTools(scope);
    return { tools, extras: { seen, failures } };
  },
  // Native-path acceptance: the picked id must be one a discovery tool
  // surfaced this run. A fabricated id falls through to the done-tool harness
  // instead of surfacing as an unknown-id rejection.
  validateObject: (object, extras) => !!(object?.id && extras?.seen?.has(object.id)),
});

export const requestAgent = defineAgent<RequestRunArgs, PickerExtras>({
  kind: 'djAgentRequest',
  // Function form — resolved per run so the intro length follows the on-air
  // persona's scriptLength.
  schema: () => requestSchema(),
  maxSteps: 2,
  providerDiscoveryBudget: true,
  timeoutMs: agentDeadline,
  buildSystem: ({ persona, evidenceOnly }) => requestSystem(persona)
    + (evidenceOnly
      ? '\nThis is an evidence-only identification request. Use identifyRequestedTrack as the only discovery source. If it returns no candidates, do not choose a stand-in; return no track so the controller can report an honest no-match.'
      : ''),
  // resolveReferences adds the web-backed reference resolver (request path only;
  // no-op without a search provider) behind settings.llm.requestWebResolve.
  // Set here rather than at the call site: it is a property of THIS agent.
  buildTools: ({ scope, evidenceOnly }) => {
    const { tools, seen, failures } = buildPickerTools({
      ...scope,
      resolveReferences: settings.get().llm?.requestWebResolve ?? false,
    }, evidenceOnly ? { only: ['identifyRequestedTrack'] } : undefined);
    return { tools, extras: { seen, failures } };
  },
  // Same native-path acceptance as pickerAgent.
  validateObject: (object, extras) => !!(object?.id && extras?.seen?.has(object.id)),
});
