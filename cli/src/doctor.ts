// Diagnostic engine. Pure data — no rendering, no prompts. Returns a
// structured report that commands/doctor.ts (and, later, the watch
// dashboard) can render however they want.
//
// Scope is deliberately the "first hour" of operator concerns: is Docker
// alive, is the stack up, is the controller responding, is Icecast serving
// audio, are the bind-mounted state dirs OK. Deeper checks (Subsonic auth,
// Ollama responsiveness, library coverage) come in v2 once we've added
// supporting controller endpoints.

import { accessSync, constants, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { detectCompose, isProdEnv, streamUrlFor, webBaseFor, type ComposeStatus } from './compose.ts';
import { dockerDaemonOk, composeExec } from './docker.ts';
import { makeClient, checkNeedsSetup } from './api.ts';
import { getLegacyControllerEnv, getRootEnv, parseEnvFile, getStateDir, fetchErrorReason } from './util.ts';
import { whoHolds7700, readWebDevPid, getWebDevLog, isWebDevCommand } from './web-dev.ts';

export type Status = 'ok' | 'warn' | 'fail' | 'skip';

export interface Finding {
  label: string;
  status: Status;
  detail?: string; // one-liner; longer detail goes in `hint`
  hint?: string;   // suggested next step the renderer prints in dim text
}

export interface DoctorSection {
  name: string;
  findings: Finding[];
}

export interface DoctorReport {
  sections: DoctorSection[];
  compose: ComposeStatus;
  counts: { ok: number; warn: number; fail: number; skip: number };
}

export async function runDoctor(): Promise<DoctorReport> {
  const sections: DoctorSection[] = [];
  const compose = detectCompose();

  sections.push({ name: 'Host', findings: checkHost() });
  sections.push({ name: 'Compose', findings: checkCompose(compose) });
  sections.push({ name: 'Controller', findings: await checkController(compose) });
  sections.push({ name: 'Icecast', findings: await checkIcecast(compose) });
  // Web dev server only exists in dev mode (in prod it's a compose service
  // and Compose section already covers it).
  if (compose.env === 'dev') {
    sections.push({ name: 'Web (dev)', findings: await checkWebDev() });
  }
  sections.push({ name: 'State', findings: checkState() });
  sections.push({ name: 'Content', findings: checkContent() });
  sections.push({ name: 'Logs', findings: checkLogs(compose) });

  const counts = { ok: 0, warn: 0, fail: 0, skip: 0 };
  for (const s of sections) {
    for (const f of s.findings) counts[f.status]++;
  }

  return { sections, compose, counts };
}

// --- individual sections ----------------------------------------------------

function checkHost(): Finding[] {
  const out: Finding[] = [];

  const major = Number(process.versions.node.split('.')[0] ?? '0');
  out.push({
    label: 'node',
    status: major >= 20 ? 'ok' : 'fail',
    detail: `v${process.versions.node}`,
    hint: major < 20 ? 'controller requires Node 20+' : undefined,
  });

  const dockerOk = dockerDaemonOk();
  out.push({
    label: 'docker daemon',
    status: dockerOk ? 'ok' : 'fail',
    detail: dockerOk ? 'reachable' : 'no response',
    hint: dockerOk ? undefined : 'Start Docker Desktop / dockerd, then re-run.',
  });

  return out;
}

function checkCompose(compose: ComposeStatus): Finding[] {
  const out: Finding[] = [];
  if (compose.env === 'down') {
    out.push({
      label: 'stack',
      status: 'fail',
      detail: 'no containers running',
      hint: 'Run `subwave start dev` (or `subwave start prod`) to bring it up.',
    });
    return out;
  }

  out.push({
    label: 'env',
    status: 'ok',
    detail: `${compose.env} — ${compose.file?.file}`,
  });

  // Per-service status. "running" is green; "restarting" is a warn (could be
  // healthy boot-up, could be a crash loop); anything else fails.
  const entries = Object.entries(compose.services);
  if (entries.length === 0) {
    out.push({
      label: 'services',
      status: 'warn',
      detail: 'compose detected but `ps` returned no rows',
      hint: 'docker compose may be in an odd state; try `subwave restart`.',
    });
    return out;
  }
  for (const [svc, state] of entries) {
    const status: Status =
      state === 'running' ? 'ok' :
      state === 'restarting' ? 'warn' :
      'fail';
    out.push({ label: `service · ${svc}`, status, detail: state });
  }
  return out;
}

async function checkController(compose: ComposeStatus): Promise<Finding[]> {
  const out: Finding[] = [];

  if (compose.env === 'down') {
    out.push({ label: '/health', status: 'skip', detail: 'stack down' });
    out.push({ label: '/now-playing', status: 'skip', detail: 'stack down' });
  } else {
    const client = makeClient(compose.env);

    const health = await client.get<{ status?: string }>('/health', { timeoutMs: 2000 });
    if (health.ok && health.body?.status === 'on-air') {
      out.push({ label: '/health', status: 'ok', detail: 'on-air' });
    } else if (health.ok) {
      out.push({
        label: '/health',
        status: 'warn',
        detail: `responded but status=${health.body?.status ?? '?'}`,
      });
    } else {
      out.push({
        label: '/health',
        status: 'fail',
        detail: health.error ?? 'no response',
        hint: 'Controller is unreachable. Check `subwave logs controller`.',
      });
    }

    const np = await client.get<{ streamOnline?: boolean; listeners?: { current?: number } }>(
      '/now-playing',
      { timeoutMs: 2000 },
    );
    if (np.ok && np.body) {
      const online = np.body.streamOnline === true;
      const listeners = np.body.listeners?.current ?? 0;
      out.push({
        label: '/now-playing',
        status: online ? 'ok' : 'warn',
        detail: online
          ? `stream online · ${listeners} listener(s)`
          : 'controller responding but stream offline',
        hint: online
          ? undefined
          : 'Liquidsoap may not be connected to Icecast yet — give it 10s.',
      });
    } else {
      out.push({
        label: '/now-playing',
        status: 'fail',
        detail: np.error ?? 'no response',
      });
    }

    // Setup status. When operators install via `subwave init` → `start`
    // they reach a running stack without ever connecting Navidrome + LLM,
    // which leaves the picker starved and produces a cascade of downstream
    // warnings (empty auto.m3u, /stream.mp3 404, stream offline). Surface
    // the root cause directly so the summary points at setup, not symptoms.
    const needsSetup = await checkNeedsSetup(compose.env);
    if (needsSetup === true) {
      out.push({
        label: 'setup',
        status: 'fail',
        detail: 'incomplete — music source + LLM not configured',
        hint: `Run \`subwave setup\` or open ${webBaseFor(compose.env)}/onboarding to finish configuration.`,
      });
    } else if (needsSetup === false) {
      out.push({ label: 'setup', status: 'ok', detail: 'complete' });
    } else {
      out.push({ label: 'setup', status: 'skip', detail: 'status endpoint unreachable' });
    }
  }

  // Admin creds. Required in prod (controller exits without them); just a
  // warn in dev (auth is optional there). Root .env is the source of truth;
  // we also check the legacy controller/.env so an upgrader with old config
  // doesn't get a confusing "missing" warning while their stack is still up.
  const rootEnv = parseEnvFile(getRootEnv());
  const legacyEnv = parseEnvFile(getLegacyControllerEnv());
  const credSource =
    rootEnv.ADMIN_USER && rootEnv.ADMIN_PASS ? '.env' :
    legacyEnv.ADMIN_USER && legacyEnv.ADMIN_PASS ? 'controller/.env (legacy)' : null;
  const hasCreds = Boolean(credSource);
  if (isProdEnv(compose.env)) {
    out.push({
      label: 'admin creds',
      status: hasCreds ? 'ok' : 'fail',
      detail: hasCreds ? `present in ${credSource}` : 'missing — prod requires ADMIN_USER + ADMIN_PASS',
      hint: hasCreds ? undefined : 'Set ADMIN_USER/ADMIN_PASS in the root .env, then restart controller.',
    });
  } else {
    out.push({
      label: 'admin creds',
      status: hasCreds ? 'ok' : 'warn',
      detail: hasCreds ? `present in ${credSource}` : 'absent (optional in dev)',
    });
  }

  return out;
}

async function checkIcecast(compose: ComposeStatus): Promise<Finding[]> {
  if (compose.env === 'down') {
    return [{ label: '/stream.mp3', status: 'skip', detail: 'stack down' }];
  }
  // In prod the stream is exposed via Caddy on :7700; in dev and prod-byo
  // Icecast itself listens on its mapped host port. streamUrlFor() honours
  // the BYO ICECAST_PORT override transparently.
  const url = streamUrlFor(compose.env);
  try {
    // HEAD wouldn't tell us much (Icecast streams forever); GET with a tight
    // abort once we see the response headers is enough.
    const res = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(3000),
    });
    // Don't await the body — it never ends. Just consume the headers.
    try { await res.body?.cancel(); } catch { /* ignore */ }
    const ct = res.headers.get('content-type') ?? '';
    if (res.ok && ct.includes('audio/mpeg')) {
      return [{ label: '/stream.mp3', status: 'ok', detail: `200 · ${ct}` }];
    }
    return [{
      label: '/stream.mp3',
      status: res.ok ? 'warn' : 'fail',
      detail: `${res.status} · ${ct || 'no content-type'}`,
    }];
  } catch (e) {
    // AbortError after the response headers arrived is fine — that's how we
    // hang up on the infinite stream body. fetch surfaces it as a generic
    // abort with no response, but if it aborts that quickly we already got
    // a connection so let's check whether headers were available... we
    // can't, so just report fail with the reason.
    const reason = fetchErrorReason(e);
    if (reason === 'TimeoutError' || reason === 'AbortError') {
      // Treat timeout-during-stream as a "probably-ok-but-couldn't-confirm".
      return [{
        label: '/stream.mp3',
        status: 'warn',
        detail: 'connection opened but headers not parsed in time',
      }];
    }
    return [{
      label: '/stream.mp3',
      status: 'fail',
      detail: reason,
      hint: 'Icecast may be down. Check `subwave logs broadcast`.',
    }];
  }
}

async function checkWebDev(): Promise<Finding[]> {
  const out: Finding[] = [];

  // Port holder. ControlCenter on :7700 is the macOS AirPlay Receiver — the
  // single most common false collision; call it out explicitly so operators
  // don't waste time guessing.
  const holder = whoHolds7700();
  if (!holder) {
    out.push({
      label: ':7700',
      status: 'warn',
      detail: 'nothing listening',
      hint: 'Start it with `subwave start dev` or `subwave restart web-dev`.',
    });
    return out;
  }
  if (holder.command === 'ControlCenter') {
    out.push({
      label: ':7700',
      status: 'fail',
      detail: `held by ControlCenter (pid ${holder.pid}) — macOS AirPlay Receiver`,
      hint: 'Disable AirPlay Receiver in System Settings → General → AirDrop & Handoff, then restart web-dev.',
    });
    return out;
  }
  if (!isWebDevCommand(holder.command)) {
    out.push({
      label: ':7700',
      status: 'fail',
      detail: `held by ${holder.command} (pid ${holder.pid}) — not a node dev server`,
      hint: `Free :7700 (kill pid ${holder.pid}), then \`subwave restart web-dev\`.`,
    });
    return out;
  }

  // Cross-check the pid file. If the CLI started this dev server, the pid
  // file should match — otherwise it's an outside-spawned next dev (fine,
  // but worth noting because `subwave stop` won't have a pid to consult).
  const trackedPid = readWebDevPid();
  out.push({
    label: ':7700',
    status: 'ok',
    detail: trackedPid === holder.pid
      ? `node pid ${holder.pid} · tracked`
      : `node pid ${holder.pid} · not started by this CLI`,
  });

  // HTTP probe — proves Next is actually compiled and serving, not just
  // bound to the socket.
  try {
    const res = await fetch('http://localhost:7700', {
      signal: AbortSignal.timeout(3000),
    });
    if (res.status > 0) {
      out.push({
        label: 'http://localhost:7700',
        status: 'ok',
        detail: `${res.status} ${res.statusText || ''}`.trim(),
      });
    } else {
      out.push({ label: 'http://localhost:7700', status: 'warn', detail: 'empty response' });
    }
  } catch (e) {
    const reason = fetchErrorReason(e);
    out.push({
      label: 'http://localhost:7700',
      status: 'fail',
      detail: reason,
      hint: `Next.js may still be compiling on first load — check \`${getWebDevLog()}\`.`,
    });
  }

  return out;
}

function checkState(): Finding[] {
  const out: Finding[] = [];
  const required = ['voice', 'jingles', 'sessions', 'logs', 'archive'];

  if (!existsSync(getStateDir())) {
    out.push({
      label: 'state/',
      status: 'fail',
      detail: 'missing',
      hint: 'Run `subwave setup` to create state dirs and write the root .env.',
    });
    return out;
  }

  if (!isWritable(getStateDir())) {
    out.push({
      label: 'state/',
      status: 'fail',
      detail: 'exists but not writable by this user',
      hint: 'Re-run setup with appropriate permissions (chown -R or `sudo … setup.sh`).',
    });
    return out;
  }
  out.push({ label: 'state/', status: 'ok', detail: 'writable' });

  for (const sub of required) {
    const path = resolve(getStateDir(), sub);
    if (!existsSync(path)) {
      out.push({ label: `state/${sub}`, status: 'warn', detail: 'missing — will be created on first write' });
    } else if (!isWritable(path)) {
      out.push({ label: `state/${sub}`, status: 'fail', detail: 'not writable' });
    } else {
      out.push({ label: `state/${sub}`, status: 'ok', detail: 'writable' });
    }
  }
  return out;
}

function checkContent(): Finding[] {
  const out: Finding[] = [];

  const autoPath = resolve(getStateDir(), 'auto.m3u');
  if (!existsSync(autoPath)) {
    out.push({
      label: 'auto.m3u',
      status: 'warn',
      detail: 'missing — controller writes this on first auto-refresh',
    });
  } else {
    const lines = readFileSync(autoPath, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#'));
    if (lines.length === 0) {
      out.push({
        label: 'auto.m3u',
        status: 'warn',
        detail: 'empty — autonomous fallback has nothing to play',
        hint: 'Trigger a refresh from /admin/settings or `POST /dj/refresh-playlist`.',
      });
    } else {
      out.push({ label: 'auto.m3u', status: 'ok', detail: `${lines.length} entries` });
    }
  }

  const jinglesM3u = resolve(getStateDir(), 'jingles.m3u');
  const jinglesDir = resolve(getStateDir(), 'jingles');
  if (!existsSync(jinglesM3u)) {
    out.push({
      label: 'jingles.m3u',
      status: 'warn',
      detail: 'missing — run `scripts/generate-jingles.sh` once the stack is up',
    });
  } else {
    const lines = readFileSync(jinglesM3u, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#'));
    if (lines.length === 0) {
      out.push({ label: 'jingles.m3u', status: 'warn', detail: 'empty — no station idents' });
    } else {
      // Sanity-check that each line resolves to an existing file. The M3U
      // points at /var/sub-wave/jingles/<file>; we map that to state/jingles.
      const missing: string[] = [];
      for (const line of lines) {
        const file = line.replace(/^\/var\/sub-wave\/jingles\//, '');
        const abs = resolve(jinglesDir, file);
        if (!existsSync(abs)) missing.push(file);
      }
      if (missing.length === 0) {
        out.push({ label: 'jingles.m3u', status: 'ok', detail: `${lines.length} jingles, all present` });
      } else {
        out.push({
          label: 'jingles.m3u',
          status: 'warn',
          detail: `${lines.length} listed, ${missing.length} missing on disk`,
          hint: `Missing: ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ' …' : ''}`,
        });
      }
    }
  }

  return out;
}

function checkLogs(compose: ComposeStatus): Finding[] {
  const radioLog = resolve(getStateDir(), 'logs', 'radio.log');
  // 64 KB of tail is plenty for "errors in the last few minutes" —
  // Liquidsoap is chatty but not absurdly so.
  const TAIL_BYTES = 64 * 1024;
  let tail: string | null = null;

  // Fast path: read the host-side file directly.
  try {
    if (existsSync(radioLog)) {
      const size = statSync(radioLog).size;
      const fd = readFileSync(radioLog);
      tail = fd.subarray(fd.length - Math.min(size, TAIL_BYTES)).toString('utf8');
    }
  } catch {
    // Liquidsoap creates radio.log mode 0600 owned by its in-container uid
    // (10000), so the host operator hits EACCES reading it directly. Fall
    // through to reading it from inside the container, where `exec` runs as
    // that same uid and can read its own file.
  }

  // Fallback: tail it from inside the liquidsoap container.
  if (tail === null && compose.env !== 'down' && compose.file) {
    const r = composeExec(compose.file, 'broadcast', [
      'tail', '-c', String(TAIL_BYTES), '/var/log/liquidsoap/radio.log',
    ]);
    if (r.ok) tail = r.stdout;
  }

  if (tail === null) {
    if (compose.env === 'down') {
      return [{ label: 'radio.log', status: 'skip', detail: 'stack down — no log to read' }];
    }
    if (!existsSync(radioLog)) {
      return [{ label: 'radio.log', status: 'skip', detail: 'no log yet — Liquidsoap writes it on boot' }];
    }
    return [{
      label: 'radio.log tail',
      status: 'warn',
      detail: 'unreadable on host and in container',
    }];
  }

  const lines = tail.split('\n').slice(-200);
  const errLine = /\[error\]|connection refused|Permission denied|Failed to connect/i;
  const errors = lines.filter((l) => errLine.test(l));
  if (errors.length === 0) {
    return [{ label: 'radio.log tail', status: 'ok', detail: 'no recent errors' }];
  }
  return [{
    label: 'radio.log tail',
    status: 'warn',
    detail: `${errors.length} error-shaped line(s) in last 200`,
    hint: errors.slice(0, 2).join(' | '),
  }];
}

function isWritable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

// Convenience for the future watch dashboard: scan state/sessions for the
// most recent archive. Not used by v1 doctor but cheap to expose.
export function newestSessionFile(): { id: string; mtime: number } | null {
  const dir = resolve(getStateDir(), 'sessions');
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  if (files.length === 0) return null;
  let best: { id: string; mtime: number } | null = null;
  for (const f of files) {
    const m = statSync(resolve(dir, f)).mtimeMs;
    if (!best || m > best.mtime) best = { id: f.replace(/\.json$/, ''), mtime: m };
  }
  return best;
}
