import { dashboardReadInDatabase, type DashboardRead } from './dashboard-reads.js';
import { searchResearchStoriesInDatabase } from './research-repository.js';
import {externalDiscoveriesInDatabase} from './external-discoveries.js';
// Read-only CPU work in a separate process. No provider calls and no writes to
// station state: the controller owns validation and atomic index publication.
import Database from 'better-sqlite3';
import { buildConnectionLibraryPatch, connectionRevision } from './library-connections.js';
import { researchConnectionsOverviewInDatabase } from './connections-overview.js';
import type { ConnectionEdgeType } from './research-repository.js';

process.on('disconnect', () => process.exit(0));
process.on('message', (message: { id: number; path: string; kind: 'overview' | 'matches' | 'discoveries' | 'library-stories' | 'dashboard'; dashboard?: DashboardRead; input?: Parameters<typeof searchResearchStoriesInDatabase>[1]; edges?: ConnectionEdgeType[] }) => {
  let db: Database.Database | null = null;
  try {
    db = new Database(message.path, { readonly: true, fileMustExist: true });
    db.pragma('cache_size = -8192');
    // All inputs and the revision come from the same WAL snapshot.
    db.exec('BEGIN');
    const started = performance.now();
    const result = message.kind === 'dashboard' ? JSON.stringify(dashboardReadInDatabase(db, message.dashboard!)) : message.kind === 'library-stories' ? searchResearchStoriesInDatabase(db, message.input) : message.kind === 'matches' ? buildConnectionLibraryPatch(db) : {
      revision: connectionRevision(db, 'overview'),
      json: JSON.stringify(message.kind==='discoveries'?externalDiscoveriesInDatabase(db):{ active: true, ...researchConnectionsOverviewInDatabase(db, message.edges) }),
    };
    db.exec('COMMIT');
    const elapsed = Math.round(performance.now() - started);
    if (elapsed >= 2_000) console.warn(`[sleeve-notes] Slow read ${message.dashboard?.kind ?? message.kind}: ${elapsed}ms (worker)`);
    process.send?.({ id: message.id, result });
  } catch (error) {
    process.send?.({ id: message.id, error: error instanceof Error ? error.message : 'Connection calculation failed' });
  } finally { db?.close(); }
});
