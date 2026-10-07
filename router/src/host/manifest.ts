// subwave-source.json validation, and resolving a source's config values
// (stored value ← environment override ← manifest default).

import { z } from 'zod';
import { ID_PREFIX_RE } from './ids.js';
import type { ConfigField, SourceManifest } from '../sdk/types.js';

export const PLUGIN_NAME_RE = /^[a-z][a-z0-9-]{1,31}$/;

const configFieldSchema = z
  .object({
    key: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/, 'config keys are letters, digits and underscores'),
    label: z.string().min(1).max(80),
    type: z.enum(['url', 'string', 'secret', 'number', 'boolean', 'select']),
    required: z.boolean().optional(),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
    options: z.array(z.object({ value: z.string(), label: z.string() })).max(50).optional(),
    help: z.string().max(400).optional(),
    placeholder: z.string().max(200).optional(),
    env: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/, 'env names are UPPER_SNAKE_CASE').optional(),
  })
  .refine((f) => f.type !== 'select' || (f.options?.length ?? 0) > 0, { message: 'a select field needs options' });

export const manifestSchema = z
  .object({
    name: z.string().regex(PLUGIN_NAME_RE, 'name must match ^[a-z][a-z0-9-]{1,31}$'),
    label: z.string().min(1).max(60),
    description: z.string().max(400).optional(),
    version: z.string().min(1).max(40),
    apiVersion: z.number().int().positive(),
    idPrefix: z.string().regex(ID_PREFIX_RE, 'idPrefix must match ^[a-z][a-z0-9]{1,5}$'),
    entry: z.string().min(1).max(200).optional(),
    homepage: z.string().url().optional(),
    config: z.array(configFieldSchema).max(30).optional(),
  })
  .refine((m) => new Set((m.config ?? []).map((f) => f.key)).size === (m.config ?? []).length, {
    message: 'config keys must be unique',
  });

export function parseManifest(raw: unknown): SourceManifest {
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`invalid subwave-source.json: ${issue?.path.join('.') || '(root)'}: ${issue?.message}`);
  }
  return parsed.data as SourceManifest;
}

export type ConfigValue = string | number | boolean | undefined;

export interface ResolvedConfig {
  values: Record<string, ConfigValue>;
  /** Keys whose value comes from the environment. */
  envLocked: string[];
  /** Required keys with no value from any layer. */
  missing: string[];
}

function coerce(field: ConfigField, raw: unknown): ConfigValue {
  if (raw === undefined || raw === null) return undefined;
  if (field.type === 'number') {
    const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
    return String(raw).trim() === '' || !Number.isFinite(n) ? undefined : n;
  }
  if (field.type === 'boolean') {
    if (typeof raw === 'boolean') return raw;
    const s = String(raw).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(s)) return true;
    if (['0', 'false', 'no', 'off'].includes(s)) return false;
    return undefined;
  }
  const s = String(raw);
  if (s.trim() === '') return undefined;
  if (field.type === 'url') return s.trim().replace(/\/+$/, '');
  if (field.type === 'select' && field.options && !field.options.some((o) => o.value === s)) return undefined;
  return field.type === 'secret' ? s : s.trim();
}

// Env always wins (house rule), so a value set in the environment is also
// what the admin form shows as locked.
export function resolveConfig(
  manifest: SourceManifest,
  stored: Record<string, unknown> = {},
  env: NodeJS.ProcessEnv = process.env,
): ResolvedConfig {
  const values: Record<string, ConfigValue> = {};
  const envLocked: string[] = [];
  const missing: string[] = [];
  for (const field of manifest.config ?? []) {
    const fromEnv = field.env ? coerce(field, env[field.env]) : undefined;
    let value: ConfigValue;
    if (fromEnv !== undefined) {
      value = fromEnv;
      envLocked.push(field.key);
    } else {
      value = coerce(field, stored[field.key]) ?? coerce(field, field.default);
    }
    values[field.key] = value;
    if (field.required && value === undefined) missing.push(field.key);
  }
  return { values, envLocked, missing };
}
