// Controller HTTP API — thin entry point.
// Wires middleware, mounts the route modules (see routes/), and starts the
// background services. The Next.js web UI hits this for: now-playing, queue
// state, request submission, and the admin surface.
import express from 'express';
import { config } from './config.js';
import * as settings from './settings.js';
import * as jingles from './broadcast/jingles.js';
import * as sfx from './broadcast/sfx.js';
import { queue } from './broadcast/queue.js';
import * as session from './broadcast/session.js';
import { getFullContext } from './context.js';
import { startScheduler } from './broadcast/scheduler.js';
import { startListenerMonitor } from './broadcast/listeners.js';
import { startAudienceMonitor } from './broadcast/audience.js';
import { cors } from './middleware/cors.js';
import { assertAdminConfigured } from './middleware/auth.js';
import { router as publicRoutes } from './routes/public.js';
import { router as requestRoutes } from './routes/request.js';
import { router as settingsRoutes } from './routes/settings.js';
import { router as jingleRoutes } from './routes/jingles.js';
import { router as sfxRoutes } from './routes/sfx.js';
import { router as debugRoutes } from './routes/debug.js';
import { router as statsRoutes } from './routes/stats.js';
import { router as djRoutes } from './routes/dj.js';
import { router as libraryRoutes } from './routes/library.js';
import { router as onboardingRoutes } from './routes/onboarding.js';
import { router as archivesRoutes } from './routes/archives.js';
import { router as listenersRoutes } from './routes/listeners.js';
import { router as webhooksRoutes } from './routes/webhooks.js';
import { router as scrobbleRoutes } from './routes/scrobble.js';
import { router as personasRoutes } from './routes/personas.js';
import { router as backupRoutes } from './routes/backup.js';
import { router as audienceRoutes } from './routes/audience.js';
import { router as systemRoutes } from './routes/system.js';
import { loadSecretsIntoEnv } from './setup/secrets.js';
import { loadSetupConfig } from './setup/config.js';
import { getSetupStatus } from './setup/firstRun.js';

// Fail fast in production if the admin gate isn't configured.
assertAdminConfigured();

const app = express();
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
app.use(debugRoutes);
app.use(statsRoutes);
app.use(djRoutes);
app.use(libraryRoutes);
app.use(onboardingRoutes);
app.use(archivesRoutes);
app.use(listenersRoutes);
app.use(webhooksRoutes);
app.use(scrobbleRoutes);
app.use(personasRoutes);
app.use(backupRoutes);
app.use(audienceRoutes);
app.use(systemRoutes);

// (manual skip is not implemented in this build — Liquidsoap controls pacing)

// ---------------------------------------------------------------------------
// START
// ---------------------------------------------------------------------------
app.listen(config.server.port, async () => {
  console.log(`SUB/WAVE controller on :${config.server.port}`);

  // Source the wizard-managed secrets file (state/secrets.env) into process.env
  // before anything else touches the AI SDK. Real env vars (from compose
  // env_file) always win — secrets.env is the persistence layer for keys the
  // operator typed into the first-run wizard.
  try {
    const { loaded, skipped } = await loadSecretsIntoEnv();
    if (loaded.length || skipped.length) {
      console.log(
        `[secrets] state/secrets.env: loaded=${loaded.length} skipped(env-already-set)=${skipped.length}`,
      );
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
    config.weather.lat = s.weather.lat;
    config.weather.lng = s.weather.lng;
    config.weather.locationName = s.weather.locationName;
    config.weather.units = s.weather.units;
    await settings.ensureLiquidsoapSettingsFile();
    console.log(
      `[settings] loaded. jingleRatio=${s.jingleRatio} crossfadeDuration=${s.crossfadeDuration} location=${s.weather.locationName}`,
    );
  } catch (err) {
    console.error('[settings] load failed:', err.message);
  }

  // Scaffold the built-in skills as editable files under state/skills/<kind>/
  // (idempotent — never clobbers operator edits) so loadCustomSkills below picks
  // them up as overrides. Must run before the load. Never fatal.
  try {
    const { scaffoldBuiltinSkills } = await import('./skills/scaffold.js');
    await scaffoldBuiltinSkills();
  } catch (err: any) {
    console.error('[skills] scaffold failed:', err.message);
  }

  // Load operator-dropped custom skills + built-in overrides from state/skills —
  // merged into the segment director's capability set (see skills/loader.js).
  // Never fatal.
  try {
    const { loadCustomSkills } = await import('./skills/loader.js');
    const caps = await loadCustomSkills();
    if (caps.length) console.log(`[skills] ${caps.length} custom skill(s): ${caps.map((c: any) => c.kind).join(', ')}`);
  } catch (err: any) {
    console.error('[skills] custom load failed:', err.message);
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

  queue.startWatcher();
  startListenerMonitor();
  startAudienceMonitor().catch(err => console.error('[audience] init failed:', err.message));
  startScheduler();
  jingles
    .ensureDefaultIdent()
    .catch(err => console.error('[jingles] ident generation failed:', err.message));
  sfx.ensureDefaults().catch(err => console.error('[sfx] default generation failed:', err.message));
});
