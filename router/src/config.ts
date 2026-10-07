// Router configuration: process settings from the environment, and the source
// selection from state/router/config.json.
//
// config.json is written ONLY by the controller (one writer per file) and read
// here. It is polled rather than fs.watch()ed: watch events are unreliable on
// Docker bind mounts, and a 2s poll is well inside how long an operator waits
// after pressing Save. The controller also nudges POST /internal/reload, so the
// poll is the fallback, not the main path.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const HERE = dirname(fileURLToPath(import.meta.url));

export const PORT = Number(process.env.PORT || 4534);
export const HOST = process.env.ROUTER_HOST || '0.0.0.0';

// Container default first; a native run from a checkout falls back to the
// repo's state dir, matching the controller's STATE_DIR fallback.
export const ROUTER_DIR = resolve(
  process.env.ROUTER_DIR ||
    (existsSync('/var/sub-wave-router') ? '/var/sub-wave-router' : resolve(HERE, '../../state/router')),
);
export const CONFIG_PATH = resolve(ROUTER_DIR, 'config.json');
export const PLUGINS_DIR = resolve(process.env.ROUTER_PLUGINS_DIR || resolve(ROUTER_DIR, 'plugins'));
export const DATA_DIR = resolve(ROUTER_DIR, 'data');
export const BUILTIN_DIR = resolve(HERE, 'sources');
export const POLL_MS = Number(process.env.ROUTER_POLL_MS || 2000);

const value = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const sourceEntrySchema = z.object({
  plugin: z.string().min(1).max(64),
  config: z.record(z.string(), value).default({}),
  rawIds: z.boolean().optional(),
});

export const routerConfigSchema = z.object({
  version: z.literal(1),
  auth: z
    .object({
      user: z.string().min(1).max(64),
      pass: z.string().min(16).max(256),
    })
    .optional(),
  merge: z.boolean().default(false),
  sources: z.array(sourceEntrySchema).max(8).default([]),
});

export type SourceEntry = z.infer<typeof sourceEntrySchema>;
export type RouterConfig = z.infer<typeof routerConfigSchema>;

export const EMPTY_CONFIG: RouterConfig = { version: 1, merge: false, sources: [] };

export interface ConfigRead {
  config: RouterConfig;
  /** Set when the file exists but could not be used; the caller keeps its last good config. */
  error?: string;
  /** mtime+size, to notice changes cheaply. */
  stamp: string;
}

export function configStamp(): string {
  try {
    const st = statSync(CONFIG_PATH);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return 'absent';
  }
}

export function readConfig(): ConfigRead {
  const stamp = configStamp();
  if (stamp === 'absent') return { config: EMPTY_CONFIG, stamp };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    return { config: EMPTY_CONFIG, stamp, error: `config.json is not valid JSON: ${(err as Error).message}` };
  }
  const parsed = routerConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { config: EMPTY_CONFIG, stamp, error: `config.json: ${issue?.path.join('.') || '(root)'}: ${issue?.message}` };
  }
  return { config: parsed.data, stamp };
}

// Dev and test convenience, honoured only to FILL gaps in config.json: an
// install the controller has configured is never overridden by them.
export function envAuth(): { user: string; pass: string } | undefined {
  const user = process.env.ROUTER_USER;
  const pass = process.env.ROUTER_PASS;
  return user && pass ? { user, pass } : undefined;
}

export function envSources(): SourceEntry[] {
  const raw = (process.env.ROUTER_SOURCE || '').trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((plugin) => ({ plugin, config: {} }));
}
