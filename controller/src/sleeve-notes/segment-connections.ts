import type Database from 'better-sqlite3';
import { zonedISODate, zonedParts, clockDisplay } from '../time.js';
import type { SleeveNoteSelectionCandidate } from './link-selection.js';

export interface EarlierDayConnection {
  title: string; artist: string; relationship: string;
  playedAt: string; stationTime: string;
  host: {id:string;name:string} | null;
}

/** Find the actual local-day boundary, including 23/25-hour daylight-saving days. */
export function stationDayStart(now: number): number {
  const today = zonedISODate(new Date(now));
  let before = now - 48 * 60 * 60_000, inside = now;
  while (inside - before > 1) {
    const middle = Math.floor((before + inside) / 2);
    if (zonedISODate(new Date(middle)) === today) inside = middle;
    else before = middle;
  }
  return inside;
}

/** Confirm both plays today; never infer playback or host from a researched edge. */
export function confirmedDayConnections(db: Database.Database, notes: readonly SleeveNoteSelectionCandidate[],
  localTrackId: string, now = Date.now()): EarlierDayConnection[] {
  const since = new Date(stationDayStart(now)).toISOString(), until = new Date(now).toISOString();
  const current = db.prepare(`SELECT encountered_at AS at FROM sleeve_encounters
    WHERE source='played' AND local_track_id=? AND encountered_at>=? AND encountered_at<=?
    ORDER BY encountered_at DESC LIMIT 1`).get(localTrackId,since,until) as {at:string}|undefined;
  if (!current) return [];
  const result: EarlierDayConnection[] = [], seen = new Set<string>();
  const lookup = db.prepare(`SELECT local.title,local.artist,encounter.encountered_at AS playedAt,
      encounter.host_id AS hostId,encounter.host_name AS hostName
    FROM sleeve_encounters encounter JOIN sleeve_local_attachments local
      ON local.local_track_id=encounter.local_track_id
    WHERE encounter.source='played' AND encounter.local_track_id=?
      AND encounter.encountered_at>=? AND encounter.encountered_at<?
    ORDER BY encounter.encountered_at DESC LIMIT 1`);
  for (const note of notes) for (const other of note.connection?.tracks ?? []) {
    if (result.length >= 2 || other.id === localTrackId || seen.has(other.id)) continue;
    const played = lookup.get(other.id,since,current.at) as {
      title:string;artist:string;playedAt:string;hostId:string|null;hostName:string|null;
    }|undefined;
    if (!played) continue;
    seen.add(other.id);
    const localTime = zonedParts(new Date(played.playedAt));
    result.push({title:played.title,artist:played.artist,relationship:note.fullWording,
      playedAt:played.playedAt,stationTime:clockDisplay(localTime.hour,localTime.minute,false),
      host:played.hostId && played.hostName ? {id:played.hostId,name:played.hostName} : null});
  }
  return result;
}
