// The LLM tagging worker pool, reused by phases 2 and 4 of tag-library.

import * as db from '../library-db.js';
import { primaryLeg, fallbackLeg, probeLegReachable } from '../../llm/provider.js';
import { isUnreachable, isQuotaOrAuthError, errReason } from '../../llm/sdk.js';
import { tagBatch, tagOne, type TagResult } from '../tagger-core.js';
import { reportProgress } from '../tagger-progress.js';
import { logEvent } from './log.js';
import { tagInputFor, recordTagAnswer } from './tag-input.js';

// One LLM worker the batch loop pulls through. `pin` selects the leg (undefined
// = normal primary/fallback failover, single-LLM mode); `label` is stamped on
// every track it tags, so provenance stays honest in dual-LLM mode.
interface TagConsumer {
  pin?: 'primary' | 'fallback';
  label: string;
}

interface TagState {
  tagged: number;
  callCount: number;
  processed: number;
  // Tracks that came back null from the LLM; surfaced in the progress channel.
  errors: number;
  // Answered with no usable mood (#2283): left untagged and marked, never counted
  // as tagged. `offVocab` = every mood it named was outside the vocabulary.
  untaggable: Array<{ id: string; offVocab: boolean }>;
  byLeg: Record<string, number>;
}

// Stamps the progress channel only: 'seed' = phase 2, 'learn' = phase 4 rounds.
interface TagPhaseInfo {
  phase: 'seed' | 'learn';
  round?: number;
}

// Tag one batch on one consumer's leg; returns the count tagged. Throws only
// when a pinned leg cannot recover this run, and the caller then requeues the
// batch. Upserts happen only after the batch resolves, so the requeue is
// lossless. Other failures salvage per track, so one bad line never sinks 25.
async function processBatch(
  batch: string[],
  consumer: TagConsumer,
  promptHash: string,
  source: db.TagSource,
  state: TagState,
): Promise<number> {
  const songs = batch.map(id => db.getTrack(id)).filter((t): t is db.TrackRecord => !!t);
  if (songs.length === 0) return 0;
  const input = songs.map(tagInputFor);
  const opts = consumer.pin ? { leg: consumer.pin } : {};

  let results: Array<TagResult | null>;
  try {
    results = await tagBatch(input, opts);
    state.callCount += 1;
  } catch (err: any) {
    // Host down or a quota/auth rejection (#438): rethrow BEFORE the per-track
    // salvage, or this grinds 25 serial timeouts against a leg that won't answer.
    if (consumer.pin && (isUnreachable(err) || isQuotaOrAuthError(err))) throw err;
    // A "batch length mismatch" is an expected degrade, not a failure: some
    // models don't return one entry per input track, so tag individually and log
    // at warning. Genuine batch errors keep the error line.
    const perTrackDegrade = /batch length mismatch/i.test(err.message || '');
    if (perTrackDegrade) {
      logEvent(
        'warning',
        `${consumer.label} didn't return one entry per track — tagging ` +
          `${songs.length} tracks individually this batch (expected for some models; just slower)`,
      );
    } else {
      logEvent(
        'error',
        `LLM batch failed (${songs.length} tracks) on ${consumer.label}: ${err.message} — falling back to per-track`,
      );
    }
    results = [];
    for (const song of input) {
      try {
        results.push(await tagOne(song, opts));
        state.callCount += 1;
      } catch (oneErr: any) {
        // Leg unusable mid-salvage: bail the batch, nothing is upserted yet.
        if (consumer.pin && (isUnreachable(oneErr) || isQuotaOrAuthError(oneErr))) throw oneErr;
        console.error(`[tag] per-track tag failed on ${consumer.label}: ${oneErr.message}`);
        results.push(null);
      }
    }
  }

  let tagged = 0;
  for (let j = 0; j < songs.length; j++) {
    const result = results[j];
    if (!result) {
      state.errors += 1;
      continue;
    }
    const outcome = recordTagAnswer(songs[j].id, input[j], result, { source, promptHash, model: consumer.label });
    if (outcome === 'untaggable') {
      state.untaggable.push({ id: songs[j].id, offVocab: !!result.offVocab });
      continue;
    }
    tagged += 1;
  }
  return tagged;
}

// Drain the shared `batches` queue with one consumer. `shift()` between awaits
// is atomic, so two consumers never pull the same batch. A pinned consumer whose
// leg dies requeues its batch and returns; `onDrop` reports the legs left.
async function runConsumer(
  batches: string[][],
  consumer: TagConsumer,
  promptHash: string,
  source: db.TagSource,
  total: number,
  state: TagState,
  phaseInfo: TagPhaseInfo,
  onDrop: ((err: any) => number) | null,
): Promise<void> {
  for (;;) {
    const batch = batches.shift();
    if (!batch) return;
    try {
      const n = await processBatch(batch, consumer, promptHash, source, state);
      state.tagged += n;
      state.byLeg[consumer.label] = (state.byLeg[consumer.label] || 0) + n;
    } catch (err: any) {
      // processBatch rethrows only for an unreachable host or a quota/auth
      // refusal (#438). Name which: logging every drop as "unreachable"
      // misdirects an operator whose provider credits ran out.
      batches.unshift(batch);
      const remaining = onDrop ? onDrop(err) : 0;
      const reason = isQuotaOrAuthError(err) ? 'quota/credit/auth rejected' : 'host unreachable';
      logEvent(
        'error',
        `LLM leg ${consumer.label} dropped — ${reason}: ${errReason(err)} (${remaining} leg(s) left)`,
      );
      return;
    }
    state.processed += 1;
    if (state.processed % 4 === 0) {
      console.log(`[tag] LLM-tagged ${state.tagged}/${total}`);
    }
    reportProgress({
      phase: phaseInfo.phase,
      label: 'Tagging with LLM',
      done: state.tagged,
      total,
      round: phaseInfo.round,
      errors: state.errors || undefined,
      llm: { legs: state.byLeg },
    });
  }
}

// Phase 2 + 4 LLM tagging: one failover-capable consumer, or two pinned ones in
// dual-LLM mode, draining a shared batch queue.
export async function llmTagInBatches(
  ids: string[],
  batchSize: number,
  promptHash: string,
  source: db.TagSource,
  consumers: TagConsumer[],
  phaseInfo: TagPhaseInfo,
): Promise<{ tagged: number; untaggable: string[]; callCount: number; byLeg: Record<string, number> }> {
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += batchSize) batches.push(ids.slice(i, i + batchSize));

  const state: TagState = { tagged: 0, callCount: 0, processed: 0, errors: 0, untaggable: [], byLeg: {} };
  reportProgress({
    phase: phaseInfo.phase,
    label: 'Tagging with LLM',
    done: 0,
    total: ids.length,
    round: phaseInfo.round,
  });

  if (consumers.length <= 1) {
    // No requeue/drop: the unpinned call already fails over internally, so an
    // error means the batch is genuinely unworkable this run.
    await runConsumer(batches, consumers[0], promptHash, source, ids.length, state, phaseInfo, null);
  } else {
    let alive = consumers.length;
    let quotaOrAuthDrop = false;
    await Promise.all(
      consumers.map(c =>
        runConsumer(batches, c, promptHash, source, ids.length, state, phaseInfo, (err: any) => {
          if (isQuotaOrAuthError(err)) quotaOrAuthDrop = true;
          return --alive;
        })),
    );
    if (batches.length > 0) {
      const abandoned = batches.reduce((n, b) => n + b.length, 0);
      const hint = quotaOrAuthDrop
        ? ' — a leg was refused for quota/credit/auth; check the provider credit balance, spend cap, or API key'
        : '';
      logEvent('warning', `All LLM legs dropped — ${abandoned} tracks left for next run${hint}`);
    }
  }
  logUntaggable(state.untaggable);
  return {
    tagged: state.tagged,
    untaggable: state.untaggable.map(u => u.id),
    callCount: state.callCount,
    byLeg: state.byLeg,
  };
}

// One line per kind, so "the model couldn't tell" reads apart from "it answered
// outside the vocabulary", which is a vocabulary or model problem.
function logUntaggable(untaggable: TagState['untaggable']): void {
  const list = (ids: string[]) => ids.slice(0, 20).join(', ') + (ids.length > 20 ? `, … ${ids.length - 20} more` : '');
  const cantTell = untaggable.filter(u => !u.offVocab).map(u => u.id);
  const offVocab = untaggable.filter(u => u.offVocab).map(u => u.id);
  if (cantTell.length > 0) {
    logEvent(
      'info',
      `${cantTell.length} untaggable (the model couldn't tell; not re-asked until ` +
        `the vocabulary, the model or their metadata changes): ${list(cantTell)}`,
    );
  }
  if (offVocab.length > 0) {
    logEvent(
      'warning',
      `${offVocab.length} untaggable (every mood was outside the vocabulary; not re-asked until ` +
        `the vocabulary, the model or their metadata changes): ${list(offVocab)}`,
    );
  }
}

// Dual-LLM mode activates when a fallback is configured, distinct from the
// primary, and answers a cheap probe; otherwise one failover-capable consumer.
export async function resolveTagConsumers(): Promise<TagConsumer[]> {
  const primary = primaryLeg();
  const fb = fallbackLeg();
  if (!fb) return [{ label: primary.label }];

  const sameHost =
    (primary.cfg.ollamaUrl || '') === (fb.cfg.ollamaUrl || '') &&
    (primary.cfg.baseUrl || '') === (fb.cfg.baseUrl || '');
  if (fb.label === primary.label && sameHost) {
    logEvent('info', 'Fallback LLM identical to primary — single-LLM mode');
    return [{ label: primary.label }];
  }

  if (!(await probeLegReachable(fb))) {
    logEvent('info', `Fallback LLM (${fb.label}) unreachable — single-LLM mode`);
    return [{ label: primary.label }];
  }

  logEvent('info', `Dual-LLM mode active: primary=${primary.label} + fallback=${fb.label}`);
  return [
    { pin: 'primary', label: primary.label },
    { pin: 'fallback', label: fb.label },
  ];
}

