// Non-airing paired discovery comparison.
//
// Usage (inside the controller container, against one saved replay trace):
//   npx tsx scripts/shortlist-paired-compare.ts /var/sub-wave/trace.json
//
// It does not enqueue, write settings, or alter queue/session state. The
// legacy route makes its normal three model-led discovery rounds; the native
// route makes three controller-led source passes. Both use the trace's frozen
// scope and print only the tool/source and tracks it returned.

import { readFileSync } from 'node:fs';
import * as settings from '../src/settings.js';
import { pickerScope } from '../src/llm/tools.js';
import { pickerAgent } from '../src/broadcast/dj-agent/agents.js';
import { buildShortlist } from '../src/music/shortlist.js';

type Trace = any;
type Row = { route: string; round: number; source: string; tracks: string };

function scopeFrom(trace: Trace) {
  const scope = trace?.scope || {};
  return pickerScope({
    recentIds: new Set(scope.recentIds || []),
    recentKeys: new Set(scope.recentKeys || []),
    hardRecentIds: new Set(scope.hardRecentIds || []),
    hardRecentKeys: new Set(scope.hardRecentKeys || []),
    genreLock: scope.genreLock || null,
    eraLock: scope.eraLock || null,
    moodLock: scope.moodLock || null,
    energyLock: scope.energyLock || null,
    vocalLock: scope.vocalLock || null,
    playlistLock: scope.playlistLock ? new Set(scope.playlistLock) : null,
    playlistTracks: scope.playlistTracks || null,
    excludedIds: scope.excludedIds ? new Set(scope.excludedIds) : null,
    audioWaypoint: scope.audioWaypoint || null,
  });
}

function tracksOf(result: any): string {
  const tracks = Array.isArray(result) ? result : result?.tracks;
  if (!Array.isArray(tracks) || !tracks.length) return '—';
  return tracks
    .filter((track: any) => track?.id)
    .map((track: any) => `${track.artist || 'Unknown'} — ${track.title || track.id}`)
    .join('\n');
}

function markdown(rows: Row[]) {
  console.log('| Route | Round/pass | Tool or candidate source | Returned tracks |');
  console.log('| --- | ---: | --- | --- |');
  for (const row of rows) {
    console.log(`| ${row.route} | ${row.round} | ${row.source} | ${row.tracks.replaceAll('\n', '<br>')} |`);
  }
}

async function main() {
  const tracePath = process.argv[2];
  if (!tracePath) throw new Error('usage: npx tsx scripts/shortlist-paired-compare.ts <replay-trace.json>');
  const trace = JSON.parse(readFileSync(tracePath, 'utf8'));
  const scope = scopeFrom(trace);
  await settings.load();

  // The comparison fixes both routes at three discovery opportunities without
  // touching persisted operator settings.
  const llm = settings.get().llm;
  const priorSteps = llm.discoverySteps;
  const priorFallbackSteps = llm.fallback?.discoverySteps;
  llm.discoverySteps = 3;
  if (llm.fallback) llm.fallback.discoverySteps = 3;
  try {
    const messages = [{
      role: 'user',
      content: `Pick a next track after ${trace.currentTrack?.artist || 'the current artist'} — ${trace.currentTrack?.title || 'the current track'}. Explore the library before deciding.`,
    }];
    const legacy = await pickerAgent.run({ scope, messages });
    const native = await buildShortlist({
      scope,
      currentTrackId: trace.currentTrack?.id || null,
      discoveryPasses: 3,
      moods: trace.show?.moods || null,
      energies: trace.show?.energies || null,
    });
    const rows: Row[] = [
      ...legacy.toolCalls.map((call: any, index: number) => ({
        route: 'Agentic Picker', round: call.round || index + 1, source: call.name || 'unknown', tracks: tracksOf(call.result),
      })),
      ...native.sourceRuns.map((run, index) => ({
        route: 'Track Shortlist', round: index + 1, source: run.source,
        tracks: run.tracks?.map(track => `${track.artist || 'Unknown'} — ${track.title || track.id}`).join('\n') || '—',
      })),
    ];
    markdown(rows);
  } finally {
    llm.discoverySteps = priorSteps;
    if (llm.fallback) llm.fallback.discoverySteps = priorFallbackSteps;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
