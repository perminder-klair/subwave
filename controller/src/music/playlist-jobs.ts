// In-memory job store for the playlist builder's async generation flow.
//
// POST /playlists/generate/jobs starts a run and returns immediately;
// GET /playlists/generate/jobs/:id polls until it lands. This exists because a
// generation legitimately runs for minutes (pool building plus one LLM curation
// call), which outlives Cloudflare's ~100s proxy timeout — the synchronous
// endpoint 524s into an HTML error page while the controller keeps working,
// and WebKit surfaces that page to the operator as the cryptic "The string did
// not match the expected pattern".
//
// Jobs are process-local: a controller restart forgets them, and the panel's
// poller reports the vanished job as "start again". Sweeping is lazy (on every
// create/get) so the store never holds a timer open.

import { randomUUID } from 'node:crypto';
import type { GenerateResult } from './playlist-gen.js';

export type JobStatus = 'running' | 'done' | 'error';

export interface GenerateJob {
  id: string;
  status: JobStatus;
  createdAt: number;
  finishedAt: number | null;
  result: GenerateResult | null;
  error: string | null;
}

// Finished jobs stay claimable this long after landing; anything older than
// MAX_AGE_MS is dropped regardless of status, so a wedged run can't hold one
// of the MAX_RUNNING slots forever.
export const RESULT_TTL_MS = 10 * 60_000;
export const MAX_AGE_MS = 30 * 60_000;
// Each run is pool building + an LLM call — refuse to stack more than this.
export const MAX_RUNNING = 3;

const jobs = new Map<string, GenerateJob>();

// Returns null when MAX_RUNNING jobs are already in flight.
export function create(now: number = Date.now()): GenerateJob | null {
  sweep(now);
  let running = 0;
  for (const job of jobs.values()) if (job.status === 'running') running++;
  if (running >= MAX_RUNNING) return null;
  const job: GenerateJob = {
    id: randomUUID(),
    status: 'running',
    createdAt: now,
    finishedAt: null,
    result: null,
    error: null,
  };
  jobs.set(job.id, job);
  return job;
}

export function complete(id: string, result: GenerateResult, now: number = Date.now()): void {
  const job = jobs.get(id);
  if (!job || job.status !== 'running') return;
  job.status = 'done';
  job.result = result;
  job.finishedAt = now;
}

export function fail(id: string, error: string, now: number = Date.now()): void {
  const job = jobs.get(id);
  if (!job || job.status !== 'running') return;
  job.status = 'error';
  job.error = error;
  job.finishedAt = now;
}

export function get(id: string, now: number = Date.now()): GenerateJob | undefined {
  sweep(now);
  return jobs.get(id);
}

export function sweep(now: number = Date.now()): void {
  for (const [id, job] of jobs) {
    const expired = job.finishedAt !== null && now - job.finishedAt > RESULT_TTL_MS;
    const ancient = now - job.createdAt > MAX_AGE_MS;
    if (expired || ancient) jobs.delete(id);
  }
}

// Test seam.
export function _clear(): void {
  jobs.clear();
}
