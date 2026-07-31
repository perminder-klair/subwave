// Controller HTTP API — thin entry point.
// Wires middleware, mounts the route modules (see routes/), and starts the
// background services. The Next.js web UI hits this for: now-playing, queue
// state, request submission, and the admin surface.
import express from 'express';
import helmet from 'helmet';
import { config } from './config.js';
import { envIssues } from './util/env.js';
import * as settings from './settings.js';
import * as blocklist from './music/blocklist.js';
import * as jingles from './broadcast/jingles.js';
import * as sfx from './broadcast/sfx.js';
import * as beds from './broadcast/beds.js';
import { queue } from './broadcast/queue.js';
import * as session from './broadcast/session.js';
import * as remoteTts from './audio/remoteTts.js';
import * as kokoro from './audio/kokoro.js';
import * as chatterbox from './audio/chatterbox.js';
import * as pocketTts from './audio/pocketTts.js';
import { getFullContext } from './context.js';
import { loadCuriosityLedger } from './skills/curiosity.js';
import { startScheduler } from './broadcast/scheduler.js';
import { startListenerMonitor } from './broadcast/listeners.js';
import { startStreamIdleMonitor } from './broadcast/stream-idle.js';
import { startAudienceMonitor } from './broadcast/audience.js';
import * as likes from './broadcast/likes.js';
import { cors } from './middleware/cors.js';
import { assertAdminConfigured } from './middleware/auth.js';
import { router as publicRoutes } from './routes/public.js';
import { router as requestRoutes } from './routes/request.js';
import { router as settingsRoutes } from './routes/settings.js';
import { router as jingleRoutes } from './routes/jingles.js';
import { router as sfxRoutes } from './routes/sfx.js';
import { router as voiceRoutes } from './routes/voices.js';
import { router as bedsRoutes } from './routes/beds.js';
import { router as debugRoutes } from './routes/debug.js';
import { router as statsRoutes } from './routes/stats.js';
import { router as djRoutes } from './routes/dj.js';
import { router as libraryRoutes } from './routes/library.js';
import { router as playlistsRoutes } from './routes/playlists.js';
import { router as onboardingRoutes } from './routes/onboarding.js';
import { router as archivesRoutes } from './routes/archives.js';
import { router as listenersRoutes } from './routes/listeners.js';
import { router as webhooksRoutes } from './routes/webhooks.js';
import { router as scrobbleRoutes } from './routes/scrobble.js';
import { router as likesRoutes } from './routes/likes.js';
import { router as personasRoutes } from './routes/personas.js';
import { router as showsRoutes } from './routes/shows.js';
import { router as communityRoutes } from './routes/community.js';
import { router as backupRoutes } from './routes/backup.js';
import { router as stationsRoutes } from './routes/stations.js';
import { router as audienceRoutes } from './routes/audience.js';
import { router as systemRoutes } from './routes/system.js';
import { router as generateRoutes } from './routes/generate.js';
import { router as doctorRoutes } from './routes/doctor.js';
import { router as connectRoutes } from './routes/connect.js';
import { router as mcpRoutes } from './routes/mcp.js';
import { loadSecretsIntoEnv } from './setup/secrets.js';
import { loadSetupConfig } from './setup/config.js';
import { getSetupStatus } from './setup/firstRun.js';
import * as library from './music/library.js';

// Fail fast in production if the admin gate isn't configured.
assertAdminConfigured();

// Log-don't-die guard. Node's default since v15 is to CRASH the process on any
// unhandled promise rejection — under the AIO supervisor (and compose's
// restart policy) that showed up as random 502s while the controller bounced
// (#786). A stray rejection from a background poll is never worth taking the
// station's API down; log it loudly and keep serving.
process.on('unhandledRejection', (reason: any) => {
  console.error('[fatal-ish] unhandled promise rejection (continuing):', reason?.stack || reason);
});

// Graceful shutdown: fold the library DB's WAL back into library.db before the
// process dies. Without this, `docker stop` (SIGTERM) left the -wal sidecar
// behind on every restart, and it only ever grew (#786). Synchronous work only.
let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} — reaping TTS workers + closing library DB`);
  // Reap resident Python TTS workers so they don't outlive a bare-process
  // shutdown (npm start / dev). Docker reaps the container's process group, so
  // there this is belt-and-suspenders. Each guarded so a dead worker never
  // blocks the rest of shutdown.
  for (const stopWorker of [kokoro.stop, chatterbox.stop, pocketTts.stop]) {
    try {
      stopWorker();
    } catch (err) {
      console.error('[shutdown] TTS worker stop failed:', err instanceof Error ? err.message : err);
    }
  }
  try {
    library.shutdown();
  } catch (err: any) {
    console.error('[shutdown] library close failed:', err.message);
  }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

const app = express();

// Security response headers. This is an API — it serves JSON, images, audio and
// zips, never HTML — so most of helmet's document-level policies are inert here
// and the three that matter are the ones configured below.
//
//   • crossOriginResourcePolicy MUST be 'cross-origin'. helmet's default is
//     'same-origin', which tells the browser to refuse the response to any other
//     origin — that would break /cover/:id artwork, persona avatars and the
//     sfx/jingle/bed previews in every deployment where the player is not
//     same-origin with the controller, which is exactly what middleware/cors.ts
//     opens the door for. A default that silently blanks album art is not a
//     default worth inheriting.
//   • contentSecurityPolicy is off. A CSP on a JSON or image response is inert
//     (it constrains a DOCUMENT, and no document is served from here); the web
//     app ships its own. Leaving it on would only add ~100 bytes to every reply.
//   • strictTransportSecurity is off because TLS is not this process's to
//     assert. Cloudflare/Caddy terminate it (`auto_https off` in the bundled
//     edge), and helmet's default carries includeSubDomains — an HSTS pin the
//     controller cannot honour and the operator did not ask for.
//
// What is left is what an API wants: nosniff, no X-Powered-By, X-Frame-Options
// SAMEORIGIN, a no-referrer policy, and the assorted legacy no-ops.
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginOpenerPolicy: false,
    contentSecurityPolicy: false,
    strictTransportSecurity: false,
  }),
);

// Global cap covers small JSON payloads everywhere; the persona-avatar route
// re-applies its own (slightly larger) cap on top via per-route json middleware.
// The default 100 KB was below the 50–300 KB data URLs the avatar picker posts.
app.use(express.json({ limit: '600kb' }));
app.use(cors);

// Routes. `requireAdmin` is applied per-route inside the admin modules.
app.use(publicRoutes);
app.use(requestRoutes);
app.use(settingsRoutes);
app.use(jingleRoutes);
app.use(sfxRoutes);
app.use(voiceRoutes);
app.use(bedsRoutes);
app.use(debugRoutes);
app.use(statsRoutes);
app.use(djRoutes);
app.use(libraryRoutes);
app.use(playlistsRoutes);
app.use(onboardingRoutes);
app.use(archivesRoutes);
app.use(listenersRoutes);
app.use(webhooksRoutes);
app.use(scrobbleRoutes);
app.use(likesRoutes);
app.use(personasRoutes);
app.use(showsRoutes);
app.use(communityRoutes);
app.use(backupRoutes);
app.use(stationsRoutes);
app.use(audienceRoutes);
app.use(systemRoutes);
app.use(generateRoutes);
app.use(doctorRoutes);
app.use(connectRoutes);
app.use(mcpRoutes);

// (manual skip is not implemented in this build — Liquidsoap controls pacing)

// ---------------------------------------------------------------------------
// START
// ---------------------------------------------------------------------------
app.listen(config.server.port, async () => {
  console.log(`SUB/WAVE controller on :${config.server.port}`);

  // Malformed env vars fell back to their defaults at import time and warned on
  // stdout. Repeat them into the booth log too — that's the surface an operator
  // actually reads, and a typo'd var otherwise presents only as the feature
  // behind it quietly behaving as if it were never set.
  for (const issue of envIssues()) {
    queue.log('warn', `[env] ${issue.name}="${issue.value}" ${issue.problem} — using ${issue.usedInstead} instead`);
  }

  // Source the wizard-managed secrets file (state/secrets.env) into process.env
  // before anything else touches the AI SDK. Real env vars (from compose
  // env_file) always win — secrets.env is the persistence layer for keys the
  // operator typed into the first-run wizard.
  try {
    const { loaded, skipped, warnings } = await loadSecretsIntoEnv();
    if (loaded.length || skipped.length) {
      console.log(
        `[secrets] state/secrets.env: loaded=${loaded.length} skipped(env-already-set)=${skipped.length}`,
      );
    }
    // A hand edit this file couldn't read the way the operator meant it. Both
    // surfaces, for the same reason the env warnings take both: the mistake
    // otherwise presents only as a provider 401, which points nowhere near here.
    for (const w of warnings) {
      console.warn(`[secrets] ${w}`);
      queue.log('warn', `[secrets] ${w}`);
    }
  } catch (err: any) {
    console.error('[secrets] load failed:', err.message);
  }

  // Wizard overlay — Navidrome creds the operator typed in. Env wins; this
  // only fills in fields that env didn't already provide.
  try {
    const sc = await loadSetupConfig();
    if (sc.navidrome) {
      if (!process.env.NAVIDROME_URL && sc.navidrome.url) config.navidrome.url = sc.navidrome.url;
      if (!process.env.NAVIDROME_USER && sc.navidrome.user) config.navidrome.user = sc.navidrome.user;
      if (!process.env.NAVIDROME_PASS && sc.navidrome.pass)
        config.navidrome.password = sc.navidrome.pass;
    }
  } catch (err: any) {
    console.error('[setup-config] load failed:', err.message);
  }

  // Layer persisted settings over the static config defaults
  try {
    await settings.load();
    const s = settings.get();
    await settings.ensureLiquidsoapSettingsFile();
    console.log(
      `[settings] loaded. jingleRatio=${s.jingleRatio} crossfadeDuration=${s.crossfadeDuration} location=${s.weather.locationName} onAir=${settings.resolveOnAirLocation(s)}`,
    );
  } catch (err) {
    console.error('[settings] load failed:', err.message);
  }

  // Never-play blocklist — must be in memory before the scheduler's first
  // auto-playlist build and the first queue push. load() itself never throws
  // (a corrupt file starts empty), so no try/catch needed.
  await blocklist.load();

  // Apply a pending Navidrome ID-rotation manifest (music/id-rotation.ts) —
  // covers a host-side tagger/reconcile run made while the controller was
  // down. Normal boots see no manifest and skip in one stat call. Must run
  // after blocklist.load() (the hook rewrites its in-memory index) and before
  // anything can trigger a playlist sync against unmigrated recipe ids. A
  // failure keeps the manifest for the next boot; never fatal.
  try {
    const { applyPendingRotation } = await import('./music/id-rotation.js');
    await applyPendingRotation();
  } catch (err: any) {
    console.error('[id-rotation] boot apply failed (will retry next boot):', err.message);
  }

  // Start the remote-TTS /health probe loop now that settings are loaded — its
  // URL lives in settings (not env), so it can't self-start at import time the
  // way the env-configured tts-heavy probe does. Best-effort; never fatal.
  try {
    remoteTts.start();
  } catch (err: any) {
    console.error('[remote] tts probe start failed:', err.message);
  }

  // Seed today's LLM token tally from the durable event log so a mid-day
  // restart resumes the daily budget count instead of resetting it. Must run
  // once, before any new model call records (re-seeding would double-count).
  // Best-effort: a missing log (fresh install) just leaves the tally at 0.
  try {
    const { seedDailyUsageFromLog } = await import('./llm/log.js');
    const seeded = await seedDailyUsageFromLog();
    if (seeded > 0) console.log(`[budget] resumed today's LLM usage: ${seeded} tokens`);
  } catch (err: any) {
    console.error('[budget] seed failed:', err.message);
  }

  // Seed the shipped built-ins (src/skills/builtins/<kind>/ templates) into
  // state/skills/<kind>/ as full editable skills — SKILL.md + tool.mjs, idempotent
  // (never clobbers operator edits) — then load state/skills as the single load
  // root. Built-ins are no longer special at load time; the seeder just runs first
  // so their files exist when the scan happens. None of this is fatal.
  try {
    const { loadSkills } = await import('./skills/loader.js');
    const { seedBuiltinSkills } = await import('./skills/scaffold.js');
    await seedBuiltinSkills();
    const caps = await loadSkills();
    const seeded = caps.filter((c: any) => c.seeded);
    if (seeded.length) console.log(`[skills] ${seeded.length} built-in(s): ${seeded.map((c: any) => c.kind).join(', ')}`);
    const custom = caps.filter((c: any) => !c.seeded);
    if (custom.length) console.log(`[skills] ${custom.length} custom skill(s): ${custom.map((c: any) => c.kind).join(', ')}`);
  } catch (err: any) {
    console.error('[skills] load failed:', err.message);
  }

  // First-run banner — operators glancing at `docker compose logs` should
  // immediately see where to finish setup.
  try {
    const status = await getSetupStatus();
    if (status.needsSetup) {
      const site = process.env.SITE_URL || `http://localhost:${config.server.port}`;
      console.log('');
      console.log('==============================================================');
      console.log(`  SUB/WAVE needs setup — visit ${site}/onboarding to finish.`);
      console.log('==============================================================');
      console.log('');
    }
  } catch {}

  // Open (or resume) the DJ session before the watcher starts dispatching
  // track changes — the queue and scheduler append turns into it.
  try {
    const ctx = await getFullContext();
    const s = await session.recover(ctx);
    console.log(`[session] ${s.id} (${s.kind}/${s.key})`);
  } catch (err) {
    console.error('[session] init failed:', err.message);
  }

  // Reload the persisted queue before the watcher starts so tracks already
  // handed to Liquidsoap stay tracked across a controller restart.
  queue.recover();

  // Terminate any tagger/analyzer child orphaned by a controller restart — the
  // child is detached and keeps running while our in-memory state resets, so a
  // second Start would double-write the library DB. See broadcast/tagger.ts.
  try {
    const { recoverFromRestart } = await import('./broadcast/tagger.js');
    recoverFromRestart();
  } catch (err: any) {
    console.error('[tagger] restart recovery failed:', err.message);
  }

  // Reload the durable curiosity dedup ledger so a restart doesn't re-air the
  // same "on this day" fact (issue #577).
  try {
    const n = loadCuriosityLedger();
    console.log(`[curiosity] ledger loaded: ${n} entries`);
  } catch (err: any) {
    console.error('[curiosity] ledger load failed:', err.message);
  }

  // Take one listener reading BEFORE the watcher can dispatch a pick: an
  // unknown count fails open, so a watcher that beats the first poll bought the
  // DJ a free agent pick on every restart (#1256). Bounded internally — a slow
  // or absent Icecast costs at most FIRST_POLL_WAIT_MS, never a boot hang, and
  // the HTTP server is already listening by this point.
  await startListenerMonitor();
  queue.startWatcher();
  startStreamIdleMonitor();
  startAudienceMonitor().catch(err => console.error('[audience] init failed:', err.message));
  // Load likes up front so the sync readers (pickSystem's favourites lean, the
  // pool picker's listener-liked source) see data from the first pick.
  likes.load().catch(err => console.error('[likes] init failed:', err.message));
  startScheduler();
  jingles
    .ensureDefaultIdent()
    .catch(err => console.error('[jingles] ident generation failed:', err.message));
  sfx.ensureDefaults().catch(err => console.error('[sfx] default generation failed:', err.message));
  beds.ensureDefaults().catch(err => console.error('[beds] default install failed:', err.message));

  // Kick the Observatory sound-map projection when it's stale (library grew
  // since the last one, or never ran). Spawns a child — never blocks this loop.
  try {
    const { maybeProjectOnBoot } = await import('./music/map-projection.js');
    maybeProjectOnBoot();
  } catch (err: any) {
    console.error('[map-projection] boot hook failed:', err.message);
  }
});
