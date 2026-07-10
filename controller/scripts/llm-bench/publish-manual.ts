// Publish llm-bench reports to the manual's model-results table.
//
//   npm run llm-bench:publish -- reports/community-validation.json [more.json…]
//
// Aggregates each report's records into per-model rows (overall + per-group
// pass rates, pool-pick p50) and MERGES them into web/lib/llm-bench-results.json
// — the data file behind /manual/llm's results table. Merge key is the model
// label (provider:model [r:…]); measured fields are overwritten by the newer
// report, while hand-written editorial fields (`verdict`, `notes`) are
// preserved so re-publishing never erases curation. New models get empty
// editorial fields to fill in by hand.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const WEB_DATA = resolve(join(here, '../../../web/lib/llm-bench-results.json'));

// group+mode → the table's column buckets.
function bucketOf(r: any): string | null {
  if (r.group === 'pick') return r.mode === 'agent' ? 'pickAgent' : 'pickPool';
  if (r.group === 'segment') return r.mode === 'agent' ? 'segAgent' : 'segPool';
  if (r.group === 'request') return 'requests';
  if (r.group === 'scripts') return 'scripts';
  if (r.group === 'banter' || r.group === 'programme') return 'shows';
  return null;
}

function summarise(report: any) {
  const byModel = new Map<string, any[]>();
  for (const r of report.records) {
    if (r.outcome === 'skipped') continue;
    if (!byModel.has(r.model)) byModel.set(r.model, []);
    byModel.get(r.model)!.push(r);
  }
  const rows: any[] = [];
  for (const [model, recs] of byModel) {
    const groups: Record<string, { ok: number; total: number }> = {};
    for (const r of recs) {
      const b = bucketOf(r);
      if (!b) continue;
      groups[b] = groups[b] || { ok: 0, total: 0 };
      groups[b].total++;
      if (r.outcome === 'ok') groups[b].ok++;
    }
    const ok = recs.filter(r => r.outcome === 'ok').length;
    const poolPickMs = recs
      .filter(r => r.kind === 'pickNextTrack' && r.outcome !== 'thrown')
      .map(r => r.ms)
      .sort((a, b) => a - b);
    const [provider] = model.split(':');
    rows.push({
      model,
      route: provider,
      benchedAt: (report.meta?.startedAt || '').slice(0, 10),
      iterations: report.meta?.iterations ?? null,
      reasoning: report.meta?.reasoning ?? null,
      coverage: Object.keys(groups).length >= 7 ? 'full' : Object.keys(groups).sort().join('+'),
      overall: { ok, total: recs.length },
      groups,
      poolPickP50s: poolPickMs.length
        ? Math.round(poolPickMs[Math.floor(poolPickMs.length / 2)] / 100) / 10
        : null,
      verdict: '',
      notes: '',
    });
  }
  return rows;
}

const files = process.argv.slice(2).filter(a => !a.startsWith('--'));
if (!files.length) {
  console.error('Usage: npm run llm-bench:publish -- <report.json> [more…]');
  process.exit(2);
}

const existing: any[] = existsSync(WEB_DATA)
  ? JSON.parse(readFileSync(WEB_DATA, 'utf8')).models
  : [];
const byKey = new Map(existing.map((e: any) => [e.model, e]));

for (const f of files) {
  const report = JSON.parse(readFileSync(resolve(f), 'utf8'));
  for (const row of summarise(report)) {
    const prev = byKey.get(row.model);
    // Preserve hand-written editorial fields across re-publishes.
    if (prev) {
      row.verdict = prev.verdict || '';
      row.notes = prev.notes || '';
    }
    byKey.set(row.model, row);
    console.log(`${prev ? 'updated' : 'added  '} ${row.model}  ${row.overall.ok}/${row.overall.total}`);
  }
}

const models = [...byKey.values()].sort(
  (a: any, b: any) => b.overall.ok / b.overall.total - a.overall.ok / a.overall.total,
);
writeFileSync(WEB_DATA, JSON.stringify({ updatedAt: new Date().toISOString().slice(0, 10), models }, null, 1));
console.log(`\nwrote ${models.length} model(s) → ${WEB_DATA}`);
