import { recordExtendedSleeveNoteTtsRequest, recordExtendedSleeveNoteTtsRendered,
  recordExtendedSleeveNoteAired, releaseExtendedSleeveNoteReservation } from './link-selection.js';
import { open } from './db.js';

function useIds(meta: Record<string, unknown>): string[] {
  return Array.isArray(meta.sleeveNotesSegmentUseIds)
    ? meta.sleeveNotesSegmentUseIds.filter((id): id is string => typeof id==='string').slice(0,4) : [];
}
export function releaseSleeveNotesSegment(meta: Record<string, unknown>): void {
  for (const id of useIds(meta)) releaseExtendedSleeveNoteReservation(id);
}
/** Called with the queue's normalized spoken text and confirmed live-edge time. */
export function recordSleeveNotesSegmentAir(meta: Record<string, unknown>, text: string, airedAt: number | null): void {
  if (airedAt===null) {releaseSleeveNotesSegment(meta);return;}
  const segment=meta.sleeveNotesSegment as {id?:unknown;index?:unknown;count?:unknown;speakerId?:unknown;speakerName?:unknown}|undefined;
  if (segment && typeof segment.id==='string' && segment.id.length<=100
    && Number.isInteger(segment.index) && Number.isInteger(segment.count)
    && (segment.index as number)>=0 && (segment.index as number)<(segment.count as number) && (segment.count as number)<=12
    && typeof segment.speakerId==='string' && typeof segment.speakerName==='string') {
    open().prepare(`INSERT INTO sleeve_segment_lines(segment_id,line_index,line_count,speaker_id,speaker_name,text,aired_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(segment_id,line_index) DO NOTHING`)
      .run(segment.id,segment.index,segment.count,segment.speakerId,segment.speakerName,text,new Date(airedAt).toISOString());
  }
  for (const id of useIds(meta)) {
    recordExtendedSleeveNoteTtsRequest(id,text);
    recordExtendedSleeveNoteTtsRendered(id);
    recordExtendedSleeveNoteAired(id,airedAt);
  }
}
