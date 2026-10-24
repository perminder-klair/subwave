import { alignLibrarySource, librarySourceKey } from './local-identity.js';
// Sleeve Notes owns a small sidecar database. It never writes to Navidrome or
// to the existing library index: provider knowledge has a separate lifecycle.
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, copyFileSync, renameSync, rmSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { dirname } from 'node:path';
import { STATE_DIR } from '../config.js';

export const DB_PATH = `${STATE_DIR}/sleeve-notes.db`;
export const SCHEMA_VERSION = 3;
const APPLICATION_ID = 0x53574e31; // SWN1: distinguishes public v1 from old experiments.

const RESEARCH_INDEXES = `
  CREATE INDEX IF NOT EXISTS idx_sleeve_artist_name ON sleeve_artists(lower(name));
  CREATE INDEX IF NOT EXISTS idx_sleeve_research_completion ON sleeve_research_jobs(state,completed_at);
  CREATE INDEX IF NOT EXISTS idx_sleeve_provider_success ON sleeve_provider_requests(outcome,requested_at);
`;

let db: Database.Database | null = null;
let libraryFingerprint: string | null = null;
const cachedReads = new AsyncLocalStorage<Database.Database>();

/** Run synchronous cache reads without creating or migrating the station DB. */
export function withCachedRead<T>(read: () => T, path = DB_PATH): T {
  const saved = existsSync(path)
    ? new Database(path, { readonly: true, fileMustExist: true })
    : new Database(':memory:');
  // An absent cache gets an empty ephemeral schema, never a file on disk.
  if (saved.memory) migrate(saved);
  try {
    const result = cachedReads.run(saved, read);
    // Keep the read-only handle alive until an asynchronous view has finished.
    if (result instanceof Promise) return result.finally(() => saved.close()) as T;
    saved.close();
    return result;
  } catch (error) {
    saved.close();
    throw error;
  }
}

export function open(): Database.Database {
  const cached = cachedReads.getStore();
  if (cached) return cached;
  if (!db) {
    mkdirSync(dirname(DB_PATH), { recursive: true });
    const opening = new Database(DB_PATH);
    try {
      opening.pragma('journal_mode = WAL');
      opening.pragma('synchronous = NORMAL');
      migrate(opening);
      db = opening;
    } catch (error) {
      opening.close();
      throw error;
    }
  }
  const fingerprint = librarySourceKey();
  if (libraryFingerprint !== fingerprint) {
    alignLibrarySource(db, fingerprint);
    libraryFingerprint = fingerprint;
  }
  return db;
}

export function close(): void {
  if (!db) return;
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch {}
  db.close();
  db = null;
  libraryFingerprint = null;
}

let activeResearchWork = 0;
let restoringResearch = false;
/** A restore must not replace a database beneath an awaited research job. */
export async function runResearchDatabaseWork(run: () => Promise<boolean>): Promise<boolean> {
  if (restoringResearch) return false;
  activeResearchWork++;
  try {
    return await run();
  } finally {
    activeResearchWork--;
  }
}
export function acquireResearchRestore(): (() => void) | null {
  if (restoringResearch || activeResearchWork) return null;
  restoringResearch = true;
  return () => {
    restoringResearch = false;
  };
}

/** SQLite's online snapshot includes pages still held in the WAL. */
export async function backup(path: string): Promise<void> {
  if (restoringResearch) throw new Error('Sleeve Notes restore is in progress');
  activeResearchWork++;
  const shared = db;
  let source: Database.Database | null = null;
  try {
    // A disabled feature may have an older cached schema. Export is a snapshot,
    // not permission to migrate that cache or create a new one.
    source = shared ?? new Database(DB_PATH, { readonly: true, fileMustExist: true });
    await source.backup(path);
  } finally {
    if (!shared) source?.close();
    activeResearchWork--;
  }
}

/** Validate and migrate an extracted copy before any station state is changed. */
export function prepareBackupRestore(path: string): void {
  const candidate = new Database(path, { fileMustExist: true });
  try {
    const version = Number(candidate.pragma('user_version', { simple: true }));
    if (
      version < 1 ||
      version > SCHEMA_VERSION ||
      !candidate.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='entities'").get()
    ) {
      throw new Error('Unsupported Sleeve Notes database');
    }
    if (candidate.pragma('quick_check', { simple: true }) !== 'ok')
      throw new Error('Corrupt Sleeve Notes database');
    migrate(candidate);
    candidate.prepare('SELECT id, wording, source_document_id FROM sleeve_claims LIMIT 0').all();
    candidate.prepare('SELECT claim_id, aired_at FROM sleeve_claim_uses LIMIT 0').all();
    candidate.prepare('SELECT use_id FROM sleeve_spark_feedback LIMIT 0').all();
    candidate.prepare('SELECT segment_id FROM sleeve_segment_lines LIMIT 0').all();
    if (candidate.pragma('foreign_key_check').length)
      throw new Error('Sleeve Notes database has broken references');
    candidate
      .prepare(
        "UPDATE sleeve_airing_reviews SET state='queued',lease_token=NULL WHERE state='running'",
      )
      .run();
    candidate
      .prepare(
        "UPDATE sleeve_research_jobs SET state='queued', run_after=NULL WHERE state='running'",
      )
      .run();
    candidate.pragma('wal_checkpoint(TRUNCATE)');
    candidate.pragma('journal_mode = DELETE');
  } finally {
    candidate.close();
  }
}

/** Publish a prepared snapshot without yielding between close, swap and reopen. */
export function restorePreparedBackup(path: string): void {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const staged = `${DB_PATH}.${randomUUID()}.restore`;
  try {
    copyFileSync(path, staged);
    close();
    renameSync(staged, DB_PATH);
    rmSync(`${DB_PATH}-wal`, { force: true });
    rmSync(`${DB_PATH}-shm`, { force: true });
    open();
  } finally {
    rmSync(staged, { force: true });
  }
}

/** Initialise the first public schema; never rewrite an experimental database. */
export function migrate(d: Database.Database): void {
  const version = Number(d.pragma('user_version', { simple: true }));
  // Supported public stores upgrade without resetting research or operator decisions.
  if ((version === 1 || version === 2) && Number(d.pragma('application_id', { simple: true })) === APPLICATION_ID) {
    d.transaction(() => {
      d.exec(RESEARCH_INDEXES);
      if (!d.prepare("SELECT 1 FROM pragma_table_info('sleeve_connection_edges') WHERE name='source_local_track_id'").get())
        d.exec('ALTER TABLE sleeve_connection_edges ADD COLUMN source_local_track_id TEXT REFERENCES sleeve_connection_library_tracks(local_track_id) ON DELETE SET NULL');
      d.exec('CREATE INDEX IF NOT EXISTS idx_sleeve_connection_source_local ON sleeve_connection_edges(source_local_track_id)');
      d.pragma(`user_version = ${SCHEMA_VERSION}`);
    })();
    return;
  }
  if (
    version === SCHEMA_VERSION &&
    Number(d.pragma('application_id', { simple: true })) === APPLICATION_ID
  )
    return;
  if (
    version !== 0 ||
    d
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1",
      )
      .get()
  ) {
    throw new Error(
      'Unsupported Sleeve Notes database. Back up and reset only sleeve-notes.db before enabling this build; station settings and the music library must be retained.',
    );
  }
  d.transaction(() => {
    d.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
    d.exec(RESEARCH_INDEXES);
    d.pragma(`application_id = ${APPLICATION_ID}`);
    d.pragma(`user_version = ${SCHEMA_VERSION}`);
  })();
}

export function schemaVersion(): number {
  return (open().pragma('user_version', { simple: true }) as number) || 0;
}
