// Adoption and its recovery map commit in the same SQLite transaction. The
// controller may consume the map before library.load(), so use an existing
// handle or a short-lived connection without opening/reseeding vector indexes.
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { DB_PATH, getDb } from './handle.js';

function withJournal<T>(empty: T, run: (d: Database.Database) => T): T {
  const live = getDb();
  if (!live && !existsSync(DB_PATH)) return empty;
  const d = live ?? new Database(DB_PATH, { fileMustExist: true });
  try {
    // An older library has no journal until its first open on the new schema.
    if (!d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'id_rotation_journal'").get()) return empty;
    return run(d);
  } finally {
    if (!live) d.close();
  }
}

export function pendingIdRotations(): Map<string, string> {
  return withJournal(new Map<string, string>(), (d) => {
    const rows = d.prepare('SELECT old_id, new_id FROM id_rotation_journal').all() as Array<{ old_id: string; new_id: string }>;
    return new Map(rows.map((r) => [r.old_id, r.new_id]));
  });
}

// Acknowledge only this snapshot; an adoption committed by another process
// while the controller awaited file writes must remain available for replay.
export function acknowledgeIdRotations(map: ReadonlyMap<string, string>): void {
  withJournal(undefined, (d) => {
    const del = d.prepare('DELETE FROM id_rotation_journal WHERE old_id = ? AND new_id = ?');
    d.transaction(() => {
      for (const [old, neu] of map) del.run(old, neu);
    })();
  });
}
