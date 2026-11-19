import Database from 'better-sqlite3';
import { eligibleSleeveNotesForSegmentInDatabase, inspectExtendedSleeveNoteInDatabase } from './link-selection.js';

process.on('disconnect', () => process.exit(0));
process.on('message', (message: {
  id: number;
  path: string;
  selection: {
    kind: 'link' | 'segment';
    current: { id?: unknown; artist?: unknown } | null | undefined;
    nowMs: number;
    enabled: boolean;
    geniusEnabled: boolean;
    manual: boolean;
  };
}) => {
  let db: Database.Database | null = null;
  let result: ReturnType<typeof inspectExtendedSleeveNoteInDatabase> | ReturnType<typeof eligibleSleeveNotesForSegmentInDatabase> | undefined;
  let error: string | undefined;
  try {
    db = new Database(message.path, { readonly: true, fileMustExist: true });
    db.pragma('cache_size = -8192');
    db.exec('BEGIN');
    const started = performance.now();
    result = message.selection.kind === 'segment'
      ? eligibleSleeveNotesForSegmentInDatabase(db, String(message.selection.current?.id ?? ''),
        message.selection.current?.artist, message.selection.nowMs, message.selection.manual,
        message.selection.geniusEnabled)
      : inspectExtendedSleeveNoteInDatabase(
        db, message.selection.current, message.selection.nowMs, false,
        message.selection.enabled, message.selection.geniusEnabled,
      );
    db.exec('COMMIT');
    const elapsed = Math.round(performance.now() - started);
    if (elapsed >= 250) console.warn(`[sleeve-notes] Slow candidate selection: ${elapsed}ms (worker)`);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : 'Sleeve Notes selection failed';
  } finally {
    try {
      db?.close();
    } catch (cause) {
      error ??= cause instanceof Error ? cause.message : String(cause);
    }
    process.send?.({ id: message.id, result, error });
  }
});
