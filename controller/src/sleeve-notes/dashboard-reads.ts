import {researchProgress,researchStorage} from './research-diagnostics.js';
import { researchQueueDetails } from './research-worker.js';
import type Database from 'better-sqlite3';
import { geniusQueueReadout, researchStoreReadoutInDatabase } from './research-repository.js';
import { liveNotesSummary } from './live-summary.js';
import { heardOnAir } from './heard-on-air.js';

export type DashboardRead = {kind:'storage'} | { kind: 'readout'; queue?: boolean }
  | { kind: 'live-summary'; args: [Parameters<typeof liveNotesSummary>[0], Parameters<typeof liveNotesSummary>[1], Parameters<typeof liveNotesSummary>[2]] }
  | { kind: 'heard-on-air'; offset: number; filters: Parameters<typeof heardOnAir>[3] };

/** Pure reads: worker owns the read-only snapshot; no settings or queue mutations. */
export function dashboardReadInDatabase(db: Database.Database, input: DashboardRead) {
  switch (input.kind) {
    case 'storage': return researchStorage(db);
    case 'readout': return {
      progress: researchProgress(db),
      ...researchStoreReadoutInDatabase(db),
      ...(input.queue === undefined ? {} : { activity: {
        items: researchQueueDetails(new Date(), input.queue, db),
        reviews: db.prepare(`SELECT id,state,
          CASE WHEN json_valid(context_json) THEN json_extract(context_json,'$.artist') END AS artist,
          CASE WHEN json_valid(context_json) THEN json_extract(context_json,'$.title') END AS title
          FROM sleeve_airing_reviews WHERE state IN ('queued','running') ORDER BY created_at,id`).all(),
        promotions: db.prepare('SELECT job_id,requested_at FROM sleeve_queue_promotions').all(),
        genius: geniusQueueReadout(new Date(), db),
      }}),
    };
    case 'live-summary': return liveNotesSummary(...input.args, db);
    case 'heard-on-air': return heardOnAir(20, input.offset, true, input.filters, db);
  }
}
