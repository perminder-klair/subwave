// Typed env-var readers: the one place a raw `process.env` string becomes a
// number, URL or bounded value. Never use `parseInt(process.env.X || '…')` —
// it yields NaN and the NaN travels.
//
// The posture is WARN AND FALL BACK, never throw: a station must not refuse to
// boot over one malformed convenience var. A genuinely load-bearing var keeps
// its own explicit check at its call site. Issues collect in `envIssues` so
// startup can repeat them into the booth log.

import { z } from 'zod';

export interface EnvIssue {
  name: string;
  value: string;
  problem: string;
  usedInstead: string;
}

const issues: EnvIssue[] = [];

/** Every malformed env var seen while building config, in read order. */
export function envIssues(): readonly EnvIssue[] {
  return issues;
}

function note(name: string, value: string, problem: string, usedInstead: unknown): void {
  issues.push({ name, value, problem, usedInstead: String(usedInstead) });
  console.warn(`[env] ${name}="${value}" ${problem} — using ${String(usedInstead)} instead`);
}

// ABSENT and EMPTY both mean "not set" (`ANALYZE_URL=` is an ordinary compose
// line); a value present but unparseable warns and falls back.
function read<T>(name: string, schema: z.ZodType<T>, fallback: T): T {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const parsed = schema.safeParse(raw.trim());
  if (parsed.success) return parsed.data;
  note(name, raw, parsed.error.issues[0]?.message || 'is not valid', fallback);
  return fallback;
}

export interface NumOptions {
  /** Inclusive floor, default 1. Pass 0 explicitly where zero means "disabled". */
  min?: number;
  max?: number;
}

function bounded(base: z.ZodNumber, { min = 1, max }: NumOptions): z.ZodNumber {
  const s = base.min(min, `must be at least ${min}`);
  return max == null ? s : s.max(max, `must be at most ${max}`);
}

/** An integer var; floats are rejected outright rather than truncated. */
export function envInt(name: string, fallback: number, opts: NumOptions = {}): number {
  const schema = z
    .string()
    .regex(/^[-+]?\d+$/, 'is not a whole number')
    .transform(Number)
    .pipe(bounded(z.number().int(), opts));
  return read(name, schema, fallback);
}

/** A decimal var (speeds, seconds). */
export function envFloat(name: string, fallback: number, opts: NumOptions = {}): number {
  const schema = z
    .string()
    .regex(/^[-+]?(\d+\.?\d*|\.\d+)$/, 'is not a number')
    .transform(Number)
    .pipe(bounded(z.number().finite(), opts));
  return read(name, schema, fallback);
}

/** An http(s) URL var; a bare host or non-http scheme is rejected. */
export function envUrl(name: string, fallback: string): string {
  // One check, not `z.url().refine(…)`: zod runs every check even after one
  // fails, so the refine would see unparseable input and `new URL()` would throw
  // straight out, breaking the never-throw contract.
  const schema = z.string().refine((u) => {
    try {
      return /^https?:$/.test(new URL(u).protocol);
    } catch {
      return false;
    }
  }, 'is not an http(s) URL');
  return read(name, schema, fallback);
}

/** A plain string var; nothing to fail, so it never warns. */
export function envStr(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

/** A string var constrained to a fixed set of values. */
export function envEnum<T extends string>(name: string, values: readonly T[], fallback: T): T {
  const schema = z.enum(values as unknown as [T, ...T[]]);
  return read<T>(name, schema, fallback);
}
