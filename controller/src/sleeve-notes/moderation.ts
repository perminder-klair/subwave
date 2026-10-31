import { createHash, randomUUID } from 'node:crypto';
import { open } from './db.js';
import { sleeveNotesReviewSchema } from '../schemas/sleeve-notes-feedback.js';
import { exemptFromAutomaticRecycleBin } from './recycle-policy.js';
import {
  RELEASE_GROUP_NOTE_CATEGORIES, SLEEVE_NOTE_CATEGORIES,
  type ResearchCandidate, type ValidatedResearch,
} from './researcher.js';

type Decision = 'approved' | 'deleted';
type Editable = Pick<ResearchCandidate, 'category' | 'topic' | 'wording' | 'shortWording' | 'evidence'>;
const actor = process.env.ADMIN_USER || 'local-admin';

function normalized(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

/** Human review may override editorial heuristics, while source and shape remain mandatory. */
function reviewedWording(edit: Editable, row: Record<string, unknown>): ResearchCandidate {
  const category = normalized(edit.category);
  const topic = normalized(edit.topic);
  const wording = normalized(edit.wording);
  const suppliedShort = normalized(edit.shortWording ?? '');
  const shortWording = suppliedShort || (wording.length <= 140
    && wording.split(/\s+/u).length <= 18 ? wording : '');
  const evidence = normalized(edit.evidence);
  const categories = row.entity_type === 'release-group'
    ? RELEASE_GROUP_NOTE_CATEGORIES : SLEEVE_NOTE_CATEGORIES;
  if (!categories.includes(category as ResearchCandidate['category'])) throw new Error('Choose a supported category');
  const checked = sleeveNotesReviewSchema.safeParse({ category, topic, wording, shortWording, evidence });
  if (!checked.success) throw new Error(checked.error.issues[0]!.message);
  if (!normalized(String(row.content)).includes(evidence)) {
    throw new Error('Supporting passage must be an exact excerpt from the saved source (24–900 characters)');
  }
  if (shortWording && (shortWording.length < 4 || shortWording.length > 140
    || shortWording.split(/\s+/u).length > 18)) {
    throw new Error('Short anchors must fit within 18 words and 140 characters');
  }
  if (row.entity_type === 'release-group' && row.provider === 'genius'
    && row.entity_name && !wording.toLocaleLowerCase().includes(String(row.entity_name).toLocaleLowerCase())) {
    throw new Error('The Full story must name this album');
  }
  return { category: category as ResearchCandidate['category'], topic, wording,
    ...(shortWording ? { shortWording } : {}), evidence };
}

export function candidateFingerprint(candidate: ResearchCandidate): string {
  // Short anchors and topic may vary between model runs for the same proposed
  // fact; the Full and its exact citation define the review item.
  const parts = [candidate.wording, candidate.evidence].map(normalized);
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export function retainRejectedCandidates(input: {
  sourceDocumentId: string;
  entityType: string;
  entityId: string;
  rejected: ValidatedResearch['rejected'];
  origin?: 'generic-dj' | 'legacy';
}): void {
  if (!input.rejected.length) return;
  const db = open();
  const now = new Date().toISOString();
  const insert = db.prepare(`INSERT INTO sleeve_moderation_candidates (
    id, source_document_id, fingerprint, entity_type, entity_id, category, topic,
    wording, short_wording, evidence, original_json, rejection_reason, reason_detail,
    rejection_origin, bin_entered_at, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(source_document_id, fingerprint) DO UPDATE SET
    rejection_reason = excluded.rejection_reason,
    updated_at = CASE WHEN sleeve_moderation_candidates.status = 'pending'
      THEN excluded.updated_at ELSE sleeve_moderation_candidates.updated_at END`);
  db.transaction(() => {
    for (const { candidate, reason } of input.rejected) {
      if (handledCandidate(input.sourceDocumentId, candidate)
        || suppressedTopic(input.entityType, input.entityId, candidate)
        || db.prepare(`SELECT 1 FROM sleeve_expired_candidate_fingerprints
          WHERE entity_type = ? AND entity_id = ? AND fingerprint = ?`)
          .get(input.entityType, input.entityId, candidateFingerprint(candidate))) continue;
      insert.run(randomUUID(), input.sourceDocumentId, candidateFingerprint(candidate),
        input.entityType, input.entityId, candidate.category, candidate.topic,
        candidate.wording, candidate.shortWording ?? '', candidate.evidence,
        JSON.stringify(candidate), reason, candidate.reviewReason ?? '',
        input.origin ?? 'legacy', now, now, now);
    }
  }).immediate();
}

/** Explicit operator withdrawal works before a story has ever aired. */
export function sendClaimToReview(id: string): { id: string } {
  const db = open();
  return db.transaction(() => {
    const claim = db.prepare('SELECT * FROM sleeve_claims WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!claim) throw new Error('Claim not found');
    if (claim.operator_state === 'deleted') throw new Error('This story has already been deleted');
    const existing = db.prepare("SELECT id FROM sleeve_moderation_candidates WHERE claim_id = ? AND status = 'pending'")
      .get(id) as { id: string } | undefined;
    const now = new Date().toISOString();
    const candidate: ResearchCandidate = { category: claim.category as ResearchCandidate['category'],
      topic: String(claim.topic), wording: String(claim.wording), shortWording: String(claim.short_wording), evidence: String(claim.evidence) };
    const fingerprint = candidateFingerprint(candidate);
    if (!existing) {
      db.prepare(`INSERT INTO sleeve_moderation_candidates (id, source_document_id, fingerprint, entity_type, entity_id,
        category, topic, wording, short_wording, evidence, original_json, rejection_reason, reason_detail,
        rejection_origin, bin_entered_at, claim_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'operator-review', 'Sent to Review by the operator. Check the wording and source context before restoring.',
          'operator-review', ?, ?, ?, ?)
        ON CONFLICT(source_document_id, fingerprint) DO UPDATE SET status = 'pending',
          rejection_reason = 'operator-review', reason_detail = excluded.reason_detail, rejection_origin = 'operator-review',
          claim_id = excluded.claim_id, bin_entered_at = excluded.bin_entered_at, updated_at = excluded.updated_at,
          reviewed_at = NULL, reviewed_by = NULL`)
        .run(randomUUID(), claim.source_document_id, fingerprint, claim.entity_type, claim.entity_id,
          candidate.category, candidate.topic, candidate.wording, candidate.shortWording ?? '', candidate.evidence,
          JSON.stringify(candidate), now, id, now, now);
    } else {
      // Protect an existing automatic review item from expiry without creating a duplicate.
      db.prepare("UPDATE sleeve_moderation_candidates SET rejection_origin = 'operator-review', updated_at = ? WHERE id = ?")
        .run(now, existing.id);
    }
    db.prepare('UPDATE sleeve_claims SET enabled = 0, feedback_hold = 1, updated_at = ? WHERE id = ?').run(now, id);
    if (!existing) db.prepare(`INSERT INTO sleeve_claim_history (id, claim_id, action, actor, before_json, after_json, created_at)
      VALUES (?, ?, 'sent-to-review', ?, ?, NULL, ?)`).run(randomUUID(), id, actor,
        JSON.stringify({ ...candidate, enabled: claim.enabled, operatorState: claim.operator_state }), now);
    const item = db.prepare("SELECT id FROM sleeve_moderation_candidates WHERE claim_id = ? AND status = 'pending'").get(id) as { id: string };
    return item;
  }).immediate();
}

/** Availability is independent of a queued or dismissed AI finding. */
export function setClaimAvailability(id: string, action: 'withdraw'|'restore'): void {
  const db=open();
  db.transaction(()=>{
    const claim=db.prepare('SELECT * FROM sleeve_claims WHERE id=?').get(id) as Record<string,unknown>|undefined;
    if (!claim) throw new Error('Claim not found');
    if (claim.operator_state==='deleted') throw new Error('This story has already been deleted');
    if (action==='restore') {
      moderateExistingClaim(id,'approved',{category:claim.category as ResearchCandidate['category'],topic:String(claim.topic),
        wording:String(claim.wording),evidence:String(claim.evidence),shortWording:String(claim.short_wording??'')});
      return;
    }
    if (claim.enabled===0&&claim.feedback_hold===1) return;
    const now=new Date().toISOString();
    db.prepare('UPDATE sleeve_claims SET enabled=0,feedback_hold=1,updated_at=? WHERE id=?').run(now,id);
    db.prepare(`INSERT INTO sleeve_claim_history(id,claim_id,action,actor,before_json,after_json,created_at)
      VALUES (?,?,'withdrawn',?,?,NULL,?)`).run(randomUUID(),id,actor,JSON.stringify(claim),now);
  }).immediate();
}

/** Remove expired, untouched Recycle Bin items while keeping a non-prose suppression key. */
export function expireRecycleBin(now = new Date()): number {
  const db = open();
  const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const expiredAt = now.toISOString();
  const flagged=db.prepare("SELECT 1 FROM sqlite_master WHERE name='sleeve_airing_reviews'").get()
    ? `AND NOT EXISTS (SELECT 1 FROM sleeve_airing_reviews review WHERE json_extract(review.context_json,'$.kind')='fact'
        AND json_extract(review.context_json,'$.sparks[0].claimId')=sleeve_moderation_candidates.claim_id)` : '';
  return db.transaction(() => {
    const rows = db.prepare(`SELECT id, claim_id AS claimId, entity_type AS entityType, entity_id AS entityId, fingerprint
      FROM sleeve_moderation_candidates WHERE status = 'pending' AND bin_entered_at < ?
        AND rejection_origin NOT IN ('operator-feedback', 'operator-review')
        AND NOT EXISTS (SELECT 1 FROM sleeve_claims held WHERE held.id=sleeve_moderation_candidates.claim_id AND held.feedback_hold=1)
        ${flagged}`)
      .all(cutoff) as Array<{ id: string; claimId: string | null; entityType: string; entityId: string; fingerprint: string }>;
    const suppress = db.prepare(`INSERT OR IGNORE INTO sleeve_expired_candidate_fingerprints
      (entity_type, entity_id, fingerprint, expired_at) VALUES (?, ?, ?, ?)`);
    const removeHistory = db.prepare(`DELETE FROM sleeve_moderation_history WHERE candidate_id = ?`);
    const removeItem = db.prepare(`DELETE FROM sleeve_moderation_candidates WHERE id = ? AND status = 'pending'`);
    for (const row of rows) {
      suppress.run(row.entityType, row.entityId, row.fingerprint, expiredAt);
      removeHistory.run(row.id);
      removeItem.run(row.id);
      if (row.claimId) {
        // A bin item from the live DJ still has a disabled claim and its use
        // ledger. Remove the dependent rows before deleting the claim itself.
        const otherItems = db.prepare(`SELECT id FROM sleeve_moderation_candidates WHERE claim_id = ?`)
          .all(row.claimId) as Array<{ id: string }>;
        for (const item of otherItems) {
          removeHistory.run(item.id);
          db.prepare(`DELETE FROM sleeve_moderation_candidates WHERE id = ?`).run(item.id);
        }
        db.prepare(`DELETE FROM sleeve_claim_history WHERE claim_id = ?`).run(row.claimId);
        db.prepare(`DELETE FROM sleeve_series_library_claims WHERE claim_id = ?`).run(row.claimId);
        db.prepare(`DELETE FROM sleeve_dj_quality_rejections WHERE claim_id = ?`).run(row.claimId);
        db.prepare(`DELETE FROM sleeve_claim_uses WHERE claim_id = ?`).run(row.claimId);
        db.prepare(`DELETE FROM sleeve_claims WHERE id = ? AND enabled = 0`).run(row.claimId);
      }
    }
    return rows.length;
  }).immediate();
}

/** Only an explicit quality verdict from a distinct generated link counts. */
export function recordLiveDjRejection(claimId: string, opportunityId: string, reason: string): number {
  const db = open();
  return db.transaction(() => {
    const claim = db.prepare(`SELECT c.*, source.provider AS source_provider
      FROM sleeve_claims c JOIN sleeve_source_documents source ON source.id = c.source_document_id
      WHERE c.id = ? AND c.enabled = 1`)
      .get(claimId) as Record<string, unknown> | undefined;
    if (!claim) return 0;
    if (exemptFromAutomaticRecycleBin(String(claim.source_provider),
      String(claim.category), String(claim.evidence))) return 0;
    const use = db.prepare(`SELECT 1 FROM sleeve_claim_uses WHERE id = ? AND claim_id = ? AND aired_at IS NOT NULL`)
      .get(opportunityId, claimId);
    if (!use) return 0;
    const now = new Date().toISOString();
    db.prepare(`INSERT OR IGNORE INTO sleeve_dj_quality_rejections
      (claim_id, opportunity_id, reason, created_at) VALUES (?, ?, ?, ?)`)
      .run(claimId, opportunityId, normalized(reason).slice(0, 240), now);
    const count = (db.prepare(`SELECT COUNT(*) AS count FROM sleeve_dj_quality_rejections
      WHERE claim_id = ?`).get(claimId) as { count: number }).count;
    if (count < 3) return count;
    db.prepare(`UPDATE sleeve_claims SET enabled = 0, updated_at = ? WHERE id = ?`).run(now, claimId);
    const candidate: ResearchCandidate = {
      category: String(claim.category) as ResearchCandidate['category'],
      topic: String(claim.topic), wording: String(claim.wording),
      shortWording: String(claim.short_wording || ''), evidence: String(claim.evidence),
    };
    const fingerprint = candidateFingerprint(candidate);
    db.prepare(`INSERT INTO sleeve_moderation_candidates (
      id, source_document_id, fingerprint, entity_type, entity_id, category, topic,
      wording, short_wording, evidence, original_json, rejection_reason, reason_detail,
      rejection_origin, dj_rejection_count, bin_entered_at, claim_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'dj-quality', ?, 'live-dj', ?, ?, ?, ?, ?)
    ON CONFLICT(source_document_id, fingerprint) DO UPDATE SET
      status = 'pending', rejection_reason = 'dj-quality', reason_detail = excluded.reason_detail,
      rejection_origin = 'live-dj', dj_rejection_count = excluded.dj_rejection_count,
      bin_entered_at = excluded.bin_entered_at, claim_id = excluded.claim_id,
      updated_at = excluded.updated_at`)
      .run(randomUUID(), claim.source_document_id, fingerprint, claim.entity_type, claim.entity_id,
        candidate.category, candidate.topic, candidate.wording, candidate.shortWording ?? '',
        candidate.evidence, JSON.stringify(candidate), normalized(reason).slice(0, 240),
        count, now, claimId, now, now);
    return count;
  }).immediate();
}

export function handledCandidate(sourceDocumentId: string, candidate: ResearchCandidate): boolean {
  return reviewedCandidate(sourceDocumentId, candidate);
}

export function markCandidateRetained(sourceDocumentId: string, candidate: ResearchCandidate): void {
  const db = open();
  db.prepare(`UPDATE sleeve_moderation_candidates SET status = 'retained',
    claim_id = (SELECT id FROM sleeve_claims WHERE source_document_id = ?
      AND category = ? AND topic = ? AND wording = ? LIMIT 1),
    updated_at = ?
    WHERE source_document_id = ? AND fingerprint = ? AND status = 'pending'`)
    .run(sourceDocumentId, candidate.category, candidate.topic, candidate.wording,
      new Date().toISOString(), sourceDocumentId, candidateFingerprint(candidate));
}

function reviewedCandidate(sourceDocumentId: string, candidate: ResearchCandidate): boolean {
  return !!open().prepare(`SELECT 1 FROM sleeve_moderation_candidates m
    JOIN sleeve_source_documents old_source ON old_source.id = m.source_document_id
    JOIN sleeve_source_documents current_source ON current_source.id = ?
    WHERE old_source.entity_type = current_source.entity_type
      AND old_source.entity_id = current_source.entity_id
      AND m.fingerprint = ? AND m.status IN ('approved', 'deleted')`)
    .get(sourceDocumentId, candidateFingerprint(candidate));
}

export function suppressedTopic(entityType: string, entityId: string, candidate: ResearchCandidate): boolean {
  return !!open().prepare(`SELECT 1 FROM sleeve_claim_suppressions
    WHERE entity_type = ? AND entity_id = ? AND category = ? AND topic = ?`)
    .get(entityType, entityId, candidate.category, candidate.topic);
}

export interface ModerationItem {
  id: string;
  sourceDocumentId: string;
  entityType: string;
  entityId: string;
  entityName: string | null;
  artistName: string | null;
  provider: string;
  sourceUrl: string;
  attribution: string;
  rejectionReason: string;
  reasonDetail: string;
  rejectionOrigin: string;
  binEnteredAt: string | null;
  djRejectionCount: number;
  status: string;
  category: string;
  topic: string;
  wording: string;
  shortWording: string;
  evidence: string;
  originalJson: string;
  claimId: string | null;
  updatedAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
}

export function listModeration(input: {
  status: 'pending' | 'approved' | 'deleted' | 'retained';
  search: string;
  provider: string;
  reason: string;
  limit: number;
  offset: number;
}): { items: ModerationItem[]; total: number; counts: Record<string, number> } {
  const db = open();
  const clauses = ['m.status = ?'];
  const args: Array<string> = [input.status];
  if (input.provider) { clauses.push('s.provider = ?'); args.push(input.provider); }
  if (input.reason) { clauses.push('m.rejection_reason = ?'); args.push(input.reason); }
  if (input.search) {
    clauses.push(`(m.wording LIKE ? OR m.topic LIKE ? OR m.entity_id LIKE ?
      OR a.name LIKE ? OR r.title LIKE ? OR rel.title LIKE ?)`);
    const term = `%${input.search}%`;
    args.push(term, term, term, term, term, term);
  }
  const from = `FROM sleeve_moderation_candidates m
    JOIN sleeve_source_documents s ON s.id = m.source_document_id
    LEFT JOIN sleeve_artists a ON m.entity_type = 'artist' AND a.id = m.entity_id
    LEFT JOIN sleeve_recordings r ON m.entity_type = 'recording' AND r.id = m.entity_id
    LEFT JOIN sleeve_releases rel ON m.entity_type = 'release' AND rel.id = m.entity_id
    LEFT JOIN sleeve_artists recording_artist ON recording_artist.id = r.artist_id
    WHERE ${clauses.join(' AND ')}`;
  const total = (db.prepare(`SELECT COUNT(*) AS count ${from}`).get(...args) as { count: number }).count;
  const items = db.prepare(`SELECT m.id, m.source_document_id AS sourceDocumentId,
      m.entity_type AS entityType, m.entity_id AS entityId,
      COALESCE(a.name, r.title, rel.title, (SELECT title FROM sleeve_releases
        WHERE musicbrainz_release_group_id = m.entity_id ORDER BY title LIMIT 1)) AS entityName,
      COALESCE(a.name, recording_artist.name) AS artistName,
      s.provider, s.source_url AS sourceUrl, s.attribution,
      m.rejection_reason AS rejectionReason, m.reason_detail AS reasonDetail,
      m.rejection_origin AS rejectionOrigin, m.bin_entered_at AS binEnteredAt,
      m.dj_rejection_count AS djRejectionCount, m.status, m.category, m.topic,
      m.wording, m.short_wording AS shortWording, m.evidence,
      m.original_json AS originalJson, m.claim_id AS claimId,
      m.updated_at AS updatedAt, m.reviewed_at AS reviewedAt, m.reviewed_by AS reviewedBy
    ${from}
    ORDER BY CASE WHEN m.status = 'pending' THEN m.bin_entered_at END ASC,
      CASE WHEN m.status = 'pending' THEN m.id END ASC,
      m.updated_at DESC LIMIT ? OFFSET ?`)
    .all(...args, input.limit, input.offset) as ModerationItem[];
  const counts = Object.fromEntries((db.prepare(`SELECT status, COUNT(*) AS count
    FROM sleeve_moderation_candidates GROUP BY status`).all() as Array<{ status: string; count: number }> )
    .map(({ status, count }) => [status, count]));
  return { items, total, counts };
}

export function moderationSource(id: string): { content: string; sourceUrl: string; provider: string } | null {
  return (open().prepare(`SELECT content, source_url AS sourceUrl, provider
    FROM sleeve_source_documents WHERE id = ?`).get(id) as
    { content: string; sourceUrl: string; provider: string } | undefined) ?? null;
}

export function moderateCandidate(id: string, action: Decision, edit: Editable | null): { claimId: string | null } {
  const db = open();
  return db.transaction(() => {
    const row = db.prepare(`SELECT m.*, s.provider, s.source_url, s.content,
      CASE m.entity_type WHEN 'artist' THEN (SELECT name FROM sleeve_artists WHERE id = m.entity_id)
        WHEN 'recording' THEN (SELECT title FROM sleeve_recordings WHERE id = m.entity_id)
        WHEN 'release' THEN (SELECT title FROM sleeve_releases WHERE id = m.entity_id)
        ELSE (SELECT title FROM sleeve_releases WHERE musicbrainz_release_group_id = m.entity_id LIMIT 1)
      END AS entity_name
      FROM sleeve_moderation_candidates m JOIN sleeve_source_documents s ON s.id = m.source_document_id
      WHERE m.id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!row) throw new Error('Review item not found');
    if (row.status !== 'pending') throw new Error('This item has already been reviewed');
    const now = new Date().toISOString();
    let claimId: string | null = null;
    let reviewed: ResearchCandidate | null = null;
    if (action === 'approved') {
      if (!edit) throw new Error('Edited claim fields are required');
      const accepted = reviewedWording(edit, row);
      reviewed = accepted;
      if (accepted.category !== row.category || accepted.topic !== row.topic) {
        db.prepare(`INSERT OR IGNORE INTO sleeve_claim_suppressions
          (entity_type, entity_id, category, topic, created_at) VALUES (?, ?, ?, ?, ?)`)
          .run(row.entity_type, row.entity_id, row.category, row.topic, now);
      }
      if (suppressedTopic(String(row.entity_type), String(row.entity_id), accepted)) {
        throw new Error('This claim topic was previously deleted');
      }
      const conflict = db.prepare(`SELECT id, operator_state FROM sleeve_claims
        WHERE entity_type = ? AND entity_id = ? AND category = ? AND topic = ? AND source_document_id = ?`)
        .get(row.entity_type, row.entity_id, accepted.category, accepted.topic, row.source_document_id) as
        { id: string; operator_state: string } | undefined;
      if (conflict?.operator_state === 'deleted') throw new Error('A deleted claim already has this topic');
      claimId = conflict?.id ?? randomUUID();
      db.prepare(`INSERT INTO sleeve_claims (id, entity_type, entity_id, category, topic,
        wording, short_wording, source_document_id, evidence, enabled, operator_state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'approved', ?, ?)
        ON CONFLICT(entity_type, entity_id, category, topic, source_document_id) DO UPDATE SET
          wording = excluded.wording, short_wording = excluded.short_wording,
          evidence = excluded.evidence, enabled = 1, feedback_hold = 0, operator_state = 'approved', updated_at = excluded.updated_at`)
        .run(claimId, row.entity_type, row.entity_id, accepted.category, accepted.topic,
          accepted.wording, accepted.shortWording ?? '', row.source_document_id, accepted.evidence, now, now);
      db.prepare(`DELETE FROM sleeve_dj_quality_rejections WHERE claim_id = ?`).run(claimId);
    } else {
      db.prepare(`INSERT OR IGNORE INTO sleeve_claim_suppressions
        (entity_type, entity_id, category, topic, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run(row.entity_type, row.entity_id, row.category, row.topic, now);
      if (row.claim_id) {
        claimId = String(row.claim_id);
        db.prepare("UPDATE sleeve_claims SET enabled = 0, operator_state = 'deleted', updated_at = ? WHERE id = ?")
          .run(now, claimId);
      }
    }
    db.prepare(`UPDATE sleeve_moderation_candidates SET status = ?, claim_id = ?,
      category = ?, topic = ?, wording = ?, short_wording = ?, evidence = ?,
      reviewed_at = ?, reviewed_by = ?, updated_at = ? WHERE id = ?`)
      .run(action, claimId, reviewed?.category ?? row.category, reviewed?.topic ?? row.topic,
        reviewed?.wording ?? row.wording, reviewed?.shortWording ?? row.short_wording,
        reviewed?.evidence ?? row.evidence, now, actor, now, id);
    db.prepare(`INSERT INTO sleeve_moderation_history (id, candidate_id, action, actor, detail_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(randomUUID(), id, action, actor, JSON.stringify({ edit, claimId }), now);
    return { claimId };
  }).immediate();
}

export function moderateExistingClaim(id: string, action: Decision, edit: Editable | null): void {
  const db = open();
  db.transaction(() => {
    const claim = db.prepare(`SELECT c.*, s.provider, s.source_url, s.content,
      CASE c.entity_type WHEN 'artist' THEN (SELECT name FROM sleeve_artists WHERE id = c.entity_id)
        WHEN 'recording' THEN (SELECT title FROM sleeve_recordings WHERE id = c.entity_id)
        WHEN 'release' THEN (SELECT title FROM sleeve_releases WHERE id = c.entity_id)
        ELSE (SELECT title FROM sleeve_releases WHERE musicbrainz_release_group_id = c.entity_id LIMIT 1)
      END AS entity_name
      FROM sleeve_claims c JOIN sleeve_source_documents s ON s.id = c.source_document_id WHERE c.id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    if (!claim) throw new Error('Claim not found');
    if (claim.operator_state === 'deleted') throw new Error('This story has already been deleted');
    const now = new Date().toISOString();
    const before = JSON.stringify({ category: claim.category, topic: claim.topic,
      wording: claim.wording, shortWording: claim.short_wording, evidence: claim.evidence,
      enabled: claim.enabled, operatorState: claim.operator_state });
    if (action === 'deleted') {
      db.prepare(`INSERT OR IGNORE INTO sleeve_claim_suppressions
        (entity_type, entity_id, category, topic, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run(claim.entity_type, claim.entity_id, claim.category, claim.topic, now);
      db.prepare(`UPDATE sleeve_claims SET enabled = 0, operator_state = 'deleted', updated_at = ? WHERE id = ?`)
        .run(now, id);
      db.prepare(`UPDATE sleeve_moderation_candidates SET status = 'deleted', updated_at = ?
        WHERE claim_id = ?`).run(now, id);
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='sleeve_airing_reviews'").get()) {
        db.prepare(`UPDATE sleeve_airing_reviews SET state='resolved',lease_token=NULL,guidance_approved=0,updated_at=?
          WHERE json_extract(context_json,'$.kind')='fact' AND json_extract(context_json,'$.sparks[0].claimId')=?
          AND state IN ('queued','running','ready')`).run(now,id);
      }
      db.prepare(`INSERT INTO sleeve_claim_history (id, claim_id, action, actor, before_json, after_json, created_at)
        VALUES (?, ?, 'deleted', ?, ?, NULL, ?)`).run(randomUUID(), id, actor, before, now);
      return;
    }
    if (!edit) throw new Error('Edited claim fields are required');
    const accepted = reviewedWording(edit, claim);
    if ((accepted.category !== claim.category || accepted.topic !== claim.topic)) {
      db.prepare(`INSERT OR IGNORE INTO sleeve_claim_suppressions
        (entity_type, entity_id, category, topic, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run(claim.entity_type, claim.entity_id, claim.category, claim.topic, now);
    }
    const conflict = db.prepare(`SELECT id FROM sleeve_claims WHERE entity_type = ? AND entity_id = ?
      AND category = ? AND topic = ? AND source_document_id = ? AND id <> ?`)
      .get(claim.entity_type, claim.entity_id, accepted.category, accepted.topic, claim.source_document_id, id);
    if (conflict) throw new Error('Another claim already has this topic');
    db.prepare(`UPDATE sleeve_claims SET category = ?, topic = ?, wording = ?, short_wording = ?,
      evidence = ?, enabled = 1, feedback_hold = 0, operator_state = 'approved', updated_at = ? WHERE id = ?`)
      .run(accepted.category, accepted.topic, accepted.wording, accepted.shortWording ?? '',
        accepted.evidence, now, id);
    db.prepare(`DELETE FROM sleeve_dj_quality_rejections WHERE claim_id = ?`).run(id);
    db.prepare(`UPDATE sleeve_moderation_candidates SET status='approved',reviewed_at=?,reviewed_by=?
      WHERE claim_id=? AND status='pending'`).run(now,actor,id);
    db.prepare(`UPDATE sleeve_moderation_candidates SET category = ?, topic = ?, wording = ?,
      short_wording = ?, evidence = ?, updated_at = ? WHERE claim_id = ?`)
      .run(accepted.category, accepted.topic, accepted.wording,
        accepted.shortWording ?? '', accepted.evidence, now, id);
    db.prepare(`INSERT INTO sleeve_claim_history (id, claim_id, action, actor, before_json, after_json, created_at)
      VALUES (?, ?, 'edited', ?, ?, ?, ?)`).run(randomUUID(), id, actor, before, JSON.stringify(accepted), now);
  }).immediate();
}
