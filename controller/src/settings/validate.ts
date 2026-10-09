// Strict update() validators. Unlike the lenient normalizers in normalize.ts,
// these throw on invalid input — an operator saving from the admin UI gets a
// real error rather than silently clamped values.
//
// Part of the settings/ split — see ../settings.ts for the public barrel.

import { SHOW_MOODS, ScheduleOverride, Webhook } from './vocab.js';

import { minTrackSeconds } from './store.js';
import { webhooksSchema } from '../schemas/webhook.js';
import { mergeWebhookSecrets } from '../schemas/webhook-server.js';
import { showsSchema, type ShowSchemaContext } from '../schemas/show.js';
import { resolveShowIds } from '../schemas/show-server.js';
import { djPromptsSchema, personasSchema, ttsVoiceSlotSchema } from '../schemas/persona.js';
import { resolveDjPromptIds, resolvePersonaIds } from '../schemas/persona-server.js';
import { scheduleSchema, scheduleOverrideSchema } from '../schemas/schedule.js';
import { firstMessage } from '../util/zod-error.js';

/**
 * Strict validator for a `{engine, voice, cloudProvider}` voice slot.
 *
 * A thin wrapper over schemas/persona.ts's ttsVoiceSlotSchema — shared by every
 * persona's `tts` block AND the station-wide TTS fallback slot
 * (`settings.tts.fallback`), same shape, same per-engine voice rules, one
 * implementation. `where` is the settings path prefix baked into the messages,
 * so a bad fallback voice still reads `tts.fallback.voice must ...`.
 *
 * The message is taken VERBATIM rather than through `firstMessage`: the schema
 * already names its own full path in the text, so prefixing would double it.
 */
export function validateTtsBlock(raw, where) {
  const parsed = ttsVoiceSlotSchema(where).safeParse(raw);
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message || `${where} is invalid`);
  return parsed.data;
}

/**
 * Strict update-time path for the prompt-template library.
 *
 * Any bad entry rejects the whole patch so the operator sees the error instead
 * of silently losing a prompt. Ids are minted/de-duplicated by the server-only
 * sibling, shared with the lenient load path.
 */
export function validateDjPromptsStrict(raw) {
  const parsed = djPromptsSchema.safeParse(raw);
  if (!parsed.success) throw new Error(firstMessage(parsed.error, 'djPrompts'));
  return resolveDjPromptIds(parsed.data);
}

/**
 * Strict update-time path for the persona roster.
 *
 * The SAME schema settings/normalize.ts runs on load and the browser runs in the
 * Personas editor — what differs is only the consequence: this throws, the load
 * path repairs-or-drops. Id minting and cross-row de-duplication live in
 * persona-server.ts because neither is a pure function of one submitted value.
 */
export function validatePersonasStrict(raw) {
  const parsed = personasSchema.safeParse(raw);
  if (!parsed.success) throw new Error(firstMessage(parsed.error, 'personas'));
  return resolvePersonaIds(parsed.data);
}

export function validateShowsStrict(raw, personas, allowedThemeIds: Set<string>, moodNames: string[] = SHOW_MOODS) {
  // The non-array refusal is the SCHEMA's now, not a pre-check here — so this
  // path and the route report the same string for the same body.
  // Note the legacy singular fields #929 replaced (mood / genre / …) are
  // migrated by the SCHEMA itself (a preprocess, so z.object can't strip them
  // first), so POST /shows, a backup restore and the lenient load path all
  // give the same answer the pre-schema validator did.
  const ctx: ShowSchemaContext = {
    personaIds: personas.map(p => p.id),
    moodNames,
    themeIds: [...allowedThemeIds],
    minTrackSeconds: minTrackSeconds(),
  };
  const parsed = showsSchema(ctx).safeParse(raw);
  if (!parsed.success) throw new Error(firstMessage(parsed.error, 'shows'));
  // The schema drops a themeId it doesn't recognise (see the comment on that
  // field). Reporting it is the caller's job, so the mirrored module stays
  // side-effect free — and an operator whose palette silently reverted to the
  // station default deserves the line in the log.
  parsed.data.forEach((show, i) => {
    const wanted = String((raw[i] as Record<string, unknown>)?.themeId ?? '').trim();
    if (wanted && !show.themeId) {
      console.warn(
        `[shows] dropping unknown themeId "${wanted}" from "${show.name}" — falling back to the station theme`,
      );
    }
  });
  return resolveShowIds(parsed.data);
}

// Strict weekly-grid validator — used by update(). Shape and the
// unknown-show rule come from the shared schema (schemas/schedule.ts), which
// PUT /schedule and the lenient load path also run; `shows` supplies the only
// thing a grid cannot judge about itself.
//
// 'schedule' is passed as the ROOT because this schema parses the grid itself,
// so its issue paths start at the day index ('3.14') and need the settings key
// spliced in front to read as 'schedule.3.14'.
export function validateScheduleStrict(raw, shows) {
  const r = scheduleSchema({ showIds: shows.map(s => s.id) }).safeParse(raw);
  if (!r.success) throw new Error(firstMessage(r.error, 'schedule'));
  return r.data;
}

// Strict takeover validator — used by update(). null clears; anything else
// must be a well-formed window over an existing show. The 12h cap is enforced
// here (not just the route) so no caller can persist an unbounded pin.
//
// `now: null` — update() does not judge expiry. A window whose end has passed
// is the operator's own takeover having simply run out, and throwing on it
// would fail an unrelated settings save that merely carried the block along.
// The load path passes a real clock and drops it instead.
export function validateScheduleOverrideStrict(raw, shows): ScheduleOverride | null {
  if (raw === null || raw === undefined) return null;
  const ctx = { showIds: shows.map(s => s.id), now: null };
  const r = scheduleOverrideSchema(ctx).safeParse(raw);
  if (!r.success) throw new Error(firstMessage(r.error, 'scheduleOverride'));
  return r.data;
}

// Strict validator — used by update(). Shape and format now come from the
// shared schema (controller/src/schemas/webhook.ts), which the web form runs
// too; the stateful rules (redaction sentinel, id minting, cross-item dedupe)
// come from its server-only sibling. `existing` is the current list, so the
// operator can keep a previously-set authHeader by sending the redacted
// sentinel back unchanged.
//
// The failure path matters as much as the success path: update() is reached by
// callers that never touch POST /webhooks (backup restore, PUT /settings), and
// both do `res.status(400).json({ error: err.message })`. A raw ZodError's
// .message is a pretty-printed JSON array of issue objects, so safeParse +
// firstMessage is what keeps a bad restore reading as one readable line instead
// of a JSON blob in the operator's toast. Every remaining validate*Strict
// conversion should copy this shape.
export function validateWebhooksStrict(raw: unknown, existing: Webhook[] = []) {
  const r = webhooksSchema.safeParse(raw);
  // 'webhooks' is passed as the ROOT rather than string-prefixed here: this
  // schema is the bare array, so its issue paths start at the index, and
  // firstMessage needs to splice the name in FRONT of that index to produce
  // 'webhooks.0.url' rather than 'webhooks: 0.url'.
  if (!r.success) throw new Error(firstMessage(r.error, 'webhooks'));
  return mergeWebhookSecrets(r.data, existing);
}

// Reject a vocabulary edit that would orphan a mood still referenced by the
// festival calendar, either mood map, or a scheduled show. Renames are a
// two-step (add the new name, repoint the referrers, remove the old) — this is
// the guard that names exactly what still points at a removed mood.
export function assertNoOrphanMoods(next: any): void {
  const names = new Set<string>((next.moods || []).map((m: any) => m.name));
  const refs: string[] = [];
  for (const [period, mood] of Object.entries(next.moodSchedule || {})) {
    if (mood && !names.has(mood as string)) refs.push(`the ${period} time-of-day slot`);
  }
  for (const [cond, mood] of Object.entries(next.weatherMoods || {})) {
    if (mood && !names.has(mood as string)) refs.push(`the ${cond} weather slot`);
  }
  for (const f of next.festivals || []) {
    if (f.mood && !names.has(f.mood)) refs.push(`festival "${f.name}"`);
  }
  for (const s of next.shows || []) {
    for (const m of s.moods || []) {
      if (!names.has(m)) refs.push(`show "${s.name}"`);
    }
  }
  if (refs.length) {
    const uniq = [...new Set(refs)];
    throw new Error(`can't remove that mood — still used by ${uniq.join(', ')}. Reassign those first.`);
  }
}

// Validate + persist. Returns { saved, requiresRestart } so the UI can react.
