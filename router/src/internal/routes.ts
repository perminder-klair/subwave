// The controller's view of the router: plugin inventory, the active
// selection and its health, a throwaway connection test, and a reload nudge.
// Authenticated with the router credentials (HTTP Basic), and never exposed
// through Caddy — only the controller talks to it, over the internal network.
//
// The response shapes here are mirrored by controller/src/schemas/music-source.ts
// (routerStatusSchema / routerTestSchema); change both together.

import express, { type Router } from 'express';
import { z } from 'zod';
import { SOURCE_API_VERSION, type ConfigField } from '../sdk/types.js';
import { sourceEntrySchema } from '../config.js';
import { activitySnapshot } from '../host/activity.js';
import { describe, probe, type Health } from '../host/health.js';
import { resolveConfig } from '../host/manifest.js';
import {
  NotConfiguredError,
  activeEntries,
  buildSource,
  configError,
  credentials,
  currentConfig,
  getSource,
  lastSeenCapabilities,
  plugins,
  refreshIfChanged,
  rescan,
} from '../host/registry.js';
import type { Capabilities } from '../host/types.js';
import { checkBasic } from '../subsonic/auth.js';
import { ENDPOINT_COVERAGE, type EndpointCoverage } from '../subsonic/coverage.js';
import { ROUTER_VERSION } from '../subsonic/respond.js';

export interface PluginInfo {
  name: string;
  label: string;
  description: string;
  version: string;
  apiVersion: number;
  idPrefix: string;
  builtin: boolean;
  homepage: string | null;
  config: ConfigField[];
  envLocked: string[];
  error: string | null;
  /** From the last time this plugin was built (active or tested); null if not since the router started. */
  capabilities: Capabilities | null;
}

export interface ActiveInfo {
  plugin: string;
  label: string;
  idPrefix: string;
  rawIds: boolean;
  envLocked: string[];
  capabilities: Capabilities;
  health: Health;
}

export interface RouterStatus {
  router: { version: string; apiVersion: number };
  configured: boolean;
  merge: boolean;
  configError: string | null;
  plugins: PluginInfo[];
  active: ActiveInfo[];
  /** What the handlers see: the one active source, or the merged set (its capabilities are the union). */
  serving: { name: string; label: string; capabilities: Capabilities } | null;
  /** Which optional op each Subsonic endpoint leans on (subsonic/coverage.ts). */
  endpoints: EndpointCoverage[];
}

function pluginInfos(): PluginInfo[] {
  return plugins().map((p) => {
    const m = p.manifest;
    return {
      name: m?.name ?? p.name,
      label: m?.label ?? p.name,
      description: m?.description ?? '',
      version: m?.version ?? '',
      apiVersion: m?.apiVersion ?? 0,
      idPrefix: m?.idPrefix ?? '',
      builtin: p.builtin,
      homepage: m?.homepage ?? null,
      config: m?.config ?? [],
      envLocked: m ? resolveConfig(m, {}).envLocked : [],
      error: p.error ?? null,
      capabilities: m ? lastSeenCapabilities(m.name) : null,
    };
  });
}

export async function status(): Promise<RouterStatus> {
  const serving = getSource();
  const active = await Promise.all(
    activeEntries().map(async (e): Promise<ActiveInfo> => ({
      plugin: e.plugin,
      label: e.label,
      idPrefix: e.idPrefix,
      rawIds: e.rawIds,
      envLocked: e.envLocked,
      capabilities: e.source.capabilities,
      health: await probe(e.source),
    })),
  );
  return {
    router: { version: ROUTER_VERSION, apiVersion: SOURCE_API_VERSION },
    configured: Boolean(credentials()),
    merge: currentConfig().merge,
    configError: configError() ?? null,
    plugins: pluginInfos(),
    active,
    serving: serving ? { name: serving.name, label: serving.label, capabilities: serving.capabilities } : null,
    endpoints: ENDPOINT_COVERAGE,
  };
}

const testBody = sourceEntrySchema;

export function internalRoutes(): Router {
  const router = express.Router();
  router.use(express.json({ limit: '256kb' }));
  router.use(async (req, res, next) => {
    let ok = checkBasic(req.headers.authorization);
    if (!ok && (await refreshIfChanged())) ok = checkBasic(req.headers.authorization);
    if (!ok) {
      res.status(401).json({ error: 'router credentials required' });
      return;
    }
    next();
  });

  router.get('/status', async (_req, res) => {
    res.json(await status());
  });

  // The admin Signal path monitor: recent /rest requests and the source calls
  // each made. Never a query string, id or credential (host/activity.ts).
  router.get('/activity', (_req, res) => {
    res.set('cache-control', 'no-store').json(activitySnapshot());
  });

  router.post('/reload', async (_req, res) => {
    await rescan();
    res.json(await status());
  });

  // Build a throwaway instance from an unsaved form and report what the
  // station would get. Nothing is swapped and the instance is closed after.
  router.post('/test', async (req, res) => {
    const parsed = testBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, state: 'error', error: z.prettifyError(parsed.error) });
      return;
    }
    let built;
    try {
      built = await buildSource(parsed.data);
    } catch (err) {
      if (err instanceof NotConfiguredError) {
        res.json({ ok: false, state: 'not-configured', error: err.message, missing: err.missing });
      } else {
        res.json({ ok: false, state: 'error', error: describe(err) });
      }
      return;
    }
    try {
      const health = await probe(built.source);
      res.json({
        ok: health.state === 'healthy',
        ...health,
        capabilities: built.source.capabilities,
        envLocked: built.resolved.envLocked,
      });
    } finally {
      await built.source.close();
    }
  });

  router.use((_req, res) => {
    res.status(404).json({ error: 'unknown internal route' });
  });
  return router;
}
