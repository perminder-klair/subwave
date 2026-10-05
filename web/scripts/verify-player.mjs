#!/usr/bin/env node
// Isolated player regression checks for #1776. No controller or station state.
// Install optional tools outside web's dependency manifest:
//   npm install --prefix /tmp/player-tools --no-save esbuild playwright
//   VERIFY_TOOLS=/tmp/player-tools node web/scripts/verify-player.mjs
// Browsers: VERIFY_BROWSERS=chromium,firefox,webkit (install via Playwright first).
// --serve keeps the fixture/API/stream running on VERIFY_PORT (random when unset).
// To exercise real routes, start Next with NEXT_PUBLIC_API_URL=<fixture>/api,
// NEXT_PUBLIC_STREAM_URL=<fixture>/stream.mp3, CONTROLLER_INTERNAL_URL=<fixture>,
// COMMUNITY_CATALOG_URL=<fixture>/catalog, then run with VERIFY_WEB=<Next URL>
// and VERIFY_FIXTURE_ORIGIN=<fixture>. All browser requests outside these local
// origins are blocked. Browser iOS UAs test branch selection only; they cannot
// establish iPhone lock-screen ownership.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requireTools = createRequire(process.env.VERIFY_TOOLS
  ? resolve(process.env.VERIFY_TOOLS, 'package.json') : import.meta.url);
const { build } = requireTools('esbuild');
const playwright = requireTools('playwright');

const source = `
  import React, { useEffect, useMemo, useRef, useState } from 'react';
  import { createRoot } from 'react-dom/client';
  import { usePlayer } from './hooks/usePlayer';
  import { useMediaSession } from './hooks/useMediaSession';
  import { StationOriginProvider } from './lib/stationOrigin';
  function Fixture() {
    const player = usePlayer({ opusEnabled: window.opusEnabled ?? false });
    const current = useRef(player); current.current = player;
    const [visible, show] = useState(true);
    const [nodeKey, replace] = useState(0);
    const commands = useMemo(() => ({
      play: () => current.current.play(), pause: () => current.current.pause(),
      stop: () => current.current.stop(), tune: () => current.current.tune(),
      replace: () => replace(k => k + 1), show,
    }), []);
    useMediaSession({ playbackState: player.playbackState,
      nowPlaying: { title: 'Test track', artist: 'Fixture' },
      onPlay: commands.play, onPause: commands.pause, onStop: commands.stop });
    useEffect(() => {
      window.commands = commands;
      window.snapshot = () => ({
        tunedIn: current.current.tunedIn, status: current.current.status,
        playbackState: current.current.playbackState,
        idleStopped: current.current.idleStopped,
      });
    }, [commands]);
    return <>{visible && <audio key={nodeKey} ref={player.attachAudio} preload="auto" />}
      <button onClick={commands.tune}>Toggle</button></>;
  }
  const origin = { apiUrl: '/api', streams: {
    mp3: window.streamMp3 || '/stream.mp3', opus: window.streamOpus || '/stream.opus',
  }};
  createRoot(document.getElementById('root')).render(<React.StrictMode>
    <StationOriginProvider value={origin}><Fixture /></StationOriginProvider>
  </React.StrictMode>);
`;

async function fixtureServer() {
  const bundle = await build({ stdin: { contents: source, loader: 'tsx', resolveDir: web },
    bundle: true, write: false, format: 'iife', nodePaths: [resolve(web, 'node_modules')],
    tsconfig: resolve(web, 'tsconfig.json'), define: {
      'process.env.NODE_ENV': '"development"',
      'process.env.NEXT_PUBLIC_API_URL': '"/api"',
      'process.env.NEXT_PUBLIC_STREAM_URL': '""',
    } });
  const active = new Set();
  const requests = [];
  const state = { upcoming: [], history: [], djLog: [], privacy: {}, ui: { skin: 'classic', tuneInOverlay: false } };
  const server = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const url = new URL(req.url, 'http://localhost');
    const json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
    if (url.pathname === '/test/stats') return json({ active: active.size, requests });
    if (url.pathname === '/catalog') return json({});
    if (url.pathname === '/dj') return json({ station: 'Player test' });
    if (url.pathname === '/api/state') return json(state);
    if (url.pathname === '/api/now-playing') return json({
      nowPlaying: { title: 'Test track', artist: 'Fixture' }, streamOnline: true,
      stream: { opusEnabled: false, bufferSeconds: 0 },
    });
    if (url.pathname === '/api/session') return json({ session: null, messages: [] });
    if (url.pathname === '/api/themes') return json({ active: 'default', themes: [] });
    if (url.pathname.startsWith('/api/')) return json({ needsSetup: false });
    if (url.pathname.startsWith('/stream.')) {
      if (url.searchParams.has('fail')) { res.writeHead(404); res.end(); return; }
      // A paced MP3 fixture, not Icecast. Track open connections at the server,
      // rather than inferring disconnection from the element's src attribute.
      // MPEG-1 Layer III, 128 kbps, 44.1 kHz stereo: 417-byte frames.
      // Zero side information/data means zero spectral coefficients (silence).
      // Unlike the old finite WAV, these frames decode before the response ends.
      const frame = Buffer.alloc(417);
      frame.set([0xff, 0xfb, 0x90, 0x00]);
      const chunk = Buffer.concat(Array(4).fill(frame)); // ~104ms of audio
      res.setHeader('Content-Type', 'audio/mpeg');
      // Start with ~6.7s of cushion, like a live server's initial burst, so
      // decoder startup/jitter cannot masquerade as a stale-promise stop.
      res.write(Buffer.concat(Array(256).fill(frame)));
      active.add(res); requests.push(url.href);
      const timer = setInterval(() => res.write(chunk), 100);
      res.on('close', () => { active.delete(res); clearInterval(timer); });
      return;
    }
    if (url.pathname === '/fixture.js') {
      res.setHeader('Content-Type', 'text/javascript'); return res.end(bundle.outputFiles[0].contents);
    }
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><div id="root"></div><script src="/fixture.js"></script>');
  });
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(Number(process.env.VERIFY_PORT || 0), '127.0.0.1', done);
  });
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

function instrument() {
  window.telemetry = { playSources: [], created: [], revoked: [], handlers: {} };
  if (!navigator.mediaSession) Object.defineProperty(navigator, 'mediaSession', {
    value: { playbackState: 'none', metadata: null, setActionHandler() {} },
  });
  const session = navigator.mediaSession;
  const set = session.setActionHandler.bind(session);
  session.setActionHandler = (action, handler) => {
    if (window.unsupportedStop && action === 'stop') throw new Error('Unsupported');
    window.telemetry.handlers[action] = handler;
    try { set(action, handler); } catch { /* Browser support varies. */ }
  };
  const create = URL.createObjectURL.bind(URL);
  const revoke = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = blob => {
    if (window.failBlob) throw new Error('Blob unavailable');
    const url = create(blob); window.telemetry.created.push(url); return url;
  };
  URL.revokeObjectURL = url => { window.telemetry.revoked.push(url); revoke(url); };
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    window.telemetry.playSources.push(this.src);
    if (window.rejectPlay) {
      window.rejectPlay = false;
      return Promise.reject(new DOMException('Test refusal', 'NotAllowedError'));
    }
    const result = play.call(this);
    if (window.deferPlay) {
      window.deferPlay = false;
      return new Promise((resolve, reject) => {
        window.settlePlay = resolve;
        window.rejectDeferredPlay = reject;
        // Source replacement aborts the native promise. Keep this wrapper
        // pending so a stale non-AbortError can arrive after the newer play.
        result.catch(error => { if (error.name !== 'AbortError') reject(error); });
      });
    }
    return result;
  };
  window.os = action => window.telemetry.handlers[action]?.();
}

const iosUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1';
const ipadUA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15';
let passes = 0;
function pass(name) { passes++; console.log(`PASS ${name}`); }
async function eventually(test, name) {
  for (let i = 0; i < 100; i++) {
    if (await test()) { pass(name); return; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(name);
}

async function scenarios(browser, origin, label, mode) {
  const isIOS = mode === 'iphone' || mode === 'ipad';
  const context = await browser.newContext({ ...(isIOS ? { userAgent: mode === 'ipad' ? ipadUA : iosUA } : {}) });
  await context.addInitScript(instrument);
  if (mode === 'ipad') await context.addInitScript(() => Object.defineProperty(navigator, 'maxTouchPoints', { value: 5 }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  const check = (test, name) => eventually(test, `${label}/${mode}: ${name}`);
  const connections = async () => (await (await fetch(`${origin}/test/stats`)).json()).active;
  await page.goto(origin);
  await page.waitForFunction(() => !!window.commands);
  await page.evaluate(() => { window.os('pause'); window.os('pause'); });
  assert.equal(await page.evaluate(() => navigator.mediaSession.playbackState), 'none');
  await page.evaluate(() => { window.os('play'); window.os('play'); });
  await check(async () => await connections() === 1, 'one live connection after repeated play');
  await page.waitForFunction(() => !document.querySelector('audio').paused);
  assert.equal(await page.evaluate(() => window.telemetry.playSources.length), 1);
  const first = await page.locator('audio').getAttribute('src');
  await page.evaluate(() => { window.os('pause'); window.os('pause'); });
  await check(async () => await connections() === 0, 'pause closes server connection');
  await page.waitForFunction(() => navigator.mediaSession.playbackState === 'paused');
  const paused = await page.locator('audio').getAttribute('src');
  assert.equal(await page.locator('audio').evaluate(el => el.paused), true);
  assert.equal(Boolean(paused?.startsWith('blob:')), isIOS);
  if (isIOS) {
    const wav = await page.evaluate(async () => {
      const bytes = await (await fetch(document.querySelector('audio').src)).arrayBuffer();
      const v = new DataView(bytes);
      return { length: bytes.byteLength, rate: v.getUint32(24, true),
        silent: [...new Uint8Array(bytes, 44)].every(byte => byte === 0) };
    });
    assert.deepEqual(wav, { length: 8044, rate: 8000, silent: true });
  }
  // Stale stream events and local-clip events must not wake the watchdog.
  await page.evaluate(() => {
    const audio = document.querySelector('audio');
    for (const name of ['playing', 'waiting', 'stalled', 'timeupdate', 'error']) audio.dispatchEvent(new Event(name));
  });
  await page.waitForTimeout(5200);
  assert.equal(await connections(), 0);
  assert.equal(await page.evaluate(() => window.snapshot().status), 'idle');
  pass(`${label}/${mode}: paused clip stays silent and cannot reconnect`);
  await page.evaluate(() => { window.os('play'); window.os('play'); });
  await check(async () => await connections() === 1, 'resume reconnects live');
  assert.notEqual(await page.locator('audio').getAttribute('src'), first);
  if (isIOS) assert.ok(await page.evaluate(url => window.telemetry.revoked.includes(url), paused));
  const resumed = await page.locator('audio').getAttribute('src');
  await page.evaluate(() => {
    document.querySelector('audio').pause();
    window.os('play'); window.os('play');
  });
  await check(async () => await connections() === 1, 'Play recovers a native interruption');
  assert.notEqual(await page.locator('audio').getAttribute('src'), resumed);
  await page.evaluate(() => { window.os('pause'); window.os('stop'); window.os('stop'); });
  await check(async () => await connections() === 0, 'full stop disconnects');
  await page.waitForFunction(() => navigator.mediaSession.playbackState === 'none');
  assert.equal(await page.locator('audio').getAttribute('src'), null);
  assert.equal(await page.evaluate(() => navigator.mediaSession.metadata), null);
  // All commands occur in a single JS turn, before React re-renders.
  await page.evaluate(() => {
    for (let i = 0; i < 25; i++) { window.os('play'); window.os('pause'); }
    window.os('play'); window.os('play');
  });
  await check(async () => await connections() === 1, '25 rapid cycles finish playing');
  await page.evaluate(() => { window.deferPlay = true; window.os('pause'); window.os('play'); });
  await check(async () => await connections() === 1, 'pending play opens connection');
  await page.evaluate(() => { window.os('pause'); window.os('play'); window.settlePlay(); });
  await check(async () => await connections() === 1, 'stale promise cannot undo newer resume');
  await page.evaluate(() => { window.deferPlay = true; window.os('pause'); window.os('play'); });
  await check(async () => await connections() === 1, 'old pending play opens connection for late rejection');
  await page.evaluate(() => { window.os('pause'); window.os('play'); });
  await page.waitForFunction(() => {
    const audio = document.querySelector('audio');
    return !audio.paused && audio.currentTime > 0 && window.snapshot().status === 'playing';
  });
  const beforeRejection = await page.locator('audio').evaluate(audio => ({
    src: audio.src, time: audio.currentTime, playCalls: window.telemetry.playSources.length,
  }));
  await page.evaluate(() => window.rejectDeferredPlay(new DOMException('Late stale refusal', 'NotAllowedError')));
  // Let the catch handler, React commit and source cancellation run before
  // asserting. A missing generation guard would stop this newer live stream.
  await page.waitForTimeout(250);
  const afterRejection = await page.locator('audio').evaluate(audio => ({
    src: audio.src, paused: audio.paused, time: audio.currentTime,
    playCalls: window.telemetry.playSources.length,
    ...window.snapshot(), mediaState: navigator.mediaSession.playbackState,
  }));
  assert.equal(afterRejection.src, beforeRejection.src);
  assert.equal(afterRejection.paused, false);
  assert.equal(afterRejection.tunedIn, true);
  assert.equal(afterRejection.status, 'playing');
  assert.equal(afterRejection.playbackState, 'playing');
  assert.equal(afterRejection.mediaState, 'playing');
  assert.equal(afterRejection.playCalls, beforeRejection.playCalls);
  await page.waitForFunction(time => document.querySelector('audio').currentTime > time, beforeRejection.time);
  assert.equal(await connections(), 1);
  pass(`${label}/${mode}: late stale refusal preserves newer playing stream and connection`);
  await page.evaluate(() => window.commands.replace());
  await check(async () => await connections() === 0, 'element replacement disconnects old node');
  await page.waitForFunction(() => navigator.mediaSession.playbackState === 'none');
  await page.evaluate(() => { window.os('play'); window.os('pause'); window.commands.show(false); });
  await page.waitForFunction(() => !document.querySelector('audio'));
  assert.equal(await page.evaluate(() => window.telemetry.created.length === window.telemetry.revoked.length), true);
  await page.evaluate(() => window.commands.show(true));
  await page.waitForFunction(() => !!document.querySelector('audio'));
  await page.evaluate(() => { window.failBlob = true; window.os('play'); window.os('pause'); });
  assert.equal(await page.locator('audio').getAttribute('src'), null);
  await check(async () => await connections() === 0, 'unavailable blob falls back to disconnection');
  await page.evaluate(() => { window.rejectPlay = true; window.os('play'); });
  await page.waitForFunction(() => window.snapshot().playbackState === 'none');
  pass(`${label}/${mode}: rejected play clears transport intent`);
  // Unsupported OS action types must not block registration of later actions.
  await page.addInitScript(() => { window.unsupportedStop = true; });
  // Install before the reload creates the idle interval, so its ticks are mocked.
  await page.clock.install();
  await page.reload();
  await page.waitForFunction(() => !!window.commands);
  assert.equal(await page.evaluate(() => window.telemetry.handlers.seekforward), null);
  pass(`${label}/${mode}: unsupported Stop leaves remaining handlers registered`);
  await page.evaluate(() => window.os('play'));
  await page.waitForFunction(() => !document.querySelector('audio').paused);
  await page.clock.fastForward(8 * 60 * 60 * 1000 + 60_000);
  await page.waitForFunction(() => window.snapshot().idleStopped && window.snapshot().playbackState === 'none');
  await check(async () => await connections() === 0, 'idle cutoff fully disconnects');
  assert.equal(await page.locator('audio').getAttribute('src'), null);
  assert.equal(await page.evaluate(() => window.telemetry.playSources.some(src => src.startsWith('blob:'))), false);
  assert.deepEqual(errors, []);
  await context.close();
}

async function compatibility(browser, origin, label) {
  const context = await browser.newContext();
  await context.addInitScript(instrument);
  await context.addInitScript(() => {
    window.opusEnabled = true;
    window.streamOpus = '/stream.opus?fail=1';
    window.streamMp3 = '/stream.mp3?existing=kept';
    localStorage.setItem('subwave-station-auth', 'test & token');
  });
  const page = await context.newPage();
  await page.goto(origin);
  await page.waitForFunction(() => !!window.commands);
  const canUpgrade = await page.evaluate(() =>
    !/firefox/i.test(navigator.userAgent) && document.createElement('audio').canPlayType('audio/ogg; codecs=opus') === 'probably');
  await page.evaluate(() => window.os('play'));
  await page.waitForFunction(() => !document.querySelector('audio').paused && new URL(document.querySelector('audio').src).pathname === '/stream.mp3');
  const sources = await page.evaluate(() => window.telemetry.playSources);
  assert.equal(sources.some(src => src.includes('/stream.opus')), canUpgrade);
  const live = new URL(await page.locator('audio').getAttribute('src'));
  assert.equal(live.searchParams.get('existing'), 'kept');
  assert.equal(live.searchParams.get('auth'), 'test & token');
  pass(`${label}: codec gate/failure recovery preserves stream query and auth`);
  await context.close();

  const unsupported = await browser.newContext({ userAgent: iosUA });
  await unsupported.addInitScript(() => {
    delete Object.getPrototypeOf(navigator).mediaSession;
    delete navigator.mediaSession;
  });
  const fallback = await unsupported.newPage();
  const errors = [];
  fallback.on('pageerror', error => errors.push(String(error)));
  await fallback.goto(origin);
  await fallback.waitForFunction(() => !!window.commands);
  await fallback.evaluate(() => { window.commands.play(); window.commands.pause(); });
  assert.equal(await fallback.locator('audio').getAttribute('src'), null);
  assert.deepEqual(errors, []);
  pass(`${label}: absent Media Session API uses ordinary disconnection`);
  await unsupported.close();
}

async function realRoutes(browserType, origin, webUrl) {
  for (const path of ['/', '/listen', '/landing']) {
    const browser = await browserType.launch();
    try {
      const context = await browser.newContext({ userAgent: iosUA, reducedMotion: 'reduce' });
      await context.addInitScript(instrument);
      // Explicitly isolate every browser fetch, including remote showcase probes.
      // Leave local blob decoding native; only HTTP needs the network allowlist.
      await context.route(/^https?:\/\//, route => {
        const url = route.request().url();
        if (url.startsWith(origin + '/') || url.startsWith(webUrl + '/')) return route.continue();
        return route.abort();
      });
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      const errors = [];
      page.on('pageerror', error => errors.push(String(error)));
      await page.goto(`${webUrl}${path}`);
      await page.locator('audio').waitFor({ state: 'attached' });
      await page.waitForFunction(() => typeof window.telemetry.handlers.play === 'function');
      await page.getByRole('button', { name: 'Tune in', exact: true }).first().click();
      await page.waitForFunction(() => !document.querySelector('audio').paused);
      await page.getByRole('button', { name: 'Tune out', exact: true }).first().click();
      await page.waitForFunction(() => document.querySelector('audio').src.startsWith('blob:') && navigator.mediaSession.playbackState === 'paused');
      await page.getByRole('button', { name: 'Tune in', exact: true }).first().click();
      await page.waitForFunction(() => !document.querySelector('audio').paused);
      await page.evaluate(() => { window.os('pause'); window.os('pause'); });
      await page.waitForFunction(() => document.querySelector('audio').src.startsWith('blob:') && navigator.mediaSession.playbackState === 'paused');
      await eventually(async () => (await (await fetch(`${origin}/test/stats`)).json()).active === 0, `${path}: UI pause closes stream connection`);
      await page.evaluate(() => { window.os('play'); window.os('play'); });
      await page.waitForFunction(() => !document.querySelector('audio').paused && !document.querySelector('audio').src.startsWith('blob:'));
      assert.deepEqual(errors, []);
      await page.goto('about:blank');
      await eventually(async () => (await (await fetch(`${origin}/test/stats`)).json()).active === 0, `${path}: navigation closes stream connection`);
      await context.close();
    } finally { await browser.close(); }
  }
}

let owned;
try {
  let origin = process.env.VERIFY_FIXTURE_ORIGIN;
  if (!origin) { owned = await fixtureServer(); origin = owned.origin; }
  if (process.argv.includes('--serve')) {
    console.log(`Player fixture listening at ${origin}`);
    await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
  } else {
    for (const name of (process.env.VERIFY_BROWSERS || 'chromium').split(',')) {
      const browser = await playwright[name].launch();
      try {
        if (!process.argv.includes('--routes-only')) {
          for (const mode of ['desktop', 'iphone', 'ipad']) await scenarios(browser, origin, name, mode);
          await compatibility(browser, origin, name);
        } else {
          assert.ok(process.env.VERIFY_WEB, '--routes-only requires VERIFY_WEB');
        }
      } finally { await browser.close(); }
      // Isolate real routes from the fixture clocks and media stress checks.
      if (process.env.VERIFY_WEB) {
        await realRoutes(playwright[name], origin, process.env.VERIFY_WEB);
      }
    }
    console.log(`${passes} checks passed. Physical iPhone Safari/PWA lock-screen validation remains pending.`);
  }
} finally {
  if (owned) { owned.server.closeAllConnections(); await new Promise(resolve => owned.server.close(resolve)); }
}
