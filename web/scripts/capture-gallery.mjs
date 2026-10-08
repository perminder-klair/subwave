#!/usr/bin/env node
/* ============================================================================
   SUB/WAVE — landing "Press Run" gallery capture.

   Re-run whenever a skin's look changes. Captures every plate in
   lib/press-run-plates.ts: seeds the listener skin/theme overrides, opens
   /listen, dismisses the tune-in gate, waits for cover art, screenshots at
   1600×1000, and writes WebP into public/screenshots/gallery/.

   Needs a RUNNING station with a track on air (dev stack: web on :7700,
   controller on :7701). playwright + sharp are NOT repo dependencies —
   install ad hoc, and run under tsx so the TS data module imports:

     cd web
     npm i --no-save playwright sharp
     npx tsx scripts/capture-gallery.mjs \
       [--base-url http://localhost:7700] [--api-url http://localhost:7701] \
       [--out public/screenshots/gallery] [--only tty-cyberpunk]
   ============================================================================ */

import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRESS_RUN_PLATES } from '../lib/press-run-plates.ts';

const req = createRequire(import.meta.url);
function load(name) {
  try {
    return req(name);
  } catch {
    const dir = process.env.PLAYWRIGHT_DIR;
    if (dir) {
      try { return createRequire(join(dir, 'package.json'))(name); } catch { /* fall through */ }
    }
    console.error(`${name} is not installed here. Run \`npm i --no-save playwright sharp\``);
    console.error('or point PLAYWRIGHT_DIR at a directory whose node_modules has it.');
    process.exit(1);
  }
}

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1] ?? ''] : null)).filter(Boolean),
);
const BASE = args['base-url'] || 'http://localhost:7700';
const API = args['api-url'] || 'http://localhost:7701';
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = args.out || join(HERE, '..', 'public', 'screenshots', 'gallery');
const ONLY = args.only || null;

// Data invariants — fail loudly before touching a browser. That the plates
// cover every REGISTERED skin is pinned by lib/press-run-plates.test.ts, since
// importing the registry here would drag its next/dynamic wrappers into node.
{
  const themeIds = PRESS_RUN_PLATES.map(p => p.themeId);
  const skinIds = new Set(PRESS_RUN_PLATES.map(p => p.skinId));
  if (PRESS_RUN_PLATES.length !== 8) throw new Error('expected exactly 8 plates');
  if (new Set(themeIds).size !== PRESS_RUN_PLATES.length) throw new Error('every theme must appear exactly once');
  if (skinIds.size !== PRESS_RUN_PLATES.length) throw new Error('every skin must appear exactly once');
}

const { chromium } = load('playwright');
const sharp = load('sharp');

// The station must actually be broadcasting — a silent player screenshots as
// an empty face and lies about every skin.
// The Caddy edge serves the controller under /api; a bare dev controller
// (:7701) does not, so fall back to the unprefixed route.
const nowRes = await fetch(`${API}/api/now-playing`)
  .then(r => (r.ok ? r : fetch(`${API}/now-playing`)))
  .catch(() => null);
const now = nowRes && nowRes.ok ? await nowRes.json() : null;
// Live shape is `{ nowPlaying: { title, artist, ... } }` (lib/types.ts
// NowPlayingResponse) — fall back to a flat `.title` too in case a future
// controller ever serves it unwrapped.
const track = now?.nowPlaying ?? now;
if (!track || !track.title) {
  console.error(`No track on air at ${API}/api/now-playing — start the dev stack and wait for a track.`);
  process.exit(1);
}
console.log(`On air: ${track.artist ?? '?'} — ${track.title}`);

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });

for (const plate of PRESS_RUN_PLATES) {
  if (ONLY && !plate.id.includes(ONLY)) continue;
  console.log(`plate ${plate.no}: ${plate.id}`);
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  await context.addInitScript(([skin, theme]) => {
    localStorage.setItem('subwave-skin-override', skin);
    localStorage.setItem('subwave-theme-override', theme);
    // Drop caches that could pre-paint a stale palette or pin a mode.
    localStorage.removeItem('subwave-theme-tokens');
    localStorage.removeItem('subwave-mode-override');
    localStorage.removeItem('subwave-skin-station');
  }, [plate.skinId, plate.themeId]);
  const page = await context.newPage();
  await page.goto(`${BASE}/listen`, { waitUntil: 'domcontentloaded' });
  // A dev server paints its route indicator over the player's corner; it is
  // not part of any skin.
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' }).catch(() => {});

  // Theme override painted: every built-in theme is a registry palette, and
  // ThemeProvider applies palettes as inline tokens on <html>.
  await page.waitForFunction(
    () => document.documentElement.style.getPropertyValue('--bg') !== '',
    null, { timeout: 20000 },
  );
  // Skin chunk mounted (pre-paint pending marker cleared — lib/skin.ts).
  await page.waitForFunction(
    () => !document.documentElement.hasAttribute('data-skin-pending'),
    null, { timeout: 20000 },
  );

  // Dismiss the tune-in gate: click the skin's tune affordance if it exposes
  // one by name, otherwise Space (the shell-level tune shortcut). The marker
  // above clears on hydration, but a listener-picked skin is a lazy chunk that
  // can mount later (seconds later on a cold dev server), and a press in that
  // gap reaches no listener. So retry until the shell's <audio> has a source:
  // that is set the moment a tune is handled, long before the stream plays,
  // so a slow stream can't make a second press tune back out.
  const tuned = () => page.evaluate(() => !!document.querySelector('audio')?.getAttribute('src'));
  for (let attempt = 0; attempt < 5 && !(await tuned()); attempt++) {
    const tuneBtn = page.getByRole('button', { name: /tune in/i }).first();
    if (await tuneBtn.isVisible().catch(() => false)) {
      await tuneBtn.click().catch(() => {});
    } else {
      await page.keyboard.press('Space').catch(() => {});
    }
    await page.waitForFunction(
      () => !!document.querySelector('audio')?.getAttribute('src'),
      null, { timeout: 2500 },
    ).catch(() => {});
  }

  // On air: the shell's <audio> is actually playing, and any cover art the
  // skin draws has loaded. Read from the page rather than from a skin's own
  // copy, so a skin that draws no sleeve (AXO, Cipher) needs no special case.
  await page.waitForFunction(
    () => {
      const audio = document.querySelector('audio');
      if (!audio || audio.paused || audio.currentTime <= 0) return false;
      const covers = Array.from(document.images).filter(i => i.src.includes('/cover'));
      return covers.length === 0 || covers.some(i => i.complete && i.naturalWidth > 0);
    },
    null, { timeout: 30000 },
  ).catch(() => console.warn(`  [${plate.id}] never looked on-air — capturing anyway`));
  // Let idle motion settle: needle drop, spectrum warm-up, CRT flicker-in.
  await page.waitForTimeout(3000);

  const png = await page.screenshot({ type: 'png' });
  const file = join(OUT, `${plate.id}.webp`);
  await sharp(png).webp({ quality: 82 }).toFile(file);
  console.log(`  wrote ${file}`);
  await context.close();
}

await browser.close();
console.log('done.');
