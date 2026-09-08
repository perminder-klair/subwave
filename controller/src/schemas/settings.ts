// Schemas for individual `POST /settings` patch keys (#1348). One schema per
// top-level key, never one over the whole settings object: the body is a
// partial patch and `z.object` would strip whatever a form learns to send next.
//
// Each helper reproduces its hand-rolled branch's coercion exactly. Tightening
// one is a behaviour change and belongs in its own PR.
//
// Bounds live here, not in defaults.ts's BOUNDS, so the browser pre-flight
// reads the same numbers; BOUNDS re-exports them.
import { z } from 'zod';

// Every top-level name in schemas/*.ts shares ONE scope in the flat mirror,
// hence the SETTINGS_/settings prefixes.
export interface SettingsNumericBound {
  min: number;
  max: number;
}

// 0 = jingles off entirely; radio.liq skips the rotate on a 0 ratio file (#997).
export const JINGLE_RATIO_BOUNDS: SettingsNumericBound = { min: 0, max: 1000 };

// 0 = bed every link whose incoming vocal onset is unknown.
export const BEDS_THRESHOLD_SEC_BOUNDS: SettingsNumericBound = { min: 0, max: 60 };

// The bed's ramp into the next song; bed-policy clamps it against the bed length too.
export const BEDS_CROSS_SEC_BOUNDS: SettingsNumericBound = { min: 0, max: 15 };
export const BEDS_TAIL_SEC_BOUNDS: SettingsNumericBound = { min: 0, max: 15 };

// Dead-air trim: smallest edge gap worth cutting. The floor keeps the feature
// off deliberate silence (a segued album leaves a beat between tracks).
export const SILENCE_TRIM_MIN_GAP_MS_BOUNDS: SettingsNumericBound = { min: 250, max: 30000 };

/**
 * `parseInt(raw, 10)` + bounds: accepts string forms and TRUNCATES a float
 * rather than refusing it. Not `z.coerce.number().int()`, which refuses both.
 * `message` is the flat `error` string the operator sees, so it names its own
 * field; patch-registry.ts supplies the dotted path for `fieldErrors`.
 */
export function settingsIntLike(bounds: SettingsNumericBound, message: string) {
  return z
    .unknown()
    .superRefine((raw, ctx) => {
      const v = parseInt(raw as string, 10);
      if (!Number.isFinite(v) || v < bounds.min || v > bounds.max) {
        ctx.addIssue({ code: 'custom', message });
      }
    })
    .transform((raw) => parseInt(raw as string, 10));
}

/** `parseFloat(raw)` + bounds. Same posture as settingsIntLike. */
export function settingsFloatLike(bounds: SettingsNumericBound, message: string) {
  return z
    .unknown()
    .superRefine((raw, ctx) => {
      const v = parseFloat(raw as string);
      if (!Number.isFinite(v) || v < bounds.min || v > bounds.max) {
        ctx.addIssue({ code: 'custom', message });
      }
    })
    .transform((raw) => parseFloat(raw as string));
}

/**
 * `!!value` — accepts anything. Not `z.boolean()`: backup restore posts a whole
 * settings.json through update(), and a truthy non-boolean that saves today
 * would start failing the entire restore.
 */
export function settingsBoolLike() {
  return z.unknown().transform((v) => !!v);
}

/**
 * A settings BLOCK — `{ enabled?, … }` — with the branches' leniency: a
 * non-object block is an empty patch rather than an error, an explicitly
 * undefined field is absent, and unknown fields inside are DROPPED (only the
 * top-level key inventory rejects unknowns, so a newer backup still restores).
 */
export function settingsBlockOf<T extends z.ZodRawShape>(shape: T) {
  return z.preprocess((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (v !== undefined) out[k] = v;
    }
    return out;
  }, z.object(shape).partial());
}

/**
 * `Number(raw)` + bounds, no rounding. Opposite of the parseInt family on both
 * counts: '10abc' is NaN (refused) while ''/null/[] are 0 (accepted). Not
 * interchangeable with settingsIntLike.
 */
export function settingsNumberLike(bounds: SettingsNumericBound, message: string) {
  return z
    .unknown()
    .superRefine((raw, ctx) => {
      const v = Number(raw);
      if (!Number.isFinite(v) || v < bounds.min || v > bounds.max) {
        ctx.addIssue({ code: 'custom', message });
      }
    })
    .transform((raw) => Number(raw));
}

/** `Math.floor(Number(raw))` + bounds, checked on the FLOORED value. */
export function settingsNumberFloorLike(bounds: SettingsNumericBound, message: string) {
  return z
    .unknown()
    .superRefine((raw, ctx) => {
      const v = Math.floor(Number(raw));
      if (!Number.isFinite(v) || v < bounds.min || v > bounds.max) {
        ctx.addIssue({ code: 'custom', message });
      }
    })
    .transform((raw) => Math.floor(Number(raw)));
}

/**
 * `Math.round(Number(raw))` + bounds, checked on the ROUNDED value, so a value
 * can cross a bound in either direction: with [1, 25], 0.6 is accepted and 0.4
 * refused; 25.4 accepted, 25.5 refused. likes.maxTracks / likes.windowDays.
 */
export function settingsNumberRoundLike(bounds: SettingsNumericBound, message: string) {
  return z
    .unknown()
    .superRefine((raw, ctx) => {
      const v = Math.round(Number(raw));
      if (!Number.isFinite(v) || v < bounds.min || v > bounds.max) {
        ctx.addIssue({ code: 'custom', message });
      }
    })
    .transform((raw) => Math.round(Number(raw)));
}

/**
 * `Number(raw)` bounds-checked BEFORE rounding, then rounded. stream.bufferSeconds
 * only: 59.6 passes `<= 60` and stores as 60, while 60.4 is refused.
 */
export function settingsNumberPreRoundLike(bounds: SettingsNumericBound, message: string) {
  return z
    .unknown()
    .superRefine((raw, ctx) => {
      const v = Number(raw);
      if (!Number.isFinite(v) || v < bounds.min || v > bounds.max) {
        ctx.addIssue({ code: 'custom', message });
      }
    })
    .transform((raw) => Math.round(Number(raw)));
}

/** `parseInt(raw, 10)` + membership of a fixed set (the encoder bitrates). */
export function settingsIntOneOf(allowed: readonly number[], message: string) {
  return z
    .unknown()
    .superRefine((raw, ctx) => {
      const v = parseInt(raw as string, 10);
      if (!Number.isFinite(v) || !allowed.includes(v)) {
        ctx.addIssue({ code: 'custom', message });
      }
    })
    .transform((raw) => parseInt(raw as string, 10));
}

/**
 * Membership tested on the RAW value — no String(), no trim, no case folding.
 * Not `z.enum`: the registry carries these messages verbatim to the operator.
 */
export function settingsStrictOneOf<T>(allowed: readonly T[], message: string) {
  return z
    .unknown()
    .superRefine((raw, ctx) => {
      if (!allowed.includes(raw as T)) ctx.addIssue({ code: 'custom', message });
    })
    .transform((raw) => raw as T);
}

/**
 * `String(raw ?? '').trim()` + max length measured after the trim. The `?? ''`
 * makes null CLEAR the field; settingsRawStringLike is the other posture.
 */
export function settingsTrimmedString(max: number, message: string) {
  return z
    .unknown()
    .superRefine((raw, ctx) => {
      if (String(raw ?? '').trim().length > max) ctx.addIssue({ code: 'custom', message });
    })
    .transform((raw) => String(raw ?? '').trim());
}

/**
 * `String(raw)` with NO trim and NO nullish default — search.apiKey's posture,
 * so `null` is stored as the literal string 'null'. Shipping behaviour.
 */
export function settingsRawStringLike(max: number, message: string) {
  return z
    .unknown()
    .superRefine((raw, ctx) => {
      if (String(raw).length > max) ctx.addIssue({ code: 'custom', message });
    })
    .transform((raw) => String(raw));
}

// The header-name grammar `stream.countryHeader` accepts: RFC 7230 token chars,
// capped at 64. `broadcast/listener-country.ts` imports it, so the save path,
// the browser pre-flight and the read path share one declaration.
export const STREAM_COUNTRY_HEADER_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;

// `llm.headers` / `llm.fallback.headers` (#1618). Name is the same RFC 7230
// token, so it's an alias rather than a second copy. Values are printable ASCII
// on one line: a CR/LF is header injection, so it is REFUSED, never repaired.
// `applyLlmLegPatch` and `normalizeLlmHeaders` both import these.
export const LLM_HEADER_NAME_RE = STREAM_COUNTRY_HEADER_RE;
export const LLM_HEADER_VALUE_RE = /^[\x20-\x7E]+$/;

/** At most this many custom headers per leg, and this long a value. */
export const LLM_HEADERS_MAX = 10;
export const LLM_HEADER_VALUE_MAX = 500;

/** Path length cap for `stream.geoipDbPath` — a generous PATH_MAX. */
export const STREAM_GEOIP_DB_PATH_MAX = 512;

/**
 * `String(raw ?? '').trim()` + the header-name grammar. Empty means "don't read
 * a second header" and is accepted; anything else is matched or REFUSED, never
 * repaired into a header the operator did not name.
 */
export function settingsHeaderNameLike(message: string) {
  return z
    .unknown()
    .superRefine((raw, ctx) => {
      const v = String(raw ?? '').trim();
      if (v && !STREAM_COUNTRY_HEADER_RE.test(v)) ctx.addIssue({ code: 'custom', message });
    })
    .transform((raw) => String(raw ?? '').trim());
}

/**
 * A URL field: trim, length, then an http(s) scheme test on a non-empty value.
 * `stripTrailingSlashes` is per-field: embedding's URLs strip, search.baseUrl
 * and scrobble.listenbrainz.baseUrl keep theirs (those consumers append a path).
 */
export function settingsUrlLike(opts: {
  max: number;
  tooLong: string;
  badScheme: string;
  stripTrailingSlashes?: boolean;
}) {
  return z
    .unknown()
    .superRefine((raw, ctx) => {
      const v = String(raw ?? '').trim();
      if (v.length > opts.max) {
        ctx.addIssue({ code: 'custom', message: opts.tooLong });
        return;
      }
      if (v && !/^https?:\/\//i.test(v)) {
        ctx.addIssue({ code: 'custom', message: opts.badScheme });
      }
    })
    .transform((raw) => {
      const v = String(raw ?? '').trim();
      return opts.stripTrailingSlashes ? v.replace(/\/+$/, '') : v;
    });
}

// Vocabularies for the converted keys, re-exported by settings/vocab.ts and
// settings/defaults.ts rather than duplicated.

// Allowed MP3 bitrates, shared by the hourly archive and the live /stream.mp3
// mount. %mp3(bitrate=…) needs a parse-time int, so radio.liq pre-bakes one
// encoder branch per value: adding a value here needs a branch there.
export const SETTINGS_MP3_BITRATES = [64, 96, 128, 160, 192, 320] as const;
// Opus + AAC encoders share the same parse-time-literal constraint.
export const SETTINGS_OPUS_BITRATES = [96, 128, 192, 256, 320] as const;
export const SETTINGS_AAC_BITRATES = [128, 192, 256] as const;

// Where per-track loudness comes from (queue.applyLoudnessGain, issue #998).
export const SETTINGS_LOUDNESS_SOURCES = [
  'replaygain-then-measured',
  'replaygain',
  'measured',
] as const;

export const SETTINGS_SEARCH_PROVIDERS = ['duckduckgo', 'tavily', 'brave', 'searxng'] as const;

// Cap for the optional SearXNG `engines=` pin (a comma-separated name list).
export const SETTINGS_SEARXNG_ENGINES_MAX = 500;

export const CROSSFADE_DURATION_BOUNDS: SettingsNumericBound = { min: 0, max: 30 };

// `smooth_add`'s `p`: the fraction of the music LEFT UP under a voice channel,
// so SMALLER is a deeper duck. 1 is no duck, 0 is a full mute under the voice.
// Shared by both ducking layers — the same knob at two depths.
export const DUCK_DEPTH_BOUNDS: SettingsNumericBound = { min: 0, max: 1 };

// Station-clock minutes before a show boundary at which the outgoing host signs
// off (`handover.offsetMinutes`). Must be a multiple of
// HANDOVER_OFFSET_STEP_MINUTES or the programme row never samples the window
// and the outro silently never airs. Max 20 keeps it clear of the :35-:39
// feature beat.
export const HANDOVER_OFFSET_BOUNDS: SettingsNumericBound = { min: 5, max: 20 };

// The process-minute stride the talk table's programme row samples the station
// clock on, so also the width and alignment of every station-clock beat window.
// broadcast/talk-scheduler.ts imports it as the row's `stride`; it lives beside
// the bound it constrains so the two cannot drift. 5 works for every IANA zone
// (offsets are multiples of 15, so process and station minutes agree mod 5).
export const HANDOVER_OFFSET_STEP_MINUTES = 5;
// −23 (EBU R128 broadcast) … −9 (very loud); −14 is the streaming standard.
export const LOUDNESS_TARGET_LUFS_BOUNDS: SettingsNumericBound = { min: -23, max: -9 };
// 0 disables boosting entirely (cut-only levelling).
export const LOUDNESS_MAX_BOOST_DB_BOUNDS: SettingsNumericBound = { min: 0, max: 12 };
// 0 disables burst-on-connect. settings.load() bounds the stored value against
// these same figures, so keep it reading from here rather than hand-copying.
export const STREAM_BUFFER_SECONDS_BOUNDS: SettingsNumericBound = { min: 0, max: 60 };

// Icecast's <limits><clients> ceiling. Floor is 1: 0 renders a station nobody
// can tune into. First-class setting because some licensing bodies charge on
// simultaneous listener capacity (#1300 FR 15).
export const STREAM_MAX_LISTENERS_BOUNDS: SettingsNumericBound = { min: 1, max: 10000 };

// Album cooldown in HOURS (#1485 FR 3). 0 = off and is the shipped default, so
// an upgrade picks byte-identically. Fractional hours are allowed; past 72 this
// is a second no-repeat window rather than a cooldown.
export const PICKER_ALBUM_HOURS_BOUNDS: SettingsNumericBound = { min: 0, max: 72 };

// Station-wide minimum track length in SECONDS: shorter tracks are never PICKED
// (#1573). 0 = off, the shipped default. NOT settings.minTrackSeconds(), which
// is the crossfade-derived floor on the max-length CAP and is this key's own
// lower bound (enforced in update(), where the crossfade is known). The ceiling
// twins schemas/show.ts's SHOW_MIN_TRACK_LENGTH_MAX; move them together.
export const PICKER_MIN_TRACK_LENGTH_BOUNDS: SettingsNumericBound = { min: 0, max: 3600 };

export const SETTINGS_STATION_DEFAULT_NAME = 'SUB/WAVE';
export const SETTINGS_STATION_NAME_MAX = 80;
export const SETTINGS_STATION_DESCRIPTION_MAX = 200;
export const SETTINGS_DJ_HOUSE_RULES_MAX = 2000;

// The skin slug is never checked against a registry: the web side resolves it
// and falls back, so an unrecognised value is DROPPED here rather than refused.
export const SETTINGS_SKIN_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

// Tracks between jingles. Needs a mixer restart, which update() decides — a
// schema says what a value may BE, never what applying it costs.
export const jingleRatioSchema = settingsIntLike(
  JINGLE_RATIO_BOUNDS,
  `jingleRatio must be int in [${JINGLE_RATIO_BOUNDS.min}, ${JINGLE_RATIO_BOUNDS.max}]`,
);

export const sfxPatchSchema = settingsBlockOf({
  enabled: settingsBoolLike(),
});

export const bedsPatchSchema = settingsBlockOf({
  enabled: settingsBoolLike(),
  requestIntros: settingsBoolLike(),
  thresholdSec: settingsFloatLike(
    BEDS_THRESHOLD_SEC_BOUNDS,
    `beds.thresholdSec must be number in [${BEDS_THRESHOLD_SEC_BOUNDS.min}, ${BEDS_THRESHOLD_SEC_BOUNDS.max}]`,
  ),
  crossSec: settingsFloatLike(
    BEDS_CROSS_SEC_BOUNDS,
    `beds.crossSec must be number in [${BEDS_CROSS_SEC_BOUNDS.min}, ${BEDS_CROSS_SEC_BOUNDS.max}]`,
  ),
  tailSec: settingsFloatLike(
    BEDS_TAIL_SEC_BOUNDS,
    `beds.tailSec must be number in [${BEDS_TAIL_SEC_BOUNDS.min}, ${BEDS_TAIL_SEC_BOUNDS.max}]`,
  ),
});

export const silenceTrimPatchSchema = settingsBlockOf({
  enabled: settingsBoolLike(),
  minGapMs: settingsIntLike(
    SILENCE_TRIM_MIN_GAP_MS_BOUNDS,
    `silenceTrim.minGapMs must be int in [${SILENCE_TRIM_MIN_GAP_MS_BOUNDS.min}, ${SILENCE_TRIM_MIN_GAP_MS_BOUNDS.max}]`,
  ),
});

export const crossfadeDurationSchema = settingsFloatLike(
  CROSSFADE_DURATION_BOUNDS,
  `crossfadeDuration must be number in [${CROSSFADE_DURATION_BOUNDS.min}, ${CROSSFADE_DURATION_BOUNDS.max}]`,
);

// Both depths ride ONE block so the pair is posted together: they are read once
// at mixer startup from two liquidsoap_duck_*.txt files, and a half-applied
// pair leaves the light layer louder than the heavy one until the next save.
export const duckingPatchSchema = settingsBlockOf({
  voice: settingsFloatLike(
    DUCK_DEPTH_BOUNDS,
    `ducking.voice must be number in [${DUCK_DEPTH_BOUNDS.min}, ${DUCK_DEPTH_BOUNDS.max}]`,
  ),
  intro: settingsFloatLike(
    DUCK_DEPTH_BOUNDS,
    `ducking.intro must be number in [${DUCK_DEPTH_BOUNDS.min}, ${DUCK_DEPTH_BOUNDS.max}]`,
  ),
});

// Show handover timing (#1576). A block rather than a flat key so a second
// timing knob lands beside this one.
export const handoverOffsetMinutesSchema = settingsIntLike(
  HANDOVER_OFFSET_BOUNDS,
  `handover.offsetMinutes must be int in [${HANDOVER_OFFSET_BOUNDS.min}, ${HANDOVER_OFFSET_BOUNDS.max}]`,
).refine(
  v => v % HANDOVER_OFFSET_STEP_MINUTES === 0,
  `handover.offsetMinutes must be a multiple of ${HANDOVER_OFFSET_STEP_MINUTES}`,
);

export const handoverPatchSchema = settingsBlockOf({
  offsetMinutes: handoverOffsetMinutesSchema,
});

// Per-effect kill switches for the DJ transition kit (#1565). Nested rather
// than flat beside pairDrain/stemBlends, which are drain SCHEDULING. Every
// field is absent-means-on; settings/transition-effects.ts is the one resolver.
export const TRANSITION_EFFECTS = ['sweep', 'washout', 'blend', 'dissolve', 'chop', 'loop'] as const;
export type TransitionEffect = (typeof TRANSITION_EFFECTS)[number];

const transitionEffectsPatchSchema = settingsBlockOf({
  sweep: settingsBoolLike(),
  washout: settingsBoolLike(),
  blend: settingsBoolLike(),
  dissolve: settingsBoolLike(),
  chop: settingsBoolLike(),
  loop: settingsBoolLike(),
});

export const transitionsPatchSchema = settingsBlockOf({
  // stemBlends needs pairDrain, but that is resolved at drain time in
  // broadcast/drain-policy.ts and has never been a save-time refusal.
  pairDrain: settingsBoolLike(),
  stemBlends: settingsBoolLike(),
  effects: transitionEffectsPatchSchema,
});

export const webhooksPolicyPatchSchema = settingsBlockOf({
  trackPlayListenerGated: settingsBoolLike(),
});

export const uiPatchSchema = settingsBlockOf({
  boothBuddy: settingsBoolLike(),
  tuneInOverlay: settingsBoolLike(),
  // Silently DROPPED when it doesn't match, never refused. No `?? ''`, so
  // String(null) is 'null' and String(7) is '7', both of which match the slug
  // pattern and are stored today. undefined is how a field opts out.
  skin: z.unknown().transform((raw) => {
    const slug = String(raw).trim().toLowerCase();
    return SETTINGS_SKIN_RE.test(slug) ? slug : undefined;
  }),
});

export const loudnessPatchSchema = settingsBlockOf({
  targetLufs: settingsFloatLike(
    LOUDNESS_TARGET_LUFS_BOUNDS,
    `loudness.targetLufs must be number in [${LOUDNESS_TARGET_LUFS_BOUNDS.min}, ${LOUDNESS_TARGET_LUFS_BOUNDS.max}]`,
  ),
  maxBoostDb: settingsFloatLike(
    LOUDNESS_MAX_BOOST_DB_BOUNDS,
    `loudness.maxBoostDb must be number in [${LOUDNESS_MAX_BOOST_DB_BOUNDS.min}, ${LOUDNESS_MAX_BOOST_DB_BOUNDS.max}]`,
  ),
  source: settingsStrictOneOf(
    SETTINGS_LOUDNESS_SOURCES,
    `loudness.source must be one of: ${SETTINGS_LOUDNESS_SOURCES.join(', ')}`,
  ),
});

export const archivePatchSchema = settingsBlockOf({
  enabled: settingsBoolLike(),
  bitrate: settingsIntOneOf(
    SETTINGS_MP3_BITRATES,
    `archive.bitrate must be one of: ${SETTINGS_MP3_BITRATES.join(', ')}`,
  ),
  // The dash in the message is an EN DASH (U+2013). Retyping it as a hyphen
  // changes the operator's toast.
  retentionDays: settingsIntLike(
    { min: 0, max: 3650 },
    'archive.retentionDays must be 0 (keep forever) or 1–3650 days',
  ),
});

// Scheduled, rotating backups (#1570). `off` MUST stay first: an upgraded
// station has no `backups` block, reads as `off` and writes nothing. Cadences
// are elapsed-time, not calendar (`monthly` is 30 days); an hourly tick applies
// them, so a station up part of the day still gets its backup. See backup/pure.ts.
export const SETTINGS_BACKUP_CADENCES = ['off', 'daily', 'weekly', 'monthly'] as const;

// Named once so a cadence added here is a compile error everywhere it is not
// handled rather than a silent `?? id` fallback (#1585 review).
export type BackupCadence = (typeof SETTINGS_BACKUP_CADENCES)[number];
export interface ScheduledBackupSettings {
  cadence: BackupCadence;
  keep: number;
}

// Keep-last-N. Floor is 1, not 0: a retention that could delete the backup the
// run just wrote leaves nothing behind. Ceiling is disk sympathy.
export const BACKUP_KEEP_BOUNDS: SettingsNumericBound = { min: 1, max: 100 };

// Shipped retention, and the answer every lenient path gives for an unreadable
// `keep` — see clampBackupKeep.
export const BACKUP_KEEP_DEFAULT = 7;

/**
 * The one lenient reading of `keep`, shared by settings.load()'s normaliser and
 * the retention sweep. An unreadable value falls to BACKUP_KEEP_DEFAULT, never
 * to the floor of 1, which is the most destructive answer available. The strict
 * path (`backupsPatchSchema`) refuses what this repairs.
 */
export function clampBackupKeep(raw: unknown): number {
  // Absent and empty are NO answer, not zero: Number(null)/Number('') are both
  // 0 and would clamp to the floor.
  if (raw === null || raw === undefined || raw === '') return BACKUP_KEEP_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return BACKUP_KEEP_DEFAULT;
  return Math.min(BACKUP_KEEP_BOUNDS.max, Math.max(BACKUP_KEEP_BOUNDS.min, Math.floor(n)));
}

export const backupsPatchSchema = settingsBlockOf({
  cadence: settingsStrictOneOf(
    SETTINGS_BACKUP_CADENCES,
    `backups.cadence must be one of: ${SETTINGS_BACKUP_CADENCES.join(', ')}`,
  ),
  // parseInt family, like archive.retentionDays: the admin number input posts a
  // string on some paths, and a float is truncated rather than refused.
  keep: settingsIntLike(
    BACKUP_KEEP_BOUNDS,
    `backups.keep must be int in [${BACKUP_KEEP_BOUNDS.min}, ${BACKUP_KEEP_BOUNDS.max}]`,
  ),
});

export const streamPatchSchema = settingsBlockOf({
  opusEnabled: settingsBoolLike(),
  flacEnabled: settingsBoolLike(),
  oggIcyMetadata: settingsBoolLike(),
  aacEnabled: settingsBoolLike(),
  idleWhenEmpty: settingsBoolLike(),
  opusBitrate: settingsIntOneOf(
    SETTINGS_OPUS_BITRATES,
    `stream.opusBitrate must be one of: ${SETTINGS_OPUS_BITRATES.join(', ')}`,
  ),
  aacBitrate: settingsIntOneOf(
    SETTINGS_AAC_BITRATES,
    `stream.aacBitrate must be one of: ${SETTINGS_AAC_BITRATES.join(', ')}`,
  ),
  bitrate: settingsIntOneOf(
    SETTINGS_MP3_BITRATES,
    `stream.bitrate must be one of: ${SETTINGS_MP3_BITRATES.join(', ')}`,
  ),
  // Number(), not parseInt: ''/null/[] are 0 (a legal "no burst") and '5abc' is
  // refused. Bounds tested before the round.
  bufferSeconds: settingsNumberPreRoundLike(
    STREAM_BUFFER_SECONDS_BOUNDS,
    `stream.bufferSeconds must be a number between ${STREAM_BUFFER_SECONDS_BOUNDS.min} and ${STREAM_BUFFER_SECONDS_BOUNDS.max}`,
  ),
  idleAfterMinutes: settingsIntLike(
    { min: 1, max: 1440 },
    'stream.idleAfterMinutes must be an integer between 1 and 1440',
  ),
  maxListeners: settingsIntLike(
    STREAM_MAX_LISTENERS_BOUNDS,
    `stream.maxListeners must be an integer between ${STREAM_MAX_LISTENERS_BOUNDS.min} and ${STREAM_MAX_LISTENERS_BOUNDS.max}`,
  ),
  // A header NAME, not a country. Malformed is REFUSED, not dropped: the only
  // other feedback is the Stats page staying blank a day later.
  countryHeader: settingsHeaderNameLike(
    'stream.countryHeader must be a header name (letters, digits and - _ . ~ ! # $ % & \' * + ^ ` |), or empty',
  ),
  // Absolute path to an operator-supplied .mmdb. Not existence-checked: the
  // bind mount may belong to another container, and the reader fails open.
  geoipDbPath: settingsTrimmedString(
    STREAM_GEOIP_DB_PATH_MAX,
    `stream.geoipDbPath must be ${STREAM_GEOIP_DB_PATH_MAX} characters or fewer`,
  ),
});

export const weatherPatchSchema = settingsBlockOf({
  lat: settingsFloatLike({ min: -90, max: 90 }, 'weather.lat out of range'),
  lng: settingsFloatLike({ min: -180, max: 180 }, 'weather.lng out of range'),
  // Non-string or blank is IGNORED, not refused, so the weather label can never
  // be blanked; over-80 truncates rather than failing.
  locationName: z.unknown().transform((raw) => {
    if (typeof raw !== 'string' || !raw.trim()) return undefined;
    return raw.trim().slice(0, 80);
  }),
  // Same, except '' IS accepted here: it resets to the locationName fallback.
  onAirLocation: z.unknown().transform((raw) => {
    if (typeof raw !== 'string') return undefined;
    return raw.trim().slice(0, 80);
  }),
  units: settingsStrictOneOf(
    ['metric', 'imperial'] as const,
    "weather.units must be 'metric' or 'imperial'",
  ),
});

// Refuses over-length where load() truncates: the strict/lenient split.
export const stationSchema = settingsTrimmedString(
  SETTINGS_STATION_NAME_MAX,
  `station name must be ${SETTINGS_STATION_NAME_MAX} chars or fewer`,
).transform((v) => (v === '' ? SETTINGS_STATION_DEFAULT_NAME : v));

export const stationDescriptionSchema = settingsTrimmedString(
  SETTINGS_STATION_DESCRIPTION_MAX,
  `station description must be ${SETTINGS_STATION_DESCRIPTION_MAX} chars or fewer`,
);

export const djHouseRulesSchema = settingsTrimmedString(
  SETTINGS_DJ_HOUSE_RULES_MAX,
  `djHouseRules must be at most ${SETTINGS_DJ_HOUSE_RULES_MAX} chars`,
);

// The three switches below are strict `z.boolean()`, NOT settingsBoolLike():
// only a PATCH is refused, since load() coerces a hand-edited settings.json to
// the default. A show's own `fadeAtShowEnd` (schemas/show.ts) is the tri-state
// that overrides the station default here.
export const djSpeakClockSchema = z.boolean({
  error: 'djSpeakClock must be a boolean',
});

export const djTalkOnlyBetweenTracksSchema = z.boolean({
  error: 'djTalkOnlyBetweenTracks must be a boolean',
});

export const fadeAtShowEndSchema = z.boolean({
  error: 'fadeAtShowEnd must be a boolean',
});

/**
 * Trim FIRST, then a strict pair: ' en-GB ' saves, 'en-gb' does not. Not
 * settingsStrictOneOf, which tests the raw value.
 */
export const localeSchema = z
  .unknown()
  .superRefine((raw, ctx) => {
    const v = String(raw ?? '').trim();
    if (v !== 'en-GB' && v !== 'en-US') {
      ctx.addIssue({ code: 'custom', message: "locale must be 'en-GB' or 'en-US'" });
    }
  })
  .transform((raw) => String(raw ?? '').trim());

export const audioPatchSchema = settingsBlockOf({
  embeddings: settingsBoolLike(),
  vocalActivity: settingsBoolLike(),
  stemCache: settingsBoolLike(),
  analyzeQuietOnly: settingsBoolLike(),
  // Number() with NO floor: a fractional GB budget stores as a float, and
  // load() doesn't floor it either.
  stemCacheGb: settingsNumberLike(
    { min: 1, max: 1000 },
    'audio.stemCacheGb must be between 1 and 1000',
  ),
  analyzeQuietMinutes: settingsNumberFloorLike(
    { min: 1, max: 120 },
    'audio.analyzeQuietMinutes must be between 1 and 120',
  ),
});

// Track-selection windows both pick paths read. New key, so settingsNumberLike
// is chosen on merit (refuses '6abc', keeps the fraction).
export const pickerPatchSchema = settingsBlockOf({
  albumHours: settingsNumberLike(
    PICKER_ALBUM_HOURS_BOUNDS,
    `picker.albumHours must be between ${PICKER_ALBUM_HOURS_BOUNDS.min} and ${PICKER_ALBUM_HOURS_BOUNDS.max} (0 = off)`,
  ),
  // Bounds only. The crossfade-derived lower bound on a positive value is a
  // function of settings.crossfadeDuration, so update() enforces it.
  minTrackLengthSeconds: settingsNumberLike(
    PICKER_MIN_TRACK_LENGTH_BOUNDS,
    `picker.minTrackLengthSeconds must be between ${PICKER_MIN_TRACK_LENGTH_BOUNDS.min} and ${PICKER_MIN_TRACK_LENGTH_BOUNDS.max} (0 = off)`,
  ),
});

export const likesPatchSchema = settingsBlockOf({
  enabled: settingsBoolLike(),
  starInNavidrome: settingsBoolLike(),
  influenceDj: settingsBoolLike(),
  maxTracks: settingsNumberRoundLike({ min: 1, max: 25 }, 'likes.maxTracks must be 1-25'),
  windowDays: settingsNumberRoundLike(
    { min: 0, max: 365 },
    'likes.windowDays must be 0-365 (0 = all time)',
  ),
});

export const searchPatchSchema = settingsBlockOf({
  provider: settingsStrictOneOf(
    SETTINGS_SEARCH_PROVIDERS,
    `search.provider must be one of: ${SETTINGS_SEARCH_PROVIDERS.join(', ')}`,
  ),
  // The one field here that TYPE-CHECKS instead of coercing: a number or null
  // is refused, where scrobble.listenbrainz.baseUrl stringifies it. Not unified.
  baseUrl: z
    .unknown()
    .superRefine((raw, ctx) => {
      if (typeof raw !== 'string') {
        ctx.addIssue({ code: 'custom', message: 'search.baseUrl must be a string' });
        return;
      }
      const v = raw.trim();
      if (v.length > 500) {
        ctx.addIssue({ code: 'custom', message: 'search.baseUrl too long' });
        return;
      }
      if (v && !/^https?:\/\//i.test(v)) {
        ctx.addIssue({
          code: 'custom',
          message: 'search.baseUrl must start with http:// or https://',
        });
      }
    })
    .transform((raw) => String(raw).trim()),
  apiKey: settingsRawStringLike(200, 'search.apiKey must be 0-200 chars'),
  // Optional comma-separated SearXNG engine pin (#1353), appended as the
  // `engines=` query param when non-empty. Trimmed posture, unlike search.apiKey.
  searxngEngines: settingsTrimmedString(
    SETTINGS_SEARXNG_ENGINES_MAX,
    `search.searxngEngines must be 0-${SETTINGS_SEARXNG_ENGINES_MAX} chars`,
  ),
});

const scrobbleLastfmSchema = settingsBlockOf({
  enabled: settingsBoolLike(),
  username: settingsTrimmedString(40, 'scrobble.lastfm.username must be 0-40 chars'),
  apiKey: settingsTrimmedString(200, 'scrobble.lastfm.apiKey must be 0-200 chars'),
  apiSecret: settingsTrimmedString(200, 'scrobble.lastfm.apiSecret must be 0-200 chars'),
  sessionKey: settingsTrimmedString(200, 'scrobble.lastfm.sessionKey must be 0-200 chars'),
});

const scrobbleListenbrainzSchema = settingsBlockOf({
  enabled: settingsBoolLike(),
  username: settingsTrimmedString(40, 'scrobble.listenbrainz.username must be 0-40 chars'),
  userToken: settingsTrimmedString(200, 'scrobble.listenbrainz.userToken must be 0-200 chars'),
  // No trailing-slash strip: the consumer appends /submit-listens.
  baseUrl: settingsUrlLike({
    max: 500,
    tooLong: 'scrobble.listenbrainz.baseUrl too long',
    badScheme: 'scrobble.listenbrainz.baseUrl must start with http:// or https://',
  }),
});

// Navidrome (#1298) carries an enable flag only: the credentials are already
// the station's own `config.navidrome`.
const scrobbleNavidromeSchema = settingsBlockOf({
  enabled: settingsBoolLike(),
});

export const scrobblePatchSchema = settingsBlockOf({
  lastfm: scrobbleLastfmSchema,
  listenbrainz: scrobbleListenbrainzSchema,
  navidrome: scrobbleNavidromeSchema,
});

/**
 * `''` = Auto (container TZ). A try/catch probe rather than
 * `Intl.supportedValuesOf` so aliases validate too (Europe/Kiev, US/Pacific,
 * +05:30). Case-insensitive, and the accepted string is stored verbatim.
 * time.ts re-exports this rather than keeping a second copy.
 */
export function settingsIsValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const timezoneSchema = z
  .unknown()
  .superRefine((raw, ctx) => {
    const v = String(raw ?? '').trim();
    if (v !== '' && !settingsIsValidTimezone(v)) {
      ctx.addIssue({
        code: 'custom',
        // The dash is an EM DASH (U+2014).
        message: `invalid timezone "${v}" — use an IANA name like Europe/Athens`,
      });
    }
  })
  .transform((raw) => String(raw ?? '').trim());

/**
 * The privacy block's FIELD rules only. The lock-needs-a-password invariant
 * reads the MERGED state, so it stays in update() alongside the listenerAuth
 * restart decision. `publishPersonaSouls` is outside that invariant.
 */
export const privacyPatchSchema = settingsBlockOf({
  privatePlayer: settingsBoolLike(),
  publishPersonaSouls: settingsBoolLike(),
  listenerAuth: settingsBoolLike(),
  password: z
    .unknown()
    .superRefine((raw, ctx) => {
      const v = String(raw ?? '').trim();
      if (v.length > 128) {
        ctx.addIssue({ code: 'custom', message: 'privacy.password must be 0-128 chars' });
        return;
      }
      // The password travels in basic-auth userinfo and ?auth= query strings.
      // trim() has stripped the ends, so this only fires on interior space.
      if (/[\s]/.test(v)) {
        ctx.addIssue({
          code: 'custom',
          message: 'privacy.password must not contain whitespace',
        });
      }
    })
    .transform((raw) => String(raw ?? '').trim()),
});

/**
 * `requests` — every field falls back to the CURRENT stored value, so the
 * schema only decides "usable or absent" and update() supplies the fallback.
 * Usable is narrow on purpose: only a number, bigint or NON-BLANK string.
 * null/''/false/[] all coerce to 0 under Number(), and an emptied admin input
 * arrives as JSON null, so without the guard it clamps to the field's floor.
 *
 * The booleans are `typeof === 'boolean'`, NOT `!!` — a truthy non-boolean is
 * IGNORED, the opposite posture to ui/privacy. Neither may be unified.
 */
function settingsRequestsInt(bounds: SettingsNumericBound) {
  return z.unknown().transform((raw) => {
    if (typeof raw === 'string') {
      if (!raw.trim()) return undefined;
    } else if (typeof raw !== 'number' && typeof raw !== 'bigint') {
      return undefined;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) return undefined;
    return Math.min(bounds.max, Math.max(bounds.min, Math.round(n)));
  });
}

function settingsRequestsBool() {
  return z.unknown().transform((raw) => (typeof raw === 'boolean' ? raw : undefined));
}

export const requestsPatchSchema = settingsBlockOf({
  enabled: settingsRequestsBool(),
  onePendingPerIp: settingsRequestsBool(),
  maxPending: settingsRequestsInt({ min: 1, max: 50 }),
  globalHourlyCap: settingsRequestsInt({ min: 5, max: 500 }),
  repeatCooldownMin: settingsRequestsInt({ min: 0, max: 1440 }),
  cooldownSec: settingsRequestsInt({ min: 5, max: 600 }),
  perIpHourlyCap: settingsRequestsInt({ min: 1, max: 100 }),
});

export const SETTINGS_MOODS_LIMIT = 40;
export const SETTINGS_MOOD_NAME_MAX = 40;
export const SETTINGS_MOOD_PROMPT_MAX = 200;
export const SETTINGS_FESTIVALS_LIMIT = 50;

// The 8 fixed time-of-day slots and the 6 fixed weather conditions. Both maps
// are REBUILT over these key sets, so an unknown key in the patch is dropped.
export const SETTINGS_MOOD_PERIODS = [
  'early-morning', 'morning', 'midday', 'afternoon',
  'drive-time', 'evening', 'late-evening', 'after-hours',
] as const;
export const SETTINGS_WEATHER_CONDITIONS = [
  'clear', 'cloudy', 'foggy', 'rainy', 'snowy', 'stormy',
] as const;

/** Canonical mood id form. The operator's typed string is silently rewritten. */
export function settingsNormalizeMoodName(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Context the three mood maps validate against. `moodNames: null` means "this
 * caller cannot check that rule" (the ShowSchemaContext convention): the route
 * passes null and checks SHAPE only, because the effective vocabulary depends
 * on whether `moods` rides in the same patch, which is update()'s to know.
 */
export interface SettingsMoodContext {
  moodNames: string[] | null;
}

export const moodsSchema = z
  .unknown()
  .superRefine((raw, ctx) => {
    if (!Array.isArray(raw)) {
      ctx.addIssue({ code: 'custom', message: 'moods must be an array' });
      return;
    }
    if (raw.length < 1) {
      ctx.addIssue({ code: 'custom', message: 'moods must have at least one entry' });
      return;
    }
    if (raw.length > SETTINGS_MOODS_LIMIT) {
      ctx.addIssue({
        code: 'custom',
        message: `moods must be at most ${SETTINGS_MOODS_LIMIT} entries`,
      });
      return;
    }
    const seen = new Set<string>();
    raw.forEach((item, i) => {
      if (!item || typeof item !== 'object') {
        ctx.addIssue({ code: 'custom', message: `moods[${i}] must be an object`, path: [i] });
        return;
      }
      const name = settingsNormalizeMoodName((item as { name?: unknown }).name);
      if (name.length < 1 || name.length > SETTINGS_MOOD_NAME_MAX) {
        ctx.addIssue({
          code: 'custom',
          message: `moods[${i}].name must be 1-${SETTINGS_MOOD_NAME_MAX} chars (letters, digits, dashes)`,
          path: [i, 'name'],
        });
        return;
      }
      // Duplicates are detected on the NORMALISED name, so 'Chill' + 'chill'
      // is a refusal rather than two rows.
      if (seen.has(name)) {
        ctx.addIssue({
          code: 'custom',
          message: `moods[${i}].name "${name}" is a duplicate`,
          path: [i, 'name'],
        });
        return;
      }
      seen.add(name);
    });
  })
  .transform((raw) =>
    (raw as Array<Record<string, unknown>>).map((item) => ({
      name: settingsNormalizeMoodName(item.name),
      clapPrompt:
        typeof item.clapPrompt === 'string'
          ? item.clapPrompt.trim().slice(0, SETTINGS_MOOD_PROMPT_MAX)
          : '',
    })),
  );

/**
 * A fixed-key mood map, rebuilt over its own key set. `allowEmpty` is the one
 * difference and it is not cosmetic: moodSchedule requires all 8 periods (an
 * omitted one coerces to '' and refuses), while weatherMoods reads '' as "no
 * mood steer", so a patch naming one condition BLANKS the other five and 200s.
 */
function settingsMoodMap(
  keys: readonly string[],
  label: string,
  allowEmpty: boolean,
  ctx: SettingsMoodContext,
) {
  const names = ctx.moodNames ? new Set(ctx.moodNames) : null;
  const list = ctx.moodNames ? ctx.moodNames.join(', ') : '';
  return z
    .unknown()
    .superRefine((raw, issues) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        issues.addIssue({ code: 'custom', message: `${label} must be an object` });
        return;
      }
      if (!names) return; // shape-only posture — see SettingsMoodContext
      for (const key of keys) {
        const v = String((raw as Record<string, unknown>)[key] ?? '').trim();
        if (allowEmpty && !v) continue;
        if (!names.has(v)) {
          issues.addIssue({
            code: 'custom',
            message: allowEmpty
              ? `${label}.${key} must be a mood (${list}) or empty`
              : `${label}.${key} must be one of: ${list}`,
            path: [key],
          });
        }
      }
    })
    .transform((raw) => {
      const src = (raw || {}) as Record<string, unknown>;
      const out: Record<string, string> = {};
      for (const key of keys) out[key] = String(src[key] ?? '').trim();
      return out;
    });
}

export function moodScheduleSchema(ctx: SettingsMoodContext) {
  return settingsMoodMap(SETTINGS_MOOD_PERIODS, 'moodSchedule', false, ctx);
}

export function weatherMoodsSchema(ctx: SettingsMoodContext) {
  return settingsMoodMap(SETTINGS_WEATHER_CONDITIONS, 'weatherMoods', true, ctx);
}

// Festival field bounds. Named because the admin editor reads the same numbers
// for its maxLength / min / max attributes.
export const SETTINGS_FESTIVAL_NAME_MAX = 80;
export const SETTINGS_FESTIVAL_DESCRIPTION_MAX = 200;
// Days either side of the date on which the festival's mood applies.
export const SETTINGS_FESTIVAL_WINDOW_DAYS_MAX = 14;

export function festivalsSchema(ctx: SettingsMoodContext) {
  const names = ctx.moodNames ? new Set(ctx.moodNames) : null;
  const list = ctx.moodNames ? ctx.moodNames.join(', ') : '';
  return z
    .unknown()
    .superRefine((raw, issues) => {
      if (!Array.isArray(raw)) {
        issues.addIssue({ code: 'custom', message: 'festivals must be an array' });
        return;
      }
      if (raw.length > SETTINGS_FESTIVALS_LIMIT) {
        issues.addIssue({
          code: 'custom',
          message: `festivals must be at most ${SETTINGS_FESTIVALS_LIMIT} entries`,
        });
        return;
      }
      raw.forEach((item, i) => {
        const add = (message: string, field?: string) =>
          issues.addIssue({
            code: 'custom',
            message,
            path: field ? [i, field] : [i],
          });
        if (!item || typeof item !== 'object') {
          add(`festivals[${i}] must be an object`);
          return;
        }
        const f = item as Record<string, unknown>;
        const name = String(f.name ?? '').trim();
        if (name.length < 1 || name.length > SETTINGS_FESTIVAL_NAME_MAX) {
          add(`festivals[${i}].name must be 1-${SETTINGS_FESTIVAL_NAME_MAX} chars`, 'name');
          return;
        }
        const month = Number(f.month);
        if (!Number.isInteger(month) || month < 1 || month > 12) {
          add(`festivals[${i}].month must be an integer 1-12`, 'month');
          return;
        }
        // Feb allows 29; in a common year a leap-day festival fires Mar 1
        // (Date.UTC rolls over in getFestivalContext). Indexed off the month,
        // so it must stay downstream of the month check. `?? 31` is
        // unreachable but the web build typechecks the mirror under
        // noUncheckedIndexedAccess.
        const daysInMonth = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 31;
        const day = Number(f.day);
        if (!Number.isInteger(day) || day < 1 || day > daysInMonth) {
          add(
            `festivals[${i}].day must be an integer 1-${daysInMonth} for month ${month}`,
            'day',
          );
          return;
        }
        // '' is not allowed: it simply fails set membership.
        const mood = String(f.mood ?? '').trim();
        if (names && !names.has(mood)) {
          add(`festivals[${i}].mood must be one of: ${list}`, 'mood');
          return;
        }
        const windowDays = Number(f.windowDays ?? 0);
        if (
          !Number.isInteger(windowDays)
          || windowDays < 0
          || windowDays > SETTINGS_FESTIVAL_WINDOW_DAYS_MAX
        ) {
          add(
            `festivals[${i}].windowDays must be an integer 0-${SETTINGS_FESTIVAL_WINDOW_DAYS_MAX}`,
            'windowDays',
          );
        }
      });
    })
    .transform((raw) =>
      (raw as Array<Record<string, unknown>>).map((f) => ({
        month: Number(f.month),
        day: Number(f.day),
        name: String(f.name ?? '').trim(),
        mood: String(f.mood ?? '').trim(),
        description:
          typeof f.description === 'string'
            ? f.description.trim().slice(0, SETTINGS_FESTIVAL_DESCRIPTION_MAX)
            : '',
        windowDays: Number(f.windowDays ?? 0),
      })),
    );
}


/**
 * `theme` — only `active` is a settings value; the rest is derived at serve
 * time. A non-object block is a no-op, and `{theme: {}}` is a legal no-op.
 * The "does this theme id exist" check stays in update(): it is async and it
 * FALLS BACK to the built-in default rather than refusing (#917), so a restore
 * naming a retired theme still lands.
 */
export const themePatchSchema = z.preprocess(
  (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {}),
  z.object({
    active: z
      .unknown()
      .optional()
      .transform((raw, ctx) => {
        if (raw === undefined) return undefined;
        const v = String(raw ?? '').trim();
        if (!v) {
          ctx.addIssue({ code: 'custom', message: 'theme.active must be a theme id' });
          return z.NEVER;
        }
        return v;
      }),
  }),
);

/**
 * The station-wide track-length cap. 0 = unlimited. BOUNDS ONLY: the
 * crossfade-derived floor ("a non-zero cap must leave solo airtime") is a
 * function of a crossfade the same patch may be changing, so update() judges it.
 */
export function maxTrackSecondsValueSchema(bounds: SettingsNumericBound) {
  return settingsIntLike(
    bounds,
    `maxTrackSeconds must be int in [${bounds.min}, ${bounds.max}]`,
  );
}

/**
 * The registry entry: same rule, one posture looser. `rawMaxTrackSec`'s
 * precedence is "seconds wins when present and non-empty", so an absent/empty
 * value beside a legacy `maxTrackMinutes` hands off rather than failing;
 * update() then validates the RESOLVED value with the schema above. The
 * `maxTrackMinutes` alias is deliberately not registered — an unusable minutes
 * value is ignored today, and a schema on it would refuse a body that saves.
 */
export function maxTrackSecondsSchema(bounds: SettingsNumericBound) {
  const value = maxTrackSecondsValueSchema(bounds);
  return z.unknown().superRefine((raw, ctx) => {
    if (raw == null || raw === '') return;
    const r = value.safeParse(raw);
    if (!r.success) {
      for (const issue of r.error.issues) ctx.addIssue({ code: 'custom', message: issue.message });
    }
  });
}

/**
 * `activeDjPromptId` — '' selects the built-in default, otherwise a djPrompts
 * id. Coercion only: whether the id resolves is answered after `djPrompts` has
 * been applied, so it stays in update().
 */
export const activeDjPromptIdSchema = z
  .unknown()
  .optional()
  .transform((raw) => String(raw ?? '').trim());

/**
 * `djPrompt` — the legacy single-field prompt (onboarding, older clients). The
 * MAPPING onto the library stays in update(): '' selects the default, custom
 * text reuses an identical entry or appends a new one, and can hit the cap.
 */
export function djPromptTextSchema(bounds: { min: number; max: number }) {
  return z
    .unknown()
    .optional()
    .transform((raw, ctx) => {
      const v = String(raw ?? '').trim();
      if (v === '') return v;
      if (v.length < bounds.min || v.length > bounds.max) {
        ctx.addIssue({
          code: 'custom',
          message: `djPrompt must be empty (use the default) or ${bounds.min}-${bounds.max} chars`,
        });
        return z.NEVER;
      }
      if (!v.includes('{name}')) {
        ctx.addIssue({ code: 'custom', message: 'djPrompt must contain the {name} placeholder' });
        return z.NEVER;
      }
      return v;
    });
}
