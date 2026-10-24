import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { open } from './db.js';
import { candidateFingerprint } from './moderation.js';
import { sparkFeedbackSchema } from '../schemas/sleeve-notes-feedback.js';
import type { ResearchCandidate } from './researcher.js';

type Feedback = z.infer<typeof sparkFeedbackSchema>;
type AiredUse=Record<string,unknown>&{id:string;segmentId:string|null;spokenText:string;
  artist:string|null;title:string|null;wordingAtOffer:string;offeredWording:string};
// Only actual rendered-and-aired speech belongs here. Wording detection is information, never eligibility.
const ELIGIBLE = `u.aired_at IS NOT NULL AND u.tts_rendered_at IS NOT NULL AND u.tts_text IS NOT NULL`;

export function heardOnAir(limit = 20, offset = 0, groupConversations = false, filters: {search?: string; kind?: string; period?: string; usage?: string} = {}, db: Database.Database = open()) {
  const columns = new Set((db.prepare('PRAGMA table_info(sleeve_claim_uses)').all() as Array<{ name: string }>).map(row => row.name));
  const empty = { items: [], total: 0, conversationTotal: 0, limit, offset, feedbackTotals: { story: [], delivery: [] } };
  if (!columns.has('speech_signal') || !columns.has('tts_rendered_at')) return empty;
  const hasFeedback = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sleeve_spark_feedback'").get();
  const groupKey=columns.has('segment_id') ? "COALESCE('segment:' || u.segment_id, 'use:' || u.id)" : "'use:' || u.id";
  const hasLines=!!db.prepare("SELECT 1 FROM sqlite_master WHERE name='sleeve_segment_lines'").get();
  const detected = "CASE WHEN json_valid(u.speech_signal) THEN COALESCE(json_extract(u.speech_signal,'$.status')='detected',0) ELSE 0 END";
  const conditions: string[] = [], values: string[] = [];
  if(filters.usage==='sleeve-notes') {
    conditions.push(`${groupKey} IN (SELECT ${groupKey} FROM sleeve_claim_uses u
      WHERE ${ELIGIBLE} AND (u.consumer='sleeveNotesSegment' OR ${detected}=1))`);
  }
  if (filters.usage === 'detected' || filters.usage === 'not-detected') {
    conditions.push(`${groupKey} ${filters.usage === 'not-detected' ? 'NOT IN' : 'IN'} (
      SELECT ${groupKey} FROM sleeve_claim_uses u WHERE ${ELIGIBLE} AND ${detected}=1)`);
  }
  const search = (filters.search ?? '').trim().slice(0, 120);
  if (search) {
    conditions.push(`(instr(lower(COALESCE(${columns.has('track_artist') ? 'u.track_artist,' : ''} a.artist, '') || ' ' ||
      COALESCE(${columns.has('track_title') ? 'u.track_title,' : ''} a.title, '') || ' ' || u.tts_text || ' ' || u.offered_wording), lower(?)) > 0
      ${hasLines && columns.has('segment_id') ? `OR EXISTS (SELECT 1 FROM sleeve_segment_lines l WHERE l.segment_id=u.segment_id AND instr(lower(l.text),lower(?))>0)` : ''})`);
    values.push(search);
    if (hasLines && columns.has('segment_id')) values.push(search);
  }
  if (filters.kind === 'segment') conditions.push("u.consumer='sleeveNotesSegment'");
  if (filters.kind === 'link') conditions.push("COALESCE(u.consumer,'')<>'sleeveNotesSegment'");
  const hours = filters.period === '24h' ? 24 : filters.period === '7d' ? 168 : filters.period === '30d' ? 720 : 0;
  if (hours) { conditions.push('u.aired_at >= ?'); values.push(new Date(Date.now() - hours * 3600000).toISOString()); }
  // Match before pagination, then retain every offered Spark in a matching segment.
  const eligible = conditions.length ? `${ELIGIBLE} AND ${groupKey} IN (
    SELECT ${groupKey} FROM sleeve_claim_uses u LEFT JOIN sleeve_local_attachments a ON a.local_track_id=u.local_track_id
    WHERE ${ELIGIBLE} AND ${conditions.join(' AND ')})` : ELIGIBLE;
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM sleeve_claim_uses u WHERE ${eligible}`).get(...values) as {n:number}).n;
  const conversationTotal=(db.prepare(`SELECT COUNT(DISTINCT ${groupKey}) AS n FROM sleeve_claim_uses u WHERE ${eligible}`).get(...values) as {n:number}).n;
  const page=groupConversations
    ? `AND ${groupKey} IN (SELECT ${groupKey} FROM sleeve_claim_uses u WHERE ${eligible}
        GROUP BY ${groupKey} ORDER BY MAX(u.aired_at) DESC, MAX(u.id) DESC LIMIT ? OFFSET ?)`
    : '';
  const items = db.prepare(`SELECT u.id, u.consumer, ${columns.has('segment_id')?'u.segment_id':'NULL'} AS segmentId, u.claim_id AS claimId, u.local_track_id AS localTrackId,
    u.entity_type AS entityType, u.entity_id AS entityId, u.aired_at AS airedAt,
    ${columns.has('track_artist') ? 'COALESCE(u.track_artist, a.artist)' : 'a.artist'} AS artist,
    ${columns.has('track_title') ? 'COALESCE(u.track_title, a.title)' : 'a.title'} AS title, u.offered_wording AS offeredWording,
    ${columns.has('claim_wording_at_offer') ? 'COALESCE(u.claim_wording_at_offer, u.offered_wording)' : 'u.offered_wording'} AS wordingAtOffer,
    u.tts_text AS spokenText,
    ${detected} AS sparkDetected, c.wording AS currentWording, c.enabled, c.operator_state AS operatorState,
    s.source_url AS sourceUrl, s.attribution, s.provider,
    ${hasFeedback ? 'f.story, f.delivery, f.note, f.updated_at AS feedbackAt' : 'NULL AS story, NULL AS delivery, NULL AS note, NULL AS feedbackAt'}
    FROM sleeve_claim_uses u JOIN sleeve_claims c ON c.id = u.claim_id
    JOIN sleeve_source_documents s ON s.id = c.source_document_id
    LEFT JOIN sleeve_local_attachments a ON a.local_track_id = u.local_track_id
    ${hasFeedback ? 'LEFT JOIN sleeve_spark_feedback f ON f.use_id = u.id' : ''}
    WHERE ${groupConversations?ELIGIBLE:eligible} ${page} ORDER BY u.aired_at DESC, u.id DESC ${groupConversations?'':'LIMIT ? OFFSET ?'}`).all(...values, limit, offset) as AiredUse[];
  const transcripts=new Map<string,unknown>();
  for(const item of items) {
    if (!hasLines || !item.segmentId) {item.conversation=null;continue;}
    if (!transcripts.has(item.segmentId)) {
      const lines=db.prepare(`SELECT line_index AS lineIndex,line_count AS lineCount,speaker_id AS speakerId,
        speaker_name AS speakerName,text,aired_at AS airedAt FROM sleeve_segment_lines WHERE segment_id=? ORDER BY line_index`)
        .all(item.segmentId) as Array<{lineIndex:number;lineCount:number;speakerId:string;speakerName:string;text:string;airedAt:string}>;
      const expectedLines=lines[0]?.lineCount??0;
      transcripts.set(item.segmentId,lines.length?{id:item.segmentId,expectedLines,
        complete:lines.length===expectedLines&&lines.every((line,index)=>line.lineIndex===index),lines}:null);
    }
    item.conversation=transcripts.get(item.segmentId);
  }
  const counts = (field: 'story' | 'delivery') => hasFeedback ? db.prepare(`SELECT f.${field} AS value, COUNT(*) AS count
    FROM sleeve_spark_feedback f JOIN sleeve_claim_uses u ON u.id = f.use_id
    WHERE ${ELIGIBLE} AND f.${field} IS NOT NULL GROUP BY f.${field}`).all() : [];
  return { items, total, conversationTotal, limit, offset, feedbackTotals: { story: counts('story'), delivery: counts('delivery') } };
}

export function saveSparkFeedback(useId: string, value: Feedback) {
  const feedback = sparkFeedbackSchema.parse(value);
  const db = open();
  return db.transaction(() => {
    const claim = db.prepare(`SELECT c.*, COALESCE(u.claim_wording_at_offer, u.offered_wording) AS wording_at_offer FROM sleeve_claim_uses u
      JOIN sleeve_claims c ON c.id = u.claim_id WHERE u.id = ? AND ${ELIGIBLE}`).get(useId) as {
        id: string; source_document_id: string; entity_type: string; entity_id: string;
        category: ResearchCandidate['category']; topic: string; wording: string; evidence: string; short_wording: string; wording_at_offer: string; operator_state: string;
      } | undefined;
    if (!claim) return false;
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO sleeve_spark_feedback (use_id, story, delivery, note, actor, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(use_id) DO UPDATE SET story = excluded.story,
      delivery = excluded.delivery, note = excluded.note, actor = excluded.actor, updated_at = excluded.updated_at`)
      .run(useId, feedback.story, feedback.delivery, feedback.note, process.env.ADMIN_USER || 'local-admin', now, now);
    const flagged = ['unclear', 'incorrect', 'wrong-subject'].includes(feedback.story ?? '');
    const unchanged = claim.wording.trim() === claim.wording_at_offer.trim();
    const review = flagged && unchanged && claim.operator_state !== 'deleted';
    if (review) {
      const candidate: ResearchCandidate = { category: claim.category, topic: claim.topic, wording: claim.wording,
        evidence: claim.evidence, shortWording: claim.short_wording };
      db.prepare(`INSERT INTO sleeve_moderation_candidates (id, source_document_id, fingerprint, entity_type, entity_id,
        category, topic, wording, short_wording, evidence, original_json, rejection_reason, reason_detail,
        rejection_origin, bin_entered_at, claim_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'operator-feedback', ?, 'operator-feedback', ?, ?, ?, ?)
        ON CONFLICT(source_document_id, fingerprint) DO UPDATE SET status = 'pending',
        rejection_reason = 'operator-feedback', reason_detail = excluded.reason_detail,
        rejection_origin = 'operator-feedback', claim_id = excluded.claim_id,
        bin_entered_at = excluded.bin_entered_at, updated_at = excluded.updated_at, reviewed_at = NULL, reviewed_by = NULL`)
        .run(randomUUID(), claim.source_document_id, candidateFingerprint(candidate), claim.entity_type, claim.entity_id,
          claim.category, claim.topic, claim.wording, claim.short_wording, claim.evidence, JSON.stringify(candidate),
          `${feedback.story}: ${feedback.note}`, now, claim.id, now, now);
      db.prepare('UPDATE sleeve_claims SET enabled = 0, feedback_hold = 1, updated_at = ? WHERE id = ?').run(now, claim.id);
    }
    return { review, changedStory: flagged && !unchanged };
  }).immediate();
}
