// Opening, closing, backing up and resetting the database file. The only writer
// of the handle in handle.ts.

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { randomUUID } from 'node:crypto';
import { copyFile, rm } from 'node:fs/promises';
import { DB_PATH, getDb, getEmbeddingDim, requireDb, setHandle } from './handle.js';
import { invalidateStats } from './stats.js';
import { migrate } from './schema.js';
import { maybeMigrateFromMoodsJson } from './legacy.js';

// `reseed`: on an embedding-dim mismatch, drop the stale-dim vectors and rebuild
// rather than throwing. `adoptStoredDim` (live controller only): the DB's dim
// wins, so the runtime never wipes a tagged index (#319); the tagger leaves it
// off so a deliberate model swap still hits the --reseed gate.
export async function open(opts: {
  embeddingDim: number;
  reseed?: boolean;
  adoptStoredDim?: boolean;
}): Promise<void> {
  if (getDb()) {
    if (!opts.adoptStoredDim && opts.embeddingDim !== getEmbeddingDim()) {
      throw new Error(
        `library-db already open with embedding dim ${getEmbeddingDim()}; ` +
          `caller asked for ${opts.embeddingDim}. Use --reseed to switch models.`,
      );
    }
    return;
  }
  const db = new Database(DB_PATH);
  setHandle({
    db,
    embeddingDim: opts.embeddingDim,
    nonce: randomUUID().slice(0, 8),
  });
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  // Cap the -wal sidecar so a checkpoint truncates it; uncapped it balloons on a
  // bulk write pass and every later query walks it (#786).
  db.pragma('journal_size_limit = 67108864'); // 64 MiB
  sqliteVec.load(db);

  // migrate() may adopt the stored dim; trust its return as the live schema dim.
  setHandle({
    embeddingDim: await migrate(
      opts.embeddingDim,
      opts.reseed === true,
      opts.adoptStoredDim === true,
    ),
  });
  await maybeMigrateFromMoodsJson();
}

export function close(): void {
  const db = getDb();
  if (db) {
    // Fold the WAL back in: SQLite only auto-checkpoints on the last connection
    // and three processes hold the DB. Synchronous, safe from an 'exit' hook.
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      /* busy/readonly — the hourly checkpoint or next close gets it */
    }
    db.close();
    setHandle({ db: null, embeddingDim: null });
    // A reopened library must not serve the previous handle's cached tallies.
    invalidateStats();
  }
}

export function isOpen(): boolean {
  return getDb() !== null;
}

// Best-effort wal_checkpoint(TRUNCATE); busy=1 means a concurrent reader blocked
// it and the next run catches up. Null when the DB isn't open.
export function checkpointWal(): { busy: number; log: number; checkpointed: number } | null {
  const db = getDb();
  if (!db) return null;
  try {
    const row = db.pragma('wal_checkpoint(TRUNCATE)') as Array<{
      busy: number;
      log: number;
      checkpointed: number;
    }>;
    return row?.[0] ?? null;
  } catch {
    return null;
  }
}

// Online backup API, not a file copy: in WAL mode a copy misses un-checkpointed
// pages in the -wal sidecar.
export async function backup(destPath: string): Promise<void> {
  await requireDb().backup(destPath);
}

// Close, swap in the backup, clear the stale WAL/SHM sidecars. Caller reopens.
export async function restoreFromFile(srcPath: string): Promise<void> {
  close();
  await copyFile(srcPath, DB_PATH);
  await rm(`${DB_PATH}-wal`, { force: true });
  await rm(`${DB_PATH}-shm`, { force: true });
}

// Delete the DB and sidecars so the next open() recreates an empty schema.
// Irreversible short of a backup restore. Caller reopens.
export async function reset(): Promise<void> {
  close();
  await rm(DB_PATH, { force: true });
  await rm(`${DB_PATH}-wal`, { force: true });
  await rm(`${DB_PATH}-shm`, { force: true });
}


