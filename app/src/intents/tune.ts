// Tune in and out on behalf of an App Intent (Siri, Shortcuts, Spotlight, a
// Control), including to another saved station.
// Module-level, not a hook: an intent can launch the app straight into the
// background, where this runs before any screen has mounted, or with none
// mounting at all. usePlayer adopts the audio when it does mount.

import TrackPlayer, { Event, State } from 'react-native-track-player';
import type { IntentReply } from '../../modules/app-intents';
import { isLiveActivitySupported, onLiveActivityStart } from '../../modules/live-activity';
import { externalTuneOut, getLastLiveMeta, loadAndPlay, teardown } from '@/audio/player';
import { announceStationStoreChanged, loadStations, setActiveStation } from '@/lib/station';
import { splitStationAddress, type StoredStationRef } from '@/lib/station-credentials';
import { findSavedStation } from '@/lib/station-store';
import { activeStation, NO_STATION_MESSAGE } from './station';

// How long a tune-in waits for audio before answering. Long enough that a
// refused or unreachable stream is reported to Siri rather than silently
// failing; short enough to stay inside the bridge's reply window.
const START_WAIT_MS = 8000;

// How long a tune-in holds its answer, once audio is playing, for
// useLiveActivity to put the card up. ActivityKit only starts one for a
// background app inside a LiveActivityIntent's run (TuneInIntent is one), so
// answering first would close that window. Past the cap, the card comes up
// the next time the app is opened.
const CARD_WAIT_MS = 2000;

const ON_AIR = new Set<State>([State.Playing, State.Buffering, State.Loading]);

const NOT_SAVED_MESSAGE = "That station isn't saved in SUB/WAVE. Add it in the app first.";

/** Tune in to `stationId` (a saved station's base, as Siri and Spotlight know
 *  it), or to the station listened to last when there is none. */
export async function tuneIn(stationId?: string): Promise<IntentReply> {
  if (stationId) {
    const store = await loadStations();
    const wanted = findSavedStation(store.recents, stationId);
    if (!wanted) return { ok: false, message: NOT_SAVED_MESSAGE };
    const active = store.activeStation ? splitStationAddress(store.activeStation).base : null;
    if (splitStationAddress(wanted.url).base !== active) return switchTo(wanted);
  }

  const { state } = await TrackPlayer.getPlaybackState().catch(() => ({ state: State.None }));
  if (ON_AIR.has(state)) return { ok: true };

  // Warm: the same reload a lock-screen Play does (service.ts).
  const meta = getLastLiveMeta();
  if (meta) return startAndWait(() => loadAndPlay(meta), null);

  // Cold, or after an in-app stop: rebuild the stream from the stored
  // station, as StationContext does at boot. Always the MP3 mount: a stored
  // format preference is only honoured once the station's feed confirms the
  // mount, and usePlayer retunes onto it when the feed loads.
  const station = await activeStation();
  if (!station) return { ok: false, message: NO_STATION_MESSAGE };
  const { api } = station;
  return startAndWait(
    () => loadAndPlay({ url: api.streamUrl('mp3'), headers: api.streamHeaders() }),
    station.name,
  );
}

/** Another saved station. The store is written and the old stream stopped
 *  first, and StationContext is told only once the new stream is loaded: by
 *  the time the screens' base changes, the stream playing belongs to it, so
 *  usePlayer keeps it instead of stopping a stale one. */
async function switchTo(ref: StoredStationRef): Promise<IntentReply> {
  await setActiveStation({ url: ref.url, name: ref.name });
  await teardown();
  const station = await activeStation();
  if (!station) return { ok: false, message: NO_STATION_MESSAGE };
  const { api } = station;
  return startAndWait(async () => {
    try {
      await loadAndPlay({ url: api.streamUrl('mp3'), headers: api.streamHeaders() });
    } finally {
      // The station switched even if its stream did not start.
      announceStationStoreChanged();
    }
  }, station.name);
}

export async function tuneOut(): Promise<IntentReply> {
  await externalTuneOut().catch(() => {});
  return { ok: true };
}

async function startAndWait(
  start: () => Promise<void>,
  stationName: string | null,
): Promise<IntentReply> {
  // Listen before starting so a fast Playing, or a fast card, is not missed.
  const outcome = untilPlaying();
  const card = untilCardStarts();
  try {
    await start();
  } catch {
    outcome.cancel();
    card.cancel();
    return failed(stationName);
  }
  if (!(await outcome.result)) {
    card.cancel();
    return failed(stationName);
  }
  await card.result;
  return { ok: true };
}

/** Settles on the next Live Activity start attempt, whatever its outcome,
 *  or at the cap. Immediately where there is no card to wait for. */
function untilCardStarts(): { result: Promise<void>; cancel: () => void } {
  if (!isLiveActivitySupported()) return { result: Promise.resolve(), cancel: () => {} };
  let settle: () => void = () => {};
  const result = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const unsubscribe = onLiveActivityStart(() => done());
  const timer = setTimeout(done, CARD_WAIT_MS);
  let finished = false;
  function done() {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    unsubscribe();
    settle();
  }
  return { result, cancel: done };
}

function failed(stationName: string | null): IntentReply {
  const station = stationName ?? 'the station';
  return {
    ok: false,
    message: `Couldn't reach ${station}. If it's private, open SUB/WAVE to unlock it.`,
  };
}

/** True on Playing; false on an error. Still buffering when the wait runs out
 *  counts as started: the player keeps trying, and usePlayer's watchdog takes
 *  over once a screen mounts. */
function untilPlaying(): { result: Promise<boolean>; cancel: () => void } {
  let settle: (ok: boolean) => void = () => {};
  const result = new Promise<boolean>((resolve) => {
    settle = resolve;
  });
  const subs = [
    TrackPlayer.addEventListener(Event.PlaybackState, ({ state }) => {
      if (state === State.Playing) done(true);
      else if (state === State.Error) done(false);
    }),
    TrackPlayer.addEventListener(Event.PlaybackError, () => done(false)),
  ];
  const timer = setTimeout(() => done(true), START_WAIT_MS);
  let finished = false;
  function done(ok: boolean) {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    subs.forEach((s) => s.remove());
    settle(ok);
  }
  return { result, cancel: () => done(false) };
}
