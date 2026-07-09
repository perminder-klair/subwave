#!/usr/bin/env node
/* ============================================================================
   SUB/WAVE — Library Observatory · browser stress harness (#957)

   Drives the REAL /observatory page (galaxy renderer, WebGL) against
   synthetic libraries of arbitrary size — 200k+ tracks — with the entire
   controller API mocked at the network layer, and measures what an operator
   would feel:

     · payload size + fetch→parse→layoutTracks→first-commit time
     · main-thread long tasks during load / zoom / pan / filter / select
     · frame cadence (rAF deltas) while zooming and panning
     · hover-pick + node-select + filter-toggle main-thread latency
     · label-layer + SVG-overlay DOM node counts (they must stay O(1)-bounded
       regardless of N — that's the PR's design contract)
     · JS heap after load

   This is a dev tool, not part of any suite: it needs a production build of
   web/ running (dev-mode React double-renders and skews everything), plus the
   `playwright` npm package (NOT a repo dependency — install ad hoc).

   Usage:
     cd web
     npm run build && npx next start -p 7799 &
     npm i --no-save playwright        # or: export PLAYWRIGHT_DIR=/path/with/node_modules
     node scripts/observatory-stress.mjs --sizes 25000,100000,200000 \
         --url http://localhost:7799 [--dpr 1] [--shot /tmp/galaxy.png] [--out results.json]

   Frame-time caveat: headless Chromium renders WebGL on SwiftShader (software
   GL) unless a GPU is exposed — the harness prints the GL renderer string with
   the results. SwiftShader numbers are a worst-case floor for the GPU-bound
   metrics (frame cadence during zoom/pan); the main-thread metrics (parse,
   layout, long tasks, pick/filter/select latency) are hardware-honest.
   ============================================================================ */

import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const req = createRequire(import.meta.url);
function loadPlaywright() {
  try {
    return req('playwright');
  } catch {
    const dir = process.env.PLAYWRIGHT_DIR;
    if (!dir) {
      console.error('playwright is not installed here. Run `npm i --no-save playwright`');
      console.error('or point PLAYWRIGHT_DIR at a directory whose node_modules has it.');
      process.exit(1);
    }
    return createRequire(join(dir, 'package.json'))('playwright');
  }
}

// ---- args -------------------------------------------------------------------
const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1] ?? ''] : null)).filter(Boolean),
);
const SIZES = (args.sizes || '25000,100000,200000').split(',').map((s) => Number(s.trim())).filter((n) => n > 0);
const BASE = args.url || 'http://localhost:7799';
const DPR = Number(args.dpr) || 1;
const OUT = args.out || null;
const SHOT = args.shot || null;

// ---- synthetic library (mirrors RawTrack in components/observatory/data.ts) --
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const GENRES = Array.from({ length: 120 }, (_, i) => `Genre ${String(i).padStart(3, '0')}`);
const MOODS = ['hazy', 'reflective', 'calm', 'night', 'rainy', 'romantic', 'energetic', 'driving', 'celebratory', 'melancholy', 'warm', 'cold'];
const SOURCES = ['llm', 'llm', 'llm', 'propagated', 'propagated', 'manual', 'uncertain-llm', 'legacy-v1'];
const ENERGIES = ['low', 'medium', 'high'];

function buildPayload(n) {
  const rng = mulberry32(0x0b5e55 ^ n);
  const tracks = new Array(n);
  const byGenre = {}; const byMood = {}; const byEnergy = {}; const bySource = {};
  for (let i = 0; i < n; i++) {
    const genre = GENRES[Math.floor(rng() * rng() * GENRES.length)];
    const analysed = rng() < 0.6;
    const mapped = rng() < 0.7; // engages the sound-map layout, like a projected library
    const energy = ENERGIES[Math.floor(rng() * 3)];
    const source = SOURCES[Math.floor(rng() * SOURCES.length)];
    const moods = Array.from({ length: 1 + Math.floor(rng() * 3) }, () => MOODS[Math.floor(rng() * MOODS.length)]);
    byGenre[genre] = (byGenre[genre] || 0) + 1;
    byEnergy[energy] = (byEnergy[energy] || 0) + 1;
    bySource[source] = (bySource[source] || 0) + 1;
    for (const m of moods) byMood[m] = (byMood[m] || 0) + 1;
    tracks[i] = {
      id: `trk-${String(i).padStart(7, '0')}`,
      title: `Track ${i} of the Long Tail`,
      artist: `Artist ${i % 40000}`,
      album: `Album ${i % 60000}`,
      year: 1970 + (i % 55),
      genre,
      durationSec: 120 + Math.floor(rng() * 300),
      moods,
      energy,
      source,
      confidence: Math.round(rng() * 100) / 100,
      bpm: analysed ? Math.round((60 + rng() * 120) * 10) / 10 : null,
      musicalKey: analysed ? `${1 + Math.floor(rng() * 12)}${rng() < 0.5 ? 'A' : 'B'}` : null,
      analysisConfidence: analysed ? Math.round((0.5 + rng() * 0.5) * 100) / 100 : null,
      loudnessLufs: analysed ? Math.round((-24 + rng() * 16) * 10) / 10 : null,
      paceMean: analysed ? Math.round(rng() * 100) / 100 : null,
      vocal: analysed ? (rng() < 0.7 ? 'vocal' : 'instrumental') : null,
      mapX: mapped ? rng() : null,
      mapY: mapped ? rng() : null,
    };
  }
  return JSON.stringify({
    tracks,
    truncated: false,
    sampled: false,
    max: n,
    defaultMax: 25000,
    hardMax: Math.max(200000, n),
    mapProjection: { running: false, startedAt: null, lastLog: [], meta: null, audioVectors: 0, stale: false },
    moodVocab: MOODS,
    stats: {
      total: n, distinctArtists: Math.min(n, 40000), byMood, byEnergy, byGenre, bySource,
      withEmbedding: n, withAudioEmbedding: Math.round(n * 0.7), updatedAt: new Date().toISOString(),
    },
  });
}

const detailPayload = (id) =>
  JSON.stringify({
    track: {
      id, title: 'Detail', artist: 'A', album: 'B', year: 2000, genre: 'Genre 000', durationSec: 200,
      moods: ['calm'], energy: 'low', source: 'llm', confidence: 0.9, taggerVersion: 3, model: 'mock',
      taggedAt: null, lastfmTags: null, lyricExcerpt: null, bpm: 120, musicalKey: '4A', introMs: 4000,
      analysisConfidence: 0.8, analysisVersion: 1, loudnessLufs: -12, peakDb: -1, structure: null,
      vocalRanges: null, pace: null, keyRanges: null, audioMoods: [], audioMoodScores: null, outro: null,
    },
    textEmbedding: null,
    audioEmbedding: null,
    mixNext: [],
  });

// ---- in-page instrumentation --------------------------------------------------
const INIT_SCRIPT = `
  localStorage.setItem('subwave_admin_auth', btoa('stress:stress'));
  window.__lt = [];
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__lt.push({ start: e.startTime, dur: e.duration });
    }).observe({ entryTypes: ['longtask'] });
  } catch {}
  window.__frames = null;
  window.__frameLoop = () => {
    const rec = { deltas: [], last: performance.now(), on: true };
    window.__frames = rec;
    const tick = (t) => {
      if (!rec.on) return;
      rec.deltas.push(t - rec.last);
      rec.last = t;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  window.__frameStop = () => { if (window.__frames) window.__frames.on = false; return window.__frames ? window.__frames.deltas.slice(1) : []; };
`;

const stats = (arr) => {
  if (!arr.length) return { n: 0, avg: 0, p95: 0, max: 0 };
  const s = [...arr].sort((a, b) => a - b);
  return {
    n: arr.length,
    avg: arr.reduce((a, b) => a + b, 0) / arr.length,
    p95: s[Math.floor(s.length * 0.95)],
    max: s[s.length - 1],
  };
};
const fmt = (x) => (x >= 100 ? x.toFixed(0) : x.toFixed(1));

const readLongTasks = (page) => page.evaluate(() => { const l = window.__lt; window.__lt = []; return l; });

// Double-rAF after an interaction ≈ time until the main thread has produced a
// frame again — the user-felt latency of the synchronous work the action kicked off.
const settleLatency = (page) =>
  page.evaluate(
    () =>
      new Promise((res) => {
        const t0 = performance.now();
        requestAnimationFrame(() => requestAnimationFrame(() => res(performance.now() - t0)));
      }),
  );

// The bulk payload is served over REAL HTTP from a side server and reached via
// a redirect, not inlined into route.fulfill: a fulfilled body rides the CDP
// protocol base64-encoded, and at 400k tracks (~150 MB JSON → ~200 MB message)
// that kills the tab outright. The redirect turns the request cross-origin, so
// the browser strips the Authorization header and plain CORS headers suffice.
const PAYLOAD_PORT = 7798;
let currentPayload = '';
function startPayloadServer() {
  const srv = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Timing-Allow-Origin', '*');
    if (req.method === 'OPTIONS') return res.end();
    res.setHeader('Content-Type', 'application/json');
    res.end(currentPayload);
  });
  return new Promise((resolve, reject) => {
    srv.on('error', reject);
    srv.listen(PAYLOAD_PORT, () => resolve(srv));
  });
}

async function runSize(browser, n, payload) {
  currentPayload = payload;
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: DPR,
  });
  await context.addInitScript(INIT_SCRIPT);

  // Whole backend mocked at the network layer; kill external requests.
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith(`http://localhost:${PAYLOAD_PORT}/`)) return route.continue();
    if (!url.startsWith(BASE) && !url.startsWith('data:')) return route.abort();
    if (/\/api\/library\/observatory\/track\//.test(url)) {
      const id = decodeURIComponent(url.split('/track/')[1].split('?')[0]);
      return route.fulfill({ contentType: 'application/json', body: detailPayload(id) });
    }
    if (/\/api\/library\/observatory(\?|$)/.test(url)) {
      return route.fulfill({ status: 307, headers: { location: `http://localhost:${PAYLOAD_PORT}/observatory.json` } });
    }
    if (/\/api\//.test(url)) return route.fulfill({ contentType: 'application/json', body: '{}' });
    return route.continue();
  });

  const page = await context.newPage();
  const r = { n, payloadMB: payload.length / 1024 / 1024 };
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('crash', () => errors.push('PAGE CRASHED (renderer OOM or GPU loss)'));

  // ---- load ------------------------------------------------------------------
  const t0 = Date.now();
  await page.goto(`${BASE}/observatory`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    (want) => document.querySelector('.obs-stat')?.textContent?.replace(/\D/g, '') === String(want),
    n,
    { timeout: 180_000 },
  );
  r.loadTotalMs = Date.now() - t0;
  // split out network/parse/layout using the page's own resource timing
  r.phases = await page.evaluate(() => {
    const e = performance
      .getEntriesByType('resource')
      .find((x) => x.name.includes('/api/library/observatory') || x.name.includes('observatory.json'));
    return e ? { fetchMs: e.responseEnd - e.startTime, sinceResponseMs: performance.now() - e.responseEnd } : null;
  });
  await page.waitForSelector('.cmap-galaxy canvas', { timeout: 30_000 });
  await page.waitForTimeout(1600); // let the 1.07s GPU entrance play out
  r.loadLongTasks = stats((await readLongTasks(page)).map((t) => t.dur));

  r.gl = await page.evaluate(() => {
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2') || c.getContext('webgl');
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    } catch { return 'unavailable'; }
  });

  const box = await (await page.$('.cmap-galaxy canvas')).boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // ---- zoom (wheel ×10 in) ------------------------------------------------------
  await page.mouse.move(cx, cy);
  await readLongTasks(page);
  await page.evaluate(() => window.__frameLoop());
  for (let i = 0; i < 10; i++) {
    await page.mouse.wheel(0, -240);
    await page.waitForTimeout(90);
  }
  await page.waitForTimeout(400); // includes the 140ms-debounced label recompute
  r.zoomFrames = stats(await page.evaluate(() => window.__frameStop()));
  r.zoomLongTasks = stats((await readLongTasks(page)).map((t) => t.dur));
  r.labelCount = await page.evaluate(() => document.querySelectorAll('.cmap-tlabel').length);

  // ---- pan (drag) ---------------------------------------------------------------
  await page.evaluate(() => window.__frameLoop());
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 24; i++) {
    await page.mouse.move(cx + i * 18, cy + Math.sin(i / 3) * 60, { steps: 1 });
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
  r.panFrames = stats(await page.evaluate(() => window.__frameStop()));
  r.panLongTasks = stats((await readLongTasks(page)).map((t) => t.dur));

  // ---- hover storm (spatial-grid picking on every move) --------------------------
  await readLongTasks(page);
  const hoverT0 = Date.now();
  for (let i = 0; i < 30; i++) {
    await page.mouse.move(box.x + 60 + (i * (box.width - 120)) / 30, cy + ((i % 5) - 2) * 40);
  }
  r.hoverMs = Date.now() - hoverT0;
  r.hoverSettle = await settleLatency(page);
  r.hoverLongTasks = stats((await readLongTasks(page)).map((t) => t.dur));

  // ---- select (pick + full attribute rewrite + GPU re-upload) --------------------
  await readLongTasks(page);
  await page.mouse.click(cx, cy);
  r.selectSettle = await settleLatency(page);
  await page.waitForTimeout(250);
  r.selectLongTasks = stats((await readLongTasks(page)).map((t) => t.dur));
  r.overlayNodes = await page.evaluate(() => document.querySelectorAll('.cmap-svg *').length);

  if (SHOT && n === Math.max(...SIZES)) {
    await page.screenshot({ path: SHOT });
  }

  // ---- filter toggle (matched rebuild + matchSet + attribute pass + stats panel) --
  await page.mouse.click(cx, cy); // deselect back to StatsView
  await page.waitForTimeout(200);
  await readLongTasks(page);
  await page.getByRole('button', { name: 'LOW', exact: true }).click();
  r.filterSettle = await settleLatency(page);
  await page.waitForTimeout(300);
  r.filterLongTasks = stats((await readLongTasks(page)).map((t) => t.dur));

  // ---- colour-by switch (attribute pass alone) ------------------------------------
  await readLongTasks(page);
  await page.getByRole('button', { name: 'SOURCE', exact: true }).click();
  r.colorBySettle = await settleLatency(page);
  await page.waitForTimeout(250);
  r.colorByLongTasks = stats((await readLongTasks(page)).map((t) => t.dur));

  // ---- search keystroke (debounced 150ms, then full-text scan) ---------------------
  await readLongTasks(page);
  await page.locator('.rail-search input').fill('long tail');
  await page.waitForTimeout(450);
  r.searchLongTasks = stats((await readLongTasks(page)).map((t) => t.dur));

  r.domNodes = await page.evaluate(() => document.querySelectorAll('*').length);
  r.heapMB = await page.evaluate(() => (performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null));
  r.errors = errors;

  await context.close();
  return r;
}

function printResult(r) {
  console.log(`\n■ ${r.n.toLocaleString()} tracks — payload ${r.payloadMB.toFixed(1)} MB, GL: ${r.gl}`);
  if (r.phases) {
    console.log(`  load: ${r.loadTotalMs} ms total (fetch ${fmt(r.phases.fetchMs)} ms; parse+layout+commit ≤ ${fmt(r.phases.sinceResponseMs)} ms after response)`);
  } else {
    console.log(`  load: ${r.loadTotalMs} ms total`);
  }
  console.log(`  load long-tasks: n=${r.loadLongTasks.n} max ${fmt(r.loadLongTasks.max)} ms`);
  console.log(`  zoom frames: avg ${fmt(r.zoomFrames.avg)} ms · p95 ${fmt(r.zoomFrames.p95)} ms · worst ${fmt(r.zoomFrames.max)} ms (long-tasks max ${fmt(r.zoomLongTasks.max)} ms) · labels ${r.labelCount}`);
  console.log(`  pan frames:  avg ${fmt(r.panFrames.avg)} ms · p95 ${fmt(r.panFrames.p95)} ms · worst ${fmt(r.panFrames.max)} ms`);
  console.log(`  hover 30 moves: ${r.hoverMs} ms total · settle ${fmt(r.hoverSettle)} ms · long-tasks max ${fmt(r.hoverLongTasks.max)} ms`);
  console.log(`  select: settle ${fmt(r.selectSettle)} ms · long-tasks max ${fmt(r.selectLongTasks.max)} ms`);
  console.log(`  filter toggle: settle ${fmt(r.filterSettle)} ms · long-tasks max ${fmt(r.filterLongTasks.max)} ms`);
  console.log(`  colour-by:     settle ${fmt(r.colorBySettle)} ms · long-tasks max ${fmt(r.colorByLongTasks.max)} ms`);
  console.log(`  search:        long-tasks max ${fmt(r.searchLongTasks.max)} ms`);
  console.log(`  DOM nodes total ${r.domNodes} · svg overlay ${r.overlayNodes} · heap ${r.heapMB ? r.heapMB.toFixed(0) + ' MB' : 'n/a'}`);
  if (r.errors.length) console.log(`  ⚠ page errors: ${[...new Set(r.errors)].slice(0, 5).join(' | ')}`);
}

async function main() {
  const { chromium } = loadPlaywright();
  console.log(`observatory browser stress — sizes: ${SIZES.map((n) => n.toLocaleString()).join(', ')} · DPR ${DPR} · ${BASE}`);

  // Probe that the server is actually up before burning time building payloads.
  try {
    const res = await fetch(`${BASE}/observatory`, { method: 'HEAD' });
    if (!res.ok && res.status !== 405) throw new Error(`status ${res.status}`);
  } catch (e) {
    console.error(`cannot reach ${BASE} — start the app first: npm run build && npx next start -p 7799 (${e.message})`);
    process.exit(1);
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-gpu', '--ignore-gpu-blocklist', '--enable-precise-memory-info'],
  });
  const payloadSrv = await startPayloadServer();

  const results = [];
  for (const n of SIZES) {
    process.stdout.write(`building ${n.toLocaleString()}-track payload… `);
    const payload = buildPayload(n);
    console.log(`${(payload.length / 1024 / 1024).toFixed(1)} MB`);
    const r = await runSize(browser, n, payload);
    printResult(r);
    results.push(r);
  }

  await browser.close();
  payloadSrv.close();
  if (OUT) {
    writeFileSync(OUT, JSON.stringify(results, null, 2));
    console.log(`\nwrote ${OUT}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
