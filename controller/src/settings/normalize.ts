// Lenient load-path normalizers. These never throw: a hand-edited settings.json
// must not be able to wedge boot, so every one of them clamps or drops rather
// than rejecting. The strict counterparts used by update() live in validate.ts.
//
// Part of the settings/ split — see ../settings.ts for the public barrel.

import {
  DJ_PROMPT_LIMIT,
  DjPromptEntry,
  NormalizedShow,
  PERSONA_LIMIT,
  ScheduleOverride,
  WEBHOOKS_LIMIT,
  WEBHOOK_EVENTS,
  Webhook,
  emptyWeek,
} from './vocab.js';
import { DEFAULTS, coerceMaxTrackSeconds } from './defaults.js';
// The webhook rules themselves, so this lenient path and update()'s strict one
// cannot restate them differently — see normalizeWebhooks below.
import { WEBHOOK_ID_RE, webhookSchema, type WebhookParsed } from '../schemas/webhook.js';
import { resolveWebhookIds } from '../schemas/webhook-server.js';
import {
  SHOWS_LIMIT,
  migrateLegacyShowFields,
  repairShowForLoad,
  showSchema,
  type ShowParsed,
  type ShowSchemaContext,
} from '../schemas/show.js';
import { resolveShowIds } from '../schemas/show-server.js';
import { DUCK_DEPTH_BOUNDS } from '../schemas/settings.js';
// The persona + prompt-library rules themselves, so this lenient path and
// update()'s strict one cannot restate them differently.
import {
  djPromptSchema,
  personaSchema,
  repairDjPromptForLoad,
  repairPersonaForLoad,
  repairTtsVoiceSlot,
} from '../schemas/persona.js';
import { resolveDjPromptIds, resolvePersonaIds } from '../schemas/persona-server.js';
import {
  repairScheduleForLoad,
  scheduleSchema,
  scheduleOverrideSchema,
} from '../schemas/schedule.js';

// ── normalizers (lenient — used by load(), clamp/default rather than throw) ──

// Archive retention with the keep-forever upgrade guard. A stored integer ≥ 0
// always wins (0 is a legitimate explicit "keep forever"). When nothing is
// stored, the fallback depends on whether the blob already archives: an
// install that enabled archiving under the old keep-forever default must stay
// at 0 — applying the bounded default there would delete existing tapes on
// upgrade — while everyone else (fresh installs, archive off) gets
// DEFAULTS.archive.retentionDays so newly enabled archiving is bounded from
// day one instead of silently filling the disk.
export function normalizeArchiveRetentionDays(archive: any): number {
  const v = archive?.retentionDays;
  if (Number.isInteger(v) && v >= 0) return v;
  if (archive?.enabled === true) return 0;
  return DEFAULTS.archive.retentionDays;
}

// A stored `smooth_add` duck depth, repaired rather than refused — load()'s
// input is a file an operator (or a backup from another version) may have
// hand-edited, and the value leaves the controller as a handoff file the mixer
// reads once at startup. Out of range in either direction is the expensive
// direction to pass through: >1 is a music BOOST under the DJ, <0 inverts the
// bus. Bounds come from the shared schema so the save path and this one cannot
// drift, which is the same rule stream.maxListeners follows.
export function normalizeDuckDepth(raw: unknown, fallback: number): number {
  return typeof raw === 'number'
    && Number.isFinite(raw)
    && raw >= DUCK_DEPTH_BOUNDS.min
    && raw <= DUCK_DEPTH_BOUNDS.max
    ? raw
    : fallback;
}

// Persona skill assignment. `null` (raw not an array) is the "all skills"
// sentinel — used by legacy personas and the code default so behaviour is
// unchanged until the operator explicitly picks a subset. An empty array
// means "this persona runs no skills".
//
// Legacy migrations: `random-facts` is rewritten to `curiosity` (the merged
// successor capability that absorbed the old prompt-only "did you know" line
// plus Wikipedia on-this-day). Persona ownership lists predate this rename,
// so without rewriting them, every upgraded operator would silently lose the
// capability the moment they reload settings.
export const SKILL_RENAMES: Record<string, string> = {
  'random-facts': 'curiosity',
};
/**
 * Lenient normaliser for a `{engine, voice, cloudProvider}` voice slot.
 *
 * Shared by every persona's `tts` block AND the station-wide TTS fallback slot
 * (`settings.tts.fallback`) — the two carry the same shape by design, because a
 * fallback slot is handed to speakWith() as a synthetic persona. The rules now
 * live once, in schemas/persona.ts's repairTtsVoiceSlot, beside the strict ones
 * they repair against — a repair restated at the call site is a repair that can
 * drift from the schema.
 */
export const normalizeTts = repairTtsVoiceSlot;

// Load-time shape for `settings.tts.fallback` — the station's operator-chosen
// rescue voice. The voice slot itself goes through normalizeTts() (one set of
// per-engine rules for personas and the fallback alike); only `enabled` is
// extra. An absent block normalises to disabled + engine defaults, so a
// settings.json written before this key existed keeps the pre-fallback chain
// byte-for-byte. gainDb/speed are deliberately dropped: the resolved engine's
// own trims and the on-air persona's still apply, and a third trim on the
// rescue slot would be a level surprise nobody configured.
export function normalizeTtsFallback(raw: unknown) {
  const r = (raw ?? {}) as Record<string, unknown>;
  const { engine, voice, cloudProvider } = normalizeTts(r);
  return { enabled: typeof r.enabled === 'boolean' ? r.enabled : false, engine, voice, cloudProvider };
}

/**
 * One persona, repaired then validated by the SAME schema update() enforces.
 *
 * repairPersonaForLoad lands every field on a value the strict path accepts, so
 * load and save cannot disagree about what a valid persona is. What stays here
 * is only the LENIENCY: a row that cannot be repaired into validity (no name,
 * no soul) returns null and the caller drops it, where update() would throw.
 *
 * SKILL_RENAMES travels as an argument because schemas/persona.ts may import
 * nothing but zod — and because a rename is a migration of stored data, not a
 * rule a submitted value has to satisfy, which is why the strict path has never
 * applied one.
 */
export function normalizePersona(raw: unknown) {
  if (!raw || typeof raw !== 'object') return null;
  const repaired = repairPersonaForLoad(raw as Record<string, unknown>, SKILL_RENAMES);
  const parsed = personaSchema.safeParse(repaired);
  return parsed.success ? parsed.data : null;
}

export function normalizePersonaArray(raw: unknown) {
  if (!Array.isArray(raw)) return null;
  const out: NonNullable<ReturnType<typeof normalizePersona>>[] = [];
  for (const item of raw) {
    const p = normalizePersona(item);
    if (!p) continue;
    out.push(p);
    if (out.length >= PERSONA_LIMIT) break;
  }
  // Ids are minted and de-duplicated by the same server-only helper the strict
  // path uses, so a roster that round-trips through load never renumbers.
  return out.length ? resolvePersonaIds(out) : null;
}

/**
 * Lenient load-time path for the prompt-template library: drop entries that
 * can't render (bad text) rather than failing the whole settings load.
 *
 * A missing/duplicate name degrades to "Prompt N" instead of dropping the
 * entry — the text is the part the operator can't afford to lose. That fallback
 * numbers by SURVIVING row, which is why it is computed here and handed to the
 * repair rather than derived inside it.
 */
export function normalizeDjPrompts(raw: unknown): DjPromptEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: DjPromptEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const repaired = repairDjPromptForLoad(
      item as Record<string, unknown>,
      `Prompt ${out.length + 1}`,
    );
    const parsed = djPromptSchema.safeParse(repaired);
    if (!parsed.success) continue;
    out.push(parsed.data as DjPromptEntry);
    if (out.length >= DJ_PROMPT_LIMIT) break;
  }
  return resolveDjPromptIds(out) as DjPromptEntry[];
}

export function normalizeShows(raw: unknown, personaIds: string[]): NormalizedShow[] {
  if (!Array.isArray(raw)) return [];
  // The SAME schema update() enforces, given a context that says which rules
  // this caller is in a position to check. All three nulls are deliberate and
  // documented on ShowSchemaContext: load runs before the mood cache exists,
  // has no theme registry, and clamps the track-length cap to the hard bounds
  // instead of the crossfade-derived floor. Everything else — the name and
  // brief lengths, the era windows, the per-attribute caps, the host reference
  // — is one rule, executed once.
  const ctx: ShowSchemaContext = {
    personaIds,
    moodNames: null,
    themeIds: null,
    minTrackSeconds: null,
  };
  const schema = showSchema(ctx);
  const rows: ShowParsed[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    // Legacy singular fields (#929) migrate first. The schema does this too,
    // but the per-field repairs need the plural keys already in place.
    const migrated = migrateLegacyShowFields(item);
    // The repairs live in schemas/show.ts (repairShowForLoad), beside the
    // rules they repair against — a repair restated here is a repair that can
    // drift from the schema, and the failure mode of that drift is the parse
    // failing and `continue` silently deleting a working show on the next
    // boot. What stays at this call site is only what the schema module cannot
    // own: maxTrackSeconds clamps through coerceMaxTrackSeconds, whose bounds
    // defaults.ts derives from the schema's own ceiling. Clamp rather than
    // reject: an out-of-range cap from a hand-edited file should bound the
    // show, not delete it.
    const parsed = schema.safeParse({
      ...repairShowForLoad(migrated, personaIds),
      maxTrackSeconds: coerceMaxTrackSeconds(migrated.maxTrackSeconds, true),
    });
    // What survives a drop: a nameless show, one whose host no longer exists.
    // Both are shows with no owner or no identity, which is what the
    // hand-rolled loader dropped too.
    if (!parsed.success) continue;
    rows.push(parsed.data);
    if (rows.length >= SHOWS_LIMIT) break;
  }
  // Same minting and de-duplication the strict path runs, from the same module.
  return resolveShowIds(rows) as NormalizedShow[];
}

// Lenient load-path counterpart of validateScheduleStrict. The RULES are the
// shared schema's — the 24-entry day, the slot shape, the unknown-show check —
// so the two paths can no longer drift. What lives here is only the LENIENCY:
// a slot naming a show that no longer exists is blanked rather than failing the
// boot, and the repairs themselves live beside the rules in schemas/schedule.ts
// (repairScheduleForLoad) rather than restating them here. The schema is still
// run on the repaired grid, so a repair that stopped landing on a valid value
// would be caught rather than persisted.
export function normalizeSchedule(raw: unknown, showIds: string[]) {
  const repaired = repairScheduleForLoad(raw, showIds);
  const r = scheduleSchema({ showIds }).safeParse(repaired);
  return r.success ? r.data : emptyWeek();
}

// Lenient load-path coercion for the timed takeover (#930). Anything malformed,
// dangling, or already expired loads as null — an override is transient state,
// never worth failing a boot over. Expiry is the one rule the strict path does
// NOT share, and it travels as the schema context's `now` rather than as a
// second check here.
export function normalizeScheduleOverride(raw: unknown, showIds: string[]): ScheduleOverride | null {
  const r = scheduleOverrideSchema({ showIds, now: Date.now() }).safeParse(raw);
  return r.success ? r.data : null;
}


// Lenient load-path counterpart of validateWebhooksStrict. The RULES are the
// shared schema's — url shape, the 500-char caps, the event vocabulary, the id
// pattern — so the two paths can no longer drift apart. What lives here is only
// the LENIENCY, and each repair below is deliberate: at boot a bad row is
// patched or dropped so a hand-edited settings.json still starts the station,
// where update()'s strict path throws and tells the operator which field to fix.
export function normalizeWebhooks(raw: unknown): Webhook[] {
  if (!Array.isArray(raw)) return [];
  const rows: WebhookParsed[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    // An unknown event name is FILTERED OUT rather than failing the row, so
    // retiring a name from WEBHOOK_EVENTS costs a hook that one subscription
    // instead of deleting the operator's webhook. The schema's own min(1) then
    // drops a row left with nothing to fire on, as it always did.
    const events = Array.isArray(item.events)
      ? item.events.filter((e: string) => (WEBHOOK_EVENTS as readonly string[]).includes(e))
      : [];
    const parsed = webhookSchema.safeParse({
      ...item,
      events,
      // undefined lets the schema's own .default() apply. Repaired rather than
      // rejected because none of the three is worth losing a working hook over:
      // an unrecognised id is re-minted below, a non-boolean `enabled` falls
      // back to on, and an over-long header is clamped to the same 500 the
      // strict path enforces.
      id: typeof item.id === 'string' && WEBHOOK_ID_RE.test(item.id) ? item.id : undefined,
      enabled: typeof item.enabled === 'boolean' ? item.enabled : undefined,
      authHeader:
        typeof item.authHeader === 'string' ? item.authHeader.slice(0, 500) : undefined,
    });
    if (!parsed.success) continue;
    rows.push(parsed.data);
    if (rows.length >= WEBHOOKS_LIMIT) break;
  }
  // Same minting and de-duplication the strict path runs, from the same module.
  // Deliberately NOT mergeWebhookSecrets: there is no prior list at load, and
  // resolving the redaction sentinel against nothing would blank a stored
  // header rather than leave it alone.
  return resolveWebhookIds(rows);
}


