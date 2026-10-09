import { tool } from 'ai';
import { z } from 'zod';
import * as library from '../../../../../music/library.js';
import { definePickerTool } from '../defs.js';

// Only registered while a sonic journey is active (the event message tells the
// agent when that is). Closes over the journey's current waypoint, so calling it
// returns the tracks that carry the sound one step along the arc toward the
// destination vibe.
export default definePickerTool({
  name: 'tracksTowardJourney',
  available: ({ scope, hasAudioEmbeddings }) =>
    !!(scope.audioWaypoint && scope.audioWaypoint.length && hasAudioEmbeddings),
  build: ({ collect, emptyResult, scope, knnExclude }) => tool({
    description: 'Tracks nearest the active sonic journey\'s CURRENT waypoint — the station is mid-arc, drifting its sound toward a destination vibe over the next few picks. When the event says a journey is active, call this and strongly prefer one of its tracks: each one moves the sound a step along the arc. Takes no input.',
    inputSchema: z.object({}),
    // Pull a wide KNN (60) around the waypoint: the nearest neighbours cluster
    // tightly and many will be recently-played, so a small k left the agent with
    // ~1 candidate. collect() still caps to 8 fresh ones.
    execute: async () => {
      try {
        await library.load();
        const list = library.tracksByAudioVector(scope.audioWaypoint as number[], 60, { excludeIds: knnExclude });
        const out = collect(list, 8, { similarity: { kind: 'audio', reference: 'journey waypoint' } });
        return out.length ? out : emptyResult(list.length, 'the journey has no fresh tracks near this waypoint — pick via the library mood/genre/audio tools and keep the energy heading the same way');
      }
      catch (err) { return { error: (err as Error).message }; }
    },
  }),
});
