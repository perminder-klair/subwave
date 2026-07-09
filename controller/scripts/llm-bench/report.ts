// Run-record accumulation + reporting for llm-bench. JSON is flushed after
// every record so a Ctrl-C or crash still leaves a usable report on disk.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Outcome = 'ok' | 'violation' | 'thrown' | 'skipped';

export interface RunRecord {
  model: string;          // provider:model
  kind: string;
  group: string;
  mode: string;           // pool | agent | any
  scenario: string;
  iteration: number;
  outcome: Outcome;
  violations: string[];
  bucket?: string;        // thrown only: no-object-generated | timeout | unreachable | thrown
  error?: string;
  ms: number;
  tokens?: number | null;
  response?: string;      // short preview for eyeballing the JSON later
}

export class Reporter {
  records: RunRecord[] = [];
  private meta: any;

  constructor(private outPath: string, meta: any) {
    this.meta = { ...meta, startedAt: new Date().toISOString() };
    mkdirSync(dirname(outPath), { recursive: true });
  }

  add(r: RunRecord) {
    this.records.push(r);
    this.flush();
  }

  flush() {
    writeFileSync(this.outPath, JSON.stringify({ meta: this.meta, records: this.records }, null, 1));
  }

  printSummary() {
    const models = [...new Set(this.records.map(r => r.model))];
    const cells = new Map<string, RunRecord[]>();
    const rowKeys: string[] = [];
    for (const r of this.records) {
      const row = `${r.kind} / ${r.scenario}`;
      if (!rowKeys.includes(row)) rowKeys.push(row);
      const key = `${row}|${r.model}`;
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key)!.push(r);
    }

    const rowW = Math.max(28, ...rowKeys.map(k => k.length + 2));
    const colW = Math.max(18, ...models.map(m => m.length + 2));
    console.log('\n=== llm-bench summary ===\n');
    console.log(''.padEnd(rowW) + models.map(m => m.padEnd(colW)).join(''));
    for (const row of rowKeys) {
      const line = models.map(m => {
        const rs = cells.get(`${row}|${m}`) || [];
        if (!rs.length) return '—'.padEnd(colW);
        if (rs.every(r => r.outcome === 'skipped')) return 'skipped'.padEnd(colW);
        const ok = rs.filter(r => r.outcome === 'ok').length;
        const okMs = rs.filter(r => r.outcome !== 'skipped').map(r => r.ms).sort((a, b) => a - b);
        const p50 = okMs.length ? okMs[Math.floor(okMs.length / 2)] : 0;
        return `${Math.round((100 * ok) / rs.length)}% (${(p50 / 1000).toFixed(1)}s)`.padEnd(colW);
      }).join('');
      console.log(row.padEnd(rowW) + line);
    }

    for (const m of models) {
      const mine = this.records.filter(r => r.model === m && r.outcome !== 'skipped');
      const viol = new Map<string, number>();
      const thrown = new Map<string, number>();
      for (const r of mine) {
        for (const v of r.violations) viol.set(v, (viol.get(v) || 0) + 1);
        if (r.outcome === 'thrown') thrown.set(r.bucket || 'thrown', (thrown.get(r.bucket || 'thrown') || 0) + 1);
      }
      const ok = mine.filter(r => r.outcome === 'ok').length;
      console.log(`\n--- ${m}: ${ok}/${mine.length} ok`);
      if (viol.size) {
        console.log('    rule failures: ' + [...viol.entries()].sort((a, b) => b[1] - a[1])
          .map(([k, n]) => `${k}×${n}`).join('  '));
      }
      if (thrown.size) {
        console.log('    thrown:        ' + [...thrown.entries()].map(([k, n]) => `${k}×${n}`).join('  '));
      }
    }
    console.log(`\nFull report: ${this.outPath}\n`);
  }
}

export function bucketError(err: any, isUnreachable: (e: any) => boolean): string {
  const msg = String(err?.message || err || '').toLowerCase();
  if (isUnreachable(err)) return 'unreachable';
  if (msg.includes('no object generated') || msg.includes('did not call the done tool')) return 'no-object-generated';
  if (msg.includes('no output generated')) return 'no-output';
  if (msg.includes('timed out') || msg.includes('deadline') || msg.includes('abort')) return 'timeout';
  return 'thrown';
}
