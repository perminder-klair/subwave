// Routes App Intents (modules/app-intents) to the code that performs them.
// Registered from index.ts beside the playback service rather than from a
// screen, because an intent can launch the app into the background before any
// screen mounts.

import { setIntentHandler } from '../../modules/app-intents';
import { likeHeardTrack, whatsPlaying } from './on-air';
import { askForSong } from './request-reply';
import { activeStation, NO_STATION_MESSAGE } from './station';
import { tuneIn, tuneOut } from './tune';

export function registerIntentHandlers(): void {
  setIntentHandler(async (action, args) => {
    switch (action) {
      case 'tuneIn':
        return tuneIn(args.station);
      case 'tuneOut':
        return tuneOut();
      case 'request':
      case 'nowPlaying':
      case 'like': {
        const station = await activeStation();
        if (!station) return { ok: false, message: NO_STATION_MESSAGE };
        if (action === 'request') return askForSong(args.text ?? '', { api: station.api });
        if (action === 'nowPlaying') return whatsPlaying(station);
        return likeHeardTrack(station);
      }
      default:
        return { ok: false, message: 'Update SUB/WAVE to use this.' };
    }
  });
}
