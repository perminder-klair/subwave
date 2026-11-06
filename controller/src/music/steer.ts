// What the pick paths see as the show while a steer runs. Only the MUSIC side
// is overlaid: which show is on air (its persona, session, theme, programme)
// is unchanged, and every identity reader keeps settings.resolveActiveShow.
//
// A playlist steer reuses the show playlist anchor as it stands (strict, full
// rotation), so both pickers confine and rotate it through the machinery they
// already have. The show's own filters and playlists are set aside for the
// duration: the steer outranks them.
import { steerClause, type Steer } from '../schemas/steer.js';
import { echoesRequest } from '../util/request-guard.js';

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

// A prepared artist episode under a steer, decided once for every pick path
// (dj-agent.ts livePickerScope, picker.ts pickViaPool). An episode replaces the
// whole pool, so a steered playlist sets it aside, or the steer would do
// nothing on a show that prepared one; its editorial brief goes with it, or the
// model would be told to follow an artist the candidates are not by. `read` is
// the show preparation's own reading of the episode's tracks.
export function episodeUnderSteer<C extends object, E>(
  context: C,
  steer: Pick<Steer, 'playlistId'> | null | undefined,
  read: (context: C) => E | null,
): { episodeSource: E | null; context: C } {
  if (!steer?.playlistId) return { episodeSource: read(context), context };
  return { episodeSource: null, context: { ...context, episodeEditorial: '' } };
}

// How many of a steer's opening tracks it has time for: each one that would
// START before the steer ends. The rest would only wait in the queue to be
// taken back when it runs out (scheduler.ts steerJanitor). `leadSec` is how
// long until the first of them starts (queue.secondsUntilQueuedTail); an
// unmeasured lead or length stops the count from shrinking the list past it,
// because a guess is worse than the janitor's tidy-up. Never more than given.
export function openingTracksThatFit(
  lengthsSec: ReadonlyArray<number | null | undefined>,
  leadSec: number | null,
  windowSec: number,
): number {
  if (leadSec == null) return lengthsSec.length;
  let startsInSec = leadSec;
  for (const [i, length] of lengthsSec.entries()) {
    if (startsInSec >= windowSec) return i;
    const sec = Number(length);
    if (!Number.isFinite(sec) || sec <= 0) return lengthsSec.length;
    startsInSec += sec;
  }
  return lengthsSec.length;
}

// The steer's introduction may say where the music is heading in the host's
// own words, never read the operator's line out. A run this long of the
// operator's own words is that line read out; a shorter direction ("more
// 2020s pop") has no wording of its own to give away.
const STEER_ECHO_MIN_RUN = 6;
export function echoesSteer(line: string | null | undefined, direction: string | null | undefined): boolean {
  return echoesRequest(line, direction, { minRun: STEER_ECHO_MIN_RUN });
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
