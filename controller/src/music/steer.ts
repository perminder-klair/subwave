// What the pick paths see as the show while a steer runs. Only the MUSIC side
// is overlaid: which show is on air (its persona, session, theme, programme)
// is unchanged, and every identity reader keeps settings.resolveActiveShow.
//
// A playlist steer reuses the show playlist anchor as it stands (strict, full
// rotation), so both pickers confine and rotate it through the machinery they
// already have. The show's own filters and playlists are set aside for the
// duration: the steer outranks them.
import { steerClause, type Steer } from '../schemas/steer.js';

// The shape a pick path reads when a playlist is steered with no show on air.
const NO_SHOW = {
  id: null,
  name: 'Steer',
  topic: '',
  persona: null,
  guests: [],
  maxTrackSeconds: null,
  minTrackLengthSeconds: null,
  fadeAtShowEnd: null,
};

export function steeredShow<T extends Record<string, any>>(show: T | null | undefined, steer: Steer | null | undefined): any {
  // A prompt-only steer changes no field: it reaches the model as text.
  if (!steer?.playlistId) return show ?? null;
  return {
    ...(show ?? NO_SHOW),
    playlistIds: [steer.playlistId],
    playlistStrict: true,
    playlistExhaust: true,
    playlistInOrder: false,
    excludedPlaylistIds: [],
    moods: [],
    genres: [],
    eras: [],
    energies: [],
    vocals: '',
    filtersStrict: false,
  };
}

// The agent picker's messages with the steer on the last user turn. Added to
// this one call's copy and never stored on the session: the same window is
// read by the request agent, next to a listener's own words, and outlives a
// cleared steer.
export function withSteer<T extends { role: string; content: string }>(messages: T[], prompt: string | null | undefined): T[] {
  const clause = steerClause(prompt);
  if (!clause) return messages;
  const last = messages.at(-1);
  if (last?.role === 'user') last.content += clause;
  else messages.push({ role: 'user', content: clause.trim() } as T);
  return messages;
}

// Everything that reads the stored steer and then writes it (Start, Clear, a
// takeover starting, the janitor) runs one at a time, so none of them can act
// on a steer another has just replaced.
let chain: Promise<unknown> = Promise.resolve();
export function serialSteer<T>(work: () => Promise<T>): Promise<T> {
  const run = chain.then(work);
  chain = run.catch(() => {});
  return run;
}
