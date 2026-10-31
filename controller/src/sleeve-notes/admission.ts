// Stage 1 of Extended Sleeve Notes. This is deliberately a local, durable
// admission only: queueing or playing music must never wait for matching or a
// provider request.
import * as settings from '../settings.js';
import { admitLocalEncounter } from './research-repository.js';

export interface SleeveNotesEncounter {
  localTrackId?: string | null;
  title?: string | null;
  artist?: string | null;
  releaseTitle?: string | null;
  musicbrainzRecordingId?: string | null;
  autopilot?: boolean;
  listenerPresent?: boolean;
  encounteredAt?: string;
  host?: {id:string;name:string} | null;
}

export function admitSleeveNotesEncounter(input: SleeveNotesEncounter, source: 'queue' | 'played', priority = 0,
  autopilot = false): void {
  // This master switch continues to be the operator's consent for all Sleeve
  // Notes collection. MusicBrainz itself is public; Genius additionally has
  // its own provider switch and access token.
  if (settings.get().djBehaviour.extendedSleeveNotes !== true) return;
  const localTrackId = String(input.localTrackId ?? '').trim();
  const title = String(input.title ?? '').trim();
  if (!localTrackId || !title) return;
  admitLocalEncounter({
    localTrackId,
    title,
    artist: input.artist?.trim() || null,
    releaseTitle: input.releaseTitle?.trim() || null,
    musicbrainzRecordingId: input.musicbrainzRecordingId?.trim() || null,
    source,
    priority,
    autopilot,
    listenerPresent: input.listenerPresent,
    encounteredAt: input.encounteredAt,
    host: input.host,
  });
}
