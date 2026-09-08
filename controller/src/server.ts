// Controller HTTP API — thin entry point: wires middleware, mounts routes/ and
// starts the background services.
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

// Log-don't-die: Node crashes the process on an unhandled rejection since v15,
// which under compose's restart policy is random 502s (#786). A stray rejection
// from a background poll must never take the API down.
process.on('unhandledRejection', (reason: any) => {
  console.error('[fatal-ish] unhandled promise rejection (continuing):', reason?.stack || reason);
});

// Graceful shutdown: fold the library DB's WAL back into library.db before the
// process dies, else the -wal sidecar survives every restart and only grows
// (#786). Synchronous work only.
let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} — reaping TTS workers + closing library DB`);
  // Reap resident Python TTS workers so they don't outlive a bare-process
  // shutdown. Each guarded so a dead worker never blocks the rest of shutdown.
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

// Security headers. This serves JSON/images/audio, never HTML, so three
// overrides matter:
//   - crossOriginResourcePolicy MUST stay 'cross-origin'; helmet's 'same-origin'
//     default blanks /cover/:id artwork, avatars and previews wherever the player
//     is not same-origin with the controller.
//   - contentSecurityPolicy off: inert on a non-document response; the web app
//     ships its own.
//   - strictTransportSecurity off: Cloudflare/Caddy terminate TLS, and helmet's
//     default carries includeSubDomains.
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginOpenerPolicy: false,
    contentSecurityPolicy: false,
    strictTransportSecurity: false,
  }),
);

// Global cap for small JSON payloads; the persona-avatar route re-applies its own
// larger cap. The 100 KB default was below the data URLs the avatar picker posts.
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

// There is no manual skip — Liquidsoap controls pacing.

app.listen(config.server.port, async () => {
  console.log(`SUB/WAVE controller on :${config.server.port}`);

  // Malformed env vars already fell back and warned on stdout; repeat them into
  // the booth log, which is the surface an operator actually reads.
  for (const issue of envIssues()) {
    queue.log('warn', `[env] ${issue.name}="${issue.value}" ${issue.problem} — using ${issue.usedInstead} instead`);
  }

  // Source state/secrets.env into process.env before anything touches the AI SDK.
  // Real env vars always win; this is the wizard's persistence layer.
  try {
    const { loaded, skipped, warnings } = await loadSecretsIntoEnv();
    if (loaded.length || skipped.length) {
      console.log(
        `[secrets] state/secrets.env: loaded=${loaded.length} skipped(env-already-set)=${skipped.length}`,
      );
    }
    // Both surfaces: a misread hand edit otherwise presents only as a provider
    // 401, which points nowhere near this file.
    for (const w of warnings) {
      console.warn(`[secrets] ${w}`);
      queue.log('warn', `[secrets] ${w}`);
    }
  } catch (err: any) {
    console.error('[secrets] load failed:', err.message);
  }

  // Wizard overlay for Navidrome creds. Env wins; this only fills gaps.
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

  // Must be in memory before the first auto-playlist build and queue push.
  // load() never throws (a corrupt file starts empty).
  await blocklist.load();

  // Its URL lives in settings, not env, so it can't self-start at import time the
  // way the tts-heavy probe does. Best-effort; never fatal.
  try {
    remoteTts.start();
  } catch (err: any) {
    console.error('[remote] tts probe start failed:', err.message);
  }

  // Resume today's LLM token tally from the durable event log. Must run ONCE and
  // before any new model call records, or it double-counts.
  try {
    const { seedDailyUsageFromLog } = await import('./llm/log.js');
    const seeded = await seedDailyUsageFromLog();
    if (seeded > 0) console.log(`[budget] resumed today's LLM usage: ${seeded} tokens`);
  } catch (err: any) {
    console.error('[budget] seed failed:', err.message);
  }

  // Seed the shipped built-ins into state/skills/<kind>/ (idempotent, never
  // clobbers operator edits), then scan state/skills as the single load root.
  // Order matters only so the files exist when the scan happens. Never fatal.
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

  // First-run banner for operators glancing at `docker compose logs`.
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

  // Open or resume the DJ session before the watcher dispatches track changes —
  // the queue and scheduler append turns into it.
  try {
    const ctx = await getFullContext();
    const s = await session.recover(ctx);
    console.log(`[session] ${s.id} (${s.kind}/${s.key})`);
  } catch (err) {
    console.error('[session] init failed:', err.message);
  }

  // Before the watcher starts, so tracks already handed to Liquidsoap stay
  // tracked across a restart.
  queue.recover();

  // Terminate a tagger/analyzer child orphaned by a restart: it is detached and
  // keeps running, so a second Start would double-write the library DB.
  try {
    const { recoverFromRestart } = await import('./broadcast/tagger.js');
    recoverFromRestart();
  } catch (err: any) {
    console.error('[tagger] restart recovery failed:', err.message);
  }

  // So a restart doesn't re-air the same "on this day" fact (#577).
  try {
    const n = loadCuriosityLedger();
    console.log(`[curiosity] ledger loaded: ${n} entries`);
  } catch (err: any) {
    console.error('[curiosity] ledger load failed:', err.message);
  }

  // One listener reading BEFORE the watcher can dispatch a pick: an unknown count
  // fails open, so a watcher beating the first poll buys a free agent pick on
  // every restart (#1256). Bounded internally, so never a boot hang.
  await startListenerMonitor();
  queue.startWatcher();
  startStreamIdleMonitor();
  startAudienceMonitor().catch(err => console.error('[audience] init failed:', err.message));
  // Up front so the sync readers see data from the first pick.
  likes.load().catch(err => console.error('[likes] init failed:', err.message));
  startScheduler();
  jingles
    .ensureDefaultIdent()
    .catch(err => console.error('[jingles] ident generation failed:', err.message));
  sfx.ensureDefaults().catch(err => console.error('[sfx] default generation failed:', err.message));
  beds.ensureDefaults().catch(err => console.error('[beds] default install failed:', err.message));

  // Re-project the Observatory sound map when stale. Spawns a child; never
  // blocks this loop.
  try {
    const { maybeProjectOnBoot } = await import('./music/map-projection.js');
    maybeProjectOnBoot();
  } catch (err: any) {
    console.error('[map-projection] boot hook failed:', err.message);
  }
});
