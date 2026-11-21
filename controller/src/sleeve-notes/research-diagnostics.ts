import type Database from 'better-sqlite3';
import { statSync } from 'node:fs';

/** Indexed progress reads; no article bodies, network calls or writes. */
export function researchProgress(db: Database.Database) {
  const lastCompletedAt = (
    db
      .prepare("SELECT MAX(completed_at) at FROM sleeve_research_jobs WHERE state='complete'")
      .get() as { at: string | null }
  ).at;
  const lastSourceAt = (
    db
      .prepare("SELECT MAX(requested_at) at FROM sleeve_provider_requests WHERE outcome='ready'")
      .get() as { at: string | null }
  ).at;
  const nextRetryAt = (
    db
      .prepare(
        "SELECT MIN(run_after) at FROM sleeve_research_jobs WHERE state='retry-at' AND run_after>?",
      )
      .get(new Date().toISOString()) as { at: string | null }
  ).at;
  const oldestPendingAt = (
    db
      .prepare(
        "SELECT MIN(created_at) at FROM sleeve_research_jobs WHERE state IN ('queued','running','retry-at')",
      )
      .get() as { at: string | null }
  ).at;
  return { lastCompletedAt, lastSourceAt, nextRetryAt, oldestPendingAt };
}

/** Explicit storage inspection runs in the existing read-only child process. */
export function researchStorage(db: Database.Database) {
  const pageSize = Number(db.pragma('page_size', { simple: true }));
  const databaseBytes = db.memory
    ? Number(db.pragma('page_count', { simple: true })) * pageSize
    : statSync(db.name).size;
  const reusableBytes = Number(db.pragma('freelist_count', { simple: true })) * pageSize;
  let walBytes = 0;
  if (!db.memory) {
    try {
      walBytes = statSync(`${db.name}-wal`).size;
    } catch {
      /* No WAL is normal. */
    }
  }
  const sources = db
    .prepare(
      `SELECT provider,COUNT(*) documents,
   COALESCE(SUM(length(CAST(content AS BLOB))),0) textBytes,
   SUM(CASE WHEN wikipedia_pruned_at IS NOT NULL THEN 1 ELSE 0 END) compacted
   FROM sleeve_source_documents GROUP BY provider ORDER BY provider`,
    )
    .all() as { provider: string; documents: number; textBytes: number; compacted: number }[];
  let connectionBytes: number | null = null;
  try {
    connectionBytes = (
      db
        .prepare(
          "SELECT COALESCE(SUM(pgsize),0) bytes FROM dbstat WHERE name LIKE 'sleeve_connection_%' OR name LIKE 'idx_sleeve_connection_%'",
        )
        .get() as { bytes: number }
    ).bytes;
  } catch {
    /* SQLite builds without dbstat still provide totals and source sizes. */
  }
  return {
    capturedAt: new Date().toISOString(),
    databaseBytes,
    reusableBytes,
    walBytes,
    connectionBytes,
    sources,
  };
}
