// Per-facet analysis status CLI — `npm run facets`. Read-only.
//
//   npm run facets             per-facet counts (ok / unmeasurable / failed / missing / needs)
//   npm run facets -- --check  also verify the facet table against the analysis
//                              columns and the legacy scope queries; exit 1 on any drift
//
// Opening the library DB creates and seeds track_facet_status if it is missing
// (the only write this command can cause). Safe beside a running controller:
// SQLite WAL allows a concurrent reader.

import * as db from './library-db.js';
import * as embeddings from './embeddings.js';
import * as settings from '../settings.js';
import { checkFacets } from './facet-check.js';

process.on('exit', () => {
  try { if (db.isOpen()) db.close(); } catch { /* best-effort */ }
});

const pad = (v: string | number, n: number) => String(v).padStart(n);

async function main() {
  const args = process.argv.slice(2);
  await settings.load();
  await db.open({ embeddingDim: embeddings.resolveEmbeddingDim(), adoptStoredDim: true });

  const counts = db.facetCounts();
  console.log(`facet      version ${pad('ok', 8)} ${pad('unmeas.', 8)} ${pad('failed', 7)} ${pad('missing', 8)} ${pad('needs', 8)}`);
  for (const c of counts) {
    console.log(
      `${c.facet.padEnd(10)} v${pad(db.FACET_VERSIONS[c.facet], 6)} ${pad(c.ok, 8)} ${pad(c.unmeasurable, 8)} ` +
        `${pad(c.failed, 7)} ${pad(c.missing, 8)} ${pad(c.needs, 8)}`,
    );
  }
  console.log(`(${counts[0]?.total ?? 0} tracks; "needs" = missing/outdated/failed under ${db.FACET_MAX_ATTEMPTS} consecutive failures)`);

  if (!args.includes('--check')) return;

  console.log('\nconsistency check:');
  const t0 = Date.now();
  const r = checkFacets();
  console.log(`  ${r.rows} facet rows for ${r.tracks} tracks, ${r.orphans} orphan track ids`);
  console.log(`  row drift vs columns: ${r.driftCount}`);
  for (const x of r.drift) console.log(`    ${x.id} ${x.facet}: stored ${x.stored}, columns say ${x.derived}`);
  for (const s of r.scopes) {
    const same = s.onlyLegacyCount === 0 && s.onlyFacetCount === 0;
    console.log(
      `  ${same ? '✓' : '✗'} ${s.facet.padEnd(6)} needs ${s.facetCount} vs ${s.legacy} ${s.legacyCount}` +
        (same ? '' : ` (only legacy: ${s.onlyLegacyCount}, only facet: ${s.onlyFacetCount})`),
    );
    if (s.onlyLegacy.length) console.log(`      only legacy e.g. ${s.onlyLegacy.join(', ')}`);
    if (s.onlyFacet.length) console.log(`      only facet  e.g. ${s.onlyFacet.join(', ')}`);
  }
  console.log(`${r.ok ? '✓ facet table consistent' : '✗ facet table drifted'} (${Date.now() - t0} ms)`);
  if (!r.ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`[facets] ${err?.stack || err}`);
  process.exit(1);
});
