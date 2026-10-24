import type Database from 'better-sqlite3';
import { countExtendedSleeveNoteCandidatesInDatabase } from './link-selection.js';
import { open } from './db.js';

type Track = { id?: string | null; subsonic_id?: string; title?: string | null; artist?: string | null; album?: string | null; artistId?: string | null; albumId?: string | null };
export type LiveNotesItem = { track: Track; sleeveClaimUseId?: string | null; introScript?: string | null; introKind?: string; startedAt?: string; queuedAt?: string };

/** A read-only view of the actual queue item and its exact Spark reservation.
 * Never match an earlier play by artist/title, and never select or reserve a Spark. */
export function liveNotesSummary(nowPlaying: Track | null, current: LiveNotesItem | null, next: LiveNotesItem | null, db: Database.Database = open()) {
  const hasUses = !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='sleeve_claim_uses'").get();
  const columns = hasUses ? new Set((db.prepare('PRAGMA table_info(sleeve_claim_uses)').all() as Array<{ name: string }>).map(row => row.name)) : new Set<string>();
  const optional = (name: string) => columns.has(name) ? `u.${name}` : 'NULL';
  const readSpark = hasUses ? db.prepare(`SELECT u.offered_wording AS wording, u.aired_at AS airedAt,
    ${optional('tts_rendered_at')} AS renderedAt, ${optional('tts_text')} AS spokenText,
    ${optional('speech_signal')} AS speechSignal, u.dj_context_pass_reason AS passReason,
    u.dj_quality_rejection_reason AS qualityConcern,
    c.entity_type AS entityType,c.entity_id AS entityId,s.source_url AS sourceUrl
    FROM sleeve_claim_uses u JOIN sleeve_claims c ON c.id=u.claim_id
    JOIN sleeve_source_documents s ON s.id=c.source_document_id WHERE u.id=? AND u.local_track_id=?`) : null;
  const summarise = (item: LiveNotesItem | null, fallback?: Track | null) => {
    const track = fallback ?? item?.track;
    if (!track) return null;
    const id = track.subsonic_id ?? track.id ?? null;
    const spark = item?.sleeveClaimUseId && id ? readSpark?.get(item.sleeveClaimUseId, id) as {
      wording: string; airedAt: string | null; renderedAt: string | null; spokenText: string | null;
      speechSignal: string | null; passReason: string | null; qualityConcern: string | null;
      entityType: string; entityId: string; sourceUrl: string;
    } | undefined : undefined;
    let factDetected = false;
    try { const signal = JSON.parse(spark?.speechSignal ?? 'null'); factDetected = [1,2].includes(signal?.version) && signal?.status === 'detected'; } catch { /* Older rows may have no usable speech signal. */ }
    return { track: { id, title: track.title ?? '', artist: track.artist ?? '', album: track.album ?? '',
      artistId: track.artistId ?? item?.track.artistId ?? null, albumId: track.albumId ?? item?.track.albumId ?? null },
      availability: !spark && id ? countExtendedSleeveNoteCandidatesInDatabase(db, id, track.artist) : null,
      djLine: spark?.spokenText || item?.introScript || null,
      spark: spark ? { wording: spark.wording, airedAt: spark.airedAt, renderedAt: spark.renderedAt,
        passReason: spark.passReason, qualityConcern: spark.qualityConcern, factDetected,
        entityType: spark.entityType, entityId: spark.entityId, sourceUrl: spark.sourceUrl } : null };
  };
  const playingId = nowPlaying?.subsonic_id ?? nowPlaying?.id;
  // Metadata and queue can cross a boundary on adjacent polls. Keep the real
  // on-air title, but don't attach the outgoing item's speech to it.
  const matchedCurrent = playingId && current?.track.id === playingId ? current : null;
  return { onAir: summarise(matchedCurrent, nowPlaying), nextUp: summarise(next) };
}
