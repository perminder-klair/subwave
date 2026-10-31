// Resolve discovery hits into one ordered selection unit before model choice.
// A Flow's entry supplies musical transition facts; its total supplies scheduling cost.
import * as library from './library.js';
import * as blocklist from './blocklist.js';
import * as subFlows from './sub-flow.js';
import { applyStrictLocks } from './show-filter.js';
import { creditInRoots, trackKey } from './recency.js';
import type { PickerScope } from '../llm/tools.js';
import { albumKeyFor } from './album-facts.js';
import type { Flow } from './sub-flow.js';
import { fadeAtShowEndActive, nextShowBoundaryMs } from '../broadcast/show-boundary.js';

export interface FlowSelection {
  id: string;
  revision: number;
  name: string;
  tracks: Array<Pick<Flow['tracks'][number], 'id' | 'title' | 'artist' | 'album' | 'duration'>>;
  duration: number;
}

export function flowSelectionFits(duration: number, startMs: number): boolean {
  return !fadeAtShowEndActive(new Date(startMs))
    || nextShowBoundaryMs(startMs, duration) == null;
}

export function selectionFlows<T extends { id?: string | null; subFlow?: FlowSelection }>(
  candidates: T[], scope: PickerScope,
  flows = subFlows.list(), lookup: typeof library.get = library.get,
): Array<T & { subFlow?: FlowSelection }> {
  if (!scope.automaticFlows) return candidates;
  if (!flows.some(flow => flow.enabled)) return candidates.filter(candidate => !candidate.subFlow);
  const byTrack = new Map(flows.filter(flow => flow.enabled).flatMap(flow => flow.tracks.map(track => [track.id, flow] as const)));
  const emitted = new Set<string>();
  return candidates.flatMap(candidate => {
    const flow = candidate.id ? byTrack.get(candidate.id) : null;
    if (!flow) return candidate.subFlow ? [] : [candidate];
    if (candidate.subFlow && (candidate.subFlow.id !== flow.id || candidate.subFlow.revision !== flow.revision)) return [];
    if (emitted.has(flow.id)) return [];
    emitted.add(flow.id);
    if (scope.flowUnavailable || flow.verification !== 'verified' || !flow.orderVerified
      || flow.tracks.some(track => !track.fingerprint)) return [];
    const members = flow.tracks.map(track => ({ ...lookup(track.id), ...track, duration: track.fingerprint!.decodedSeconds }));
    const duration = members.reduce((sum, track) => sum + track.duration, 0);
    if (!Number.isFinite(duration) || duration <= 0 || (scope.minTrackSec && duration < scope.minTrackSec)) return [];
    // Never cut a protected member, even under the station's legacy cut mode.
    if (!scope.flowAllowAboveMax && scope.flowMaxTrackSec
      && members.some(track => track.duration > scope.flowMaxTrackSec!)) return [];
    if (members.some(track => blocklist.hitOf(track)
      || creditInRoots(track, scope.flowAvoidArtistRoots) || scope.flowRecentAlbums.has(albumKeyFor(track))
      || scope.recentIds.has(track.id) || scope.recentKeys.has(trackKey(track))
      || scope.hardRecentIds.has(track.id) || scope.hardRecentKeys.has(trackKey(track))
      || scope.excludedIds?.has(track.id)
      || (scope.playlistLock && !scope.playlistLock.has(track.id))
      || (scope.episodeSource && !scope.episodeSource.ids.has(track.id)))) return [];
    if (applyStrictLocks(members, {
      genres: scope.genreLock, eras: scope.eraLock, moods: scope.moodLock,
      energies: scope.energyLock, vocals: scope.vocalLock,
    }, { starve: true }).length !== members.length) return [];
    if (!flowSelectionFits(duration, scope.flowStartMs ?? Date.now())) return [];
    const first = members[0]!;
    // Do not copy a companion's tempo, key or similarity onto the actual entry.
    const entry = first.id === candidate.id ? { ...candidate, ...first } : first;
    return [{ ...entry, subFlow: { id: flow.id, revision: flow.revision, name: flow.name, tracks: members.map(({ id, title, artist, album, duration }) => ({ id, title, artist, album, duration })), duration } } as T & { subFlow: FlowSelection }];
  });
}

export function flowForPrompt(flow: FlowSelection | undefined) {
  return flow ? { name: flow.name, duration: flow.duration,
    tracks: flow.tracks.map(({ id, title, artist, album }) => ({ id, title, artist, album })) } : undefined;
}
