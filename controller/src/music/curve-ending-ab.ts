// A/B: the curve-derived tail readings (curve-ending.ts) against the stored
// librosa tail facet. `npm run curve-ab`. Read-only: one SELECT; the curve
// readings are computed in memory and never written.
//
//   npm run curve-ab                    the whole library
//   npm run curve-ab -- --sample 300    a random 300 tracks (seeded: --seed N)
//   npm run curve-ab -- --list 20       also list the 20 widest disagreements
//
// It also lists the fades transitions.tailFromCurve would newly cut through
// the whole-track fallback (music/silence-trim.ts): the tail series never
// reaches the audible-end threshold, the whole-track series does. Those cuts
// can be tens of seconds, so check them by ear before turning the switch on.
//
// Opening the library DB can seed track_facet_status when it is missing (as
// `npm run facets`); safe beside a running controller (WAL).

import * as db from './library-db.js';
import * as embeddings from './embeddings.js';
import * as settings from '../settings.js';
import { deriveCurveEnding } from './curve-ending.js';
import { audibleEndSec, parseLoudnessCurve } from './loudness-curve.js';
import { parseWholeLoudnessCurve } from './whole-loudness-curve.js';

process.on('exit', () => {
  try { if (db.isOpen()) db.close(); } catch { /* best-effort */ }
});

interface Row {
  id: string; artist: string | null; title: string | null; file_suffix: string | null;
  decoded_duration_ms: number | null; edge_tail_ms: number | null; loudness_lufs: number | null;
  outro_json: string; loudness_curve_json: string;
}

const num = (args: string[], flag: string): number | null => {
  const i = args.indexOf(flag);
  const v = i >= 0 ? Number(args[i + 1]) : NaN;
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
};

// Deterministic shuffle (mulberry32), so a --sample is repeatable.
function shuffled<T>(xs: T[], seed: number): T[] {
  let a = seed >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = xs.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const q = (xs: number[], p: number): number => {
  const s = xs.slice().sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : NaN;
};
const f = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : '—');

async function main() {
  const args = process.argv.slice(2);
  await settings.load();
  await db.open({ embeddingDim: embeddings.resolveEmbeddingDim(), adoptStoredDim: true });
  const dial = Number(settings.get()?.transitions?.fadeAudibleEndDb ?? 20);

  let rows = db.requireDb().prepare(
    `SELECT id, artist, title, file_suffix, decoded_duration_ms, edge_tail_ms, loudness_lufs, outro_json, loudness_curve_json
       FROM tracks WHERE outro_json IS NOT NULL AND loudness_curve_json IS NOT NULL`,
  ).all() as Row[];
  const sample = num(args, '--sample');
  if (sample) rows = shuffled(rows, num(args, '--seed') ?? 23).slice(0, sample);

  let n = 0, agree = 0, noCurve = 0;
  const conf: Record<string, number> = {};
  const byFormat: Record<string, [number, number]> = {};
  const dStart: number[] = [], dLufs: number[] = [], dAudible: number[] = [];
  let audibleBoth = 0, audibleOnlyOld = 0, audibleOnlyNew = 0;
  const disagreements: Array<{ row: Row; librosa: string; drop: number }> = [];
  const wholeCuts: Array<{ row: Row; cutSec: number; earlierSec: number }> = [];

  for (const row of rows) {
    let outro: { ending?: string; startMs?: number; lufs?: number | null; loudnessCurve?: unknown };
    try { outro = JSON.parse(row.outro_json); } catch { continue; }
    if (outro.ending !== 'fade' && outro.ending !== 'cold') continue;
    const curve = parseWholeLoudnessCurve(row.loudness_curve_json);
    const d = deriveCurveEnding(curve, {
      decodedDurationMs: row.decoded_duration_ms, edgeTailMs: row.edge_tail_ms,
    });
    if (!d) { noCurve++; continue; }
    n++;
    const k = `${outro.ending}→${d.ending}`;
    conf[k] = (conf[k] ?? 0) + 1;
    const fmt = (row.file_suffix ?? '?').toLowerCase();
    const bf = (byFormat[fmt] ??= [0, 0]);
    bf[0]++;
    if (outro.ending === d.ending) { agree++; bf[1]++; } else disagreements.push({ row, librosa: outro.ending, drop: d.endDropDb });
    if (typeof outro.startMs === 'number') dStart.push((d.startMs - outro.startMs) / 1000);
    if (typeof outro.lufs === 'number' && d.lufs != null) dLufs.push(d.lufs - outro.lufs);
    // The whole-track fallback: a curve fade the tail series cannot cut.
    if (d.ending === 'fade' && curve && audibleEndSec(d.loudnessCurve, row.loudness_lufs, dial) == null) {
      const w = audibleEndSec(curve.whole, row.loudness_lufs, dial);
      if (w != null && w * 1000 < d.musicEndMs) wholeCuts.push({ row, cutSec: w, earlierSec: d.musicEndMs / 1000 - w });
    }
    // The audible-end cut, as silence-trim would place it on a fade, from each curve.
    if (outro.ending === 'fade' && d.ending === 'fade') {
      const old = parseLoudnessCurve(outro.loudnessCurve);
      const a = old ? audibleEndSec(old, row.loudness_lufs, dial) : null;
      const b = audibleEndSec(d.loudnessCurve, row.loudness_lufs, dial);
      if (a != null && b != null) { audibleBoth++; dAudible.push(b - a); }
      else if (a != null) audibleOnlyOld++;
      else if (b != null) audibleOnlyNew++;
    }
  }

  console.log(`tracks compared: ${n}${sample ? ` (random sample of ${rows.length})` : ''}; no curve tail/end: ${noCurve}`);
  console.log(`fade/cold agreement: ${pct(agree, n)}  (librosa→curve: ${Object.entries(conf).map(([k, v]) => `${k} ${v}`).join(', ')})`);
  console.log(`  by format: ${Object.entries(byFormat).sort((a, b) => b[1][0] - a[1][0]).slice(0, 6)
    .map(([k, [t, a]]) => `${k} ${pct(a, t)} of ${t}`).join(', ')}`);
  const near = disagreements.filter(x => Math.abs(x.drop - 9) <= 3).length;
  console.log(`  disagreements within 3 dB of the 9 dB threshold: ${pct(near, disagreements.length)}`);
  const aS = dStart.map(Math.abs);
  console.log(`wind-down start (curve − librosa): median ${f(q(dStart, 0.5))} s; |gap| median ${f(q(aS, 0.5))} s, p90 ${f(q(aS, 0.9))} s, within 1 s ${pct(aS.filter(x => x <= 1).length, aS.length)}`);
  const aL = dLufs.map(Math.abs);
  console.log(`tail loudness (curve − librosa): median ${f(q(dLufs, 0.5))} dB; |gap| p90 ${f(q(aL, 0.9))} dB`);
  const aA = dAudible.map(Math.abs);
  console.log(`audible-end cut at ${dial} dB (fades both agree on, ${audibleBoth} cut by both): median ${f(q(dAudible, 0.5))} s; |gap| median ${f(q(aA, 0.5))} s, p90 ${f(q(aA, 0.9))} s; only librosa's curve cuts: ${audibleOnlyOld}, only the new one: ${audibleOnlyNew}`);

  const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const wc = wholeCuts.map(x => x.earlierSec);
  console.log(`whole-track fallback at ${dial} dB (tailFromCurve): ${wholeCuts.length} fades newly cut; before the music's end by median ${f(q(wc, 0.5), 0)} s, max ${f(wc.length ? Math.max(...wc) : NaN, 0)} s`);
  for (const x of wholeCuts.sort((a, b) => b.earlierSec - a.earlierSec).slice(0, 25)) {
    console.log(`  ${f(x.earlierSec, 0).padStart(4)} s earlier, cut at ${mmss(x.cutSec)} (body ${x.row.loudness_lufs ?? '?'} LUFS)  ${x.row.artist ?? '?'} — ${x.row.title ?? '?'}  [${x.row.id}]`);
  }

  const list = num(args, '--list');
  if (list) {
    console.log(`\nwidest disagreements (furthest from the 9 dB threshold):`);
    for (const x of disagreements.sort((a, b) => Math.abs(b.drop - 9) - Math.abs(a.drop - 9)).slice(0, list)) {
      console.log(`  ${x.row.id}  librosa ${x.librosa}, curve end ${f(x.drop, 1)} dB under the tail  ${x.row.artist ?? '?'} — ${x.row.title ?? '?'}`);
    }
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
