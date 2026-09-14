// Shared onboarding schemas — the two PROBE bodies and the rules the save
// handler hand-rolls because settings.update() does not own them. Run at the
// route boundary, inside /onboarding/save, and by web/components/onboarding.
//
// Deliberately NOT here: the settings pass-through. Most of /onboarding/save
// forwards partial patches to settings.update(), and z.object would strip
// whatever the wizard learns to send next.
import { z } from 'zod';

/**
 * One normalisation for Navidrome credentials: trim, and strip trailing slashes
 * off the url (`${url}/rest/ping` against a stored `…:4533/` double-slashes and
 * some proxies 404 it). The PROBE requires all three fields; save must not —
 * skipping Navidrome is a supported way through the wizard.
 */
export function normalizeNavidromeCredentials(raw: unknown): {
  url: string;
  user: string;
  pass: string;
} {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    url: String(r.url ?? '').trim().replace(/\/+$/, ''),
    user: String(r.user ?? '').trim(),
    pass: String(r.pass ?? ''),
  };
}

// POST /onboarding/test-navidrome — the probe needs something to probe.
export const navidromeProbeSchema = z
  .unknown()
  .transform(normalizeNavidromeCredentials)
  .refine(
    (c) => Boolean(c.url && c.user && c.pass),
    'url, user, and pass are required',
  );

// POST /onboarding/test-llm. The openai-compatible rule lives here rather than
// in the probe so it also holds the wizard's button shut.
export const llmProbeSchema = z
  .unknown()
  .transform((raw) => {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    return {
      provider: String(r.provider ?? '').trim(),
      model: String(r.model ?? '').trim(),
      apiKey: String(r.apiKey ?? '').trim(),
      baseUrl: String(r.baseUrl ?? '').trim(),
      ollamaUrl: String(r.ollamaUrl ?? '').trim(),
    };
  })
  .refine((c) => Boolean(c.provider && c.model), 'provider and model are required')
  .refine(
    (c) => c.provider !== 'openai-compatible' || Boolean(c.baseUrl),
    'baseUrl is required for openai-compatible',
  );
export type LlmProbeInput = z.output<typeof llmProbeSchema>;

/**
 * Fish Audio's provider-specific save rule: a message, or null when fine. Not a
 * schema, because the tts patch belongs to settings.update() — this inspects one
 * nested block without owning the object around it. Keep it the ONE copy.
 */
export function fishAudioIssue(cloud: unknown): string | null {
  const c = (cloud && typeof cloud === 'object' ? cloud : {}) as Record<string, unknown>;
  if (c.enabled !== true || c.provider !== 'fish-audio') return null;
  const bad = (v: unknown) => {
    const s = String(v ?? '').trim();
    return !s || s.length > 100 || /[\r\n]/.test(s);
  };
  if (bad(c.model)) return 'Fish Audio model id must be 1-100 characters with no line breaks';
  if (bad(c.voice)) return 'Fish Audio voice reference id must be 1-100 characters with no line breaks';
  return null;
}
