// Shared schemas for individual `POST /settings` patch keys — the first slice
// of the mega-endpoint conversion (#1348, split out of #1337).
//
// HARD RULE: this file may import ONLY from 'zod'. It is copied verbatim into
// the web bundle, so a project import or a node builtin here breaks the mirror.
// Enforced by controller/eslint.config.mjs and by gen-schemas.ts.
//
// WHY A KEY AT A TIME, AND NOT ONE SCHEMA FOR THE SETTINGS OBJECT
// ---------------------------------------------------------------
// The `/settings` body is a partial PATCH: every admin panel posts only the keys
// it owns. `z.object` strips unknown keys, so a schema over the whole settings
// object would silently delete whatever a form learns to send next. Instead each
// top-level key owns its own schema here and patch-registry.ts runs only the
// keys a patch actually carries, keeping the stripping scoped to blocks whose
// shape is fully known.
//
// FIDELITY IS THE POINT
// ---------------------
// No conversion may introduce a silent repair where the operator previously got
// a refusal, or vice versa (#1337's rule). The hand-rolled branches these
// replace carry a lot of ACCIDENTAL leniency, and reproducing it is most of the
// work:
//
//   * `parseInt`/`parseFloat` stringify first, so '5' and even '5abc' parse, and
//     a float on an int key TRUNCATES rather than failing (jingleRatio: 5.7
//     saves as 5). `z.number().int()` refuses all three — hence
//     settingsIntLike / settingsFloatLike.
//   * `!!value` accepts anything, so `enabled: 1` is `true`. See settingsBoolLike.
//   * `patch.beds || {}` makes a non-object block a silent no-op, not an error.
//     See settingsBlockOf.
//
// Tightening any of these is defensible — webhooks did exactly that — but it is
// a behaviour change and belongs in a PR that says so, so the frame itself can't
// be what hides a regression.
//
// The bounds live HERE rather than in defaults.ts's BOUNDS because a mirrored
// module may not import a non-mirrored one and the browser needs the same
// numbers to pre-flight the form; BOUNDS re-exports them. The web side must read
// from the mirror rather than hand-copying — which is what BedsSection did with
// a bare `60` and `15`.
import { z } from 'zod';

// Every top-level name in schemas/*.ts shares ONE scope in the flat mirror
// (module-private ones included), hence the SETTINGS_/settings prefixes.
export interface SettingsNumericBound {
  min: number;
  max: number;
}

// 0 = jingles off entirely — radio.liq skips the jingle rotate when the ratio
// file reads 0 (issue #997).
export const JINGLE_RATIO_BOUNDS: SettingsNumericBound = { min: 0, max: 1000 };

// 0 = bed every link whose incoming vocal onset is unknown. The ceiling is
// deliberately low: past ~60s the DJ has outlasted any script the generators
// produce, so a higher value is indistinguishable from beds being off.
export const BEDS_THRESHOLD_SEC_BOUNDS: SettingsNumericBound = { min: 0, max: 60 };

// The bed's ramp into the next song. bed-policy clamps this against the bed's
// own length too, so a long ramp on a short link can't invert the arithmetic.
export const BEDS_CROSS_SEC_BOUNDS: SettingsNumericBound = { min: 0, max: 15 };

// Dead-air trim: the smallest edge gap worth cutting. The FLOOR is what keeps
// the feature from eating deliberate silence — a segued album leaves a beat
// between tracks on purpose, and a mastering blank worth a cue point is
// measured in seconds, not frames. The ceiling bounds the same mistake from
// the other side: past 30s an operator is describing a different problem
// (a corrupt rip) than the one a cue point solves.
export const SILENCE_TRIM_MIN_GAP_MS_BOUNDS: SettingsNumericBound = { min: 250, max: 30000 };

/**
 * `parseInt(raw, 10)` + a bounds check, exactly as the hand-rolled branch did.
 *
 * The parse is deliberately NOT `z.coerce.number().int()`. parseInt stringifies
 * its argument and reads a LEADING integer, so it accepts the string forms an
 * older admin build still posts and truncates a float instead of refusing it.
 * Swapping in a strict numeric schema turns three silent repairs into refusals
 * at once, which is the failure #1337 rules out.
 *
 * `message` names its own field because it is also the flat `error` string the
 * operator's toast shows, and those strings are unchanged from the branches
 * this replaces. patch-registry.ts is what supplies the dotted path for
 * `fieldErrors`, so the location is never lost.
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

/** `parseFloat(raw)` + a bounds check. Same rationale as settingsIntLike. */
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
 * `!!value` — accepts anything, like the branches this replaces.
 *
 * Not `z.boolean()`. These keys are reached by backup restore, which posts a
 * whole (possibly hand-edited) settings.json straight to update(); a truthy
 * non-boolean that saves today would begin failing the entire restore.
 */
export function settingsBoolLike() {
  return z.unknown().transform((v) => !!v);
}

/**
 * A settings BLOCK — `{ enabled?, … }` — with the branches' own leniency:
 *
 *  - a non-object (or null) block is an empty patch, not an error, because
 *    `patch.beds || {}` followed by `bd.x !== undefined` no-ops on anything
 *    that isn't an object;
 *  - an explicitly-undefined field is absent, matching `!== undefined`;
 *  - unknown fields inside the block are dropped rather than refused. Only the
 *    TOP-level key inventory rejects unknowns (see patch-registry.ts), and for
 *    the same reason it is a route-only posture: a backup written by a newer
 *    version carries block fields this one has never heard of, and restore must
 *    not die on them.
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
 * `Number(raw)` + a bounds check, with NO rounding.
 *
 * A THIRD numeric family, and the distinction is load-bearing. `Number('10abc')`
 * is NaN where `parseInt('10abc')` is 10, and `Number('')`/`Number(null)`/
 * `Number([])` are 0 where parseInt gives NaN. Branches using `Number()` refuse
 * junk strings and accept empty-ish values as zero — the exact opposite of the
 * parseInt family on both counts. Reusing settingsIntLike here would silently
 * start accepting '10abc' and start refusing null.
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
 * `Math.round(Number(raw))` + bounds, checked on the ROUNDED value.
 *
 * The rounding happens BEFORE the bounds test, so it can carry a value across
 * a bound in both directions: with [1, 25], `0.6` rounds to 1 and is accepted
 * while `0.4` rounds to 0 and is refused; `25.4` is accepted and `25.5` is
 * refused. A `z.number().int().min(1).max(25)` refuses all four. Preserved
 * deliberately — this is likes.maxTracks / likes.windowDays.
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
 * `Number(raw)` bounds-checked BEFORE rounding, then rounded.
 *
 * stream.bufferSeconds only, and the order is the whole point: `59.6` passes
 * the `<= 60` test and stores as 60, while `60.4` fails it. Checking after the
 * round would accept 60.4; checking without rounding would store the fraction.
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
 *
 * Deliberately not `z.enum`: zod's built-in message names the constraint in its
 * own words ('Invalid option: expected one of …'), and the registry carries the
 * message verbatim to the operator. These strings must not change.
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
 * `String(raw ?? '').trim()` + a maximum length, measured AFTER the trim.
 *
 * Note `?? ''`: null becomes the empty string (clearing the field), NOT the
 * literal 'null'. Which of those a branch does varies by key and both are
 * reproduced — see settingsRawStringLike for the other posture.
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
 * `String(raw)` with NO trim and NO nullish default — search.apiKey's posture.
 *
 * `null` becomes the four-character string 'null' and is STORED. That is not a
 * good design, but it is the shipping one, and a secret field is the last place
 * to change storage behaviour by accident.
 */
export function settingsRawStringLike(max: number, message: string) {
  return z
    .unknown()
    .superRefine((raw, ctx) => {
      if (String(raw).length > max) ctx.addIssue({ code: 'custom', message });
    })
    .transform((raw) => String(raw));
}

/**
 * A URL field: trim, length, then an http(s) scheme test on a non-empty value.
 *
 * `stripTrailingSlashes` is per-field and must be set from the branch being
 * replaced — embedding's URLs strip them, search.baseUrl and
 * scrobble.listenbrainz.baseUrl keep theirs (that consumer appends a path).
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

// --- vocabularies the converted keys need ----------------------------------
// Re-exported by settings/vocab.ts and settings/defaults.ts rather than
// duplicated: a mirrored module may not import a non-mirrored one, so whichever
// feature converts first owns the constant.

// Allowed MP3 bitrates — shared by the hourly archive and the live /stream.mp3
// mount. Matches the literal branches in radio.liq — %mp3(bitrate=…) needs a
// parse-time int, so the encoder is pre-baked for this small set. Add a branch
// in radio.liq if you add a value here.
export const SETTINGS_MP3_BITRATES = [64, 96, 128, 160, 192, 320] as const;
// Opus + AAC encoders share the same parse-time-literal constraint as %mp3.
export const SETTINGS_OPUS_BITRATES = [96, 128, 192, 256, 320] as const;
export const SETTINGS_AAC_BITRATES = [128, 192, 256] as const;

// Where per-track loudness comes from (queue.applyLoudnessGain, issue #998).
export const SETTINGS_LOUDNESS_SOURCES = [
  'replaygain-then-measured',
  'replaygain',
  'measured',
] as const;

export const SETTINGS_SEARCH_PROVIDERS = ['duckduckgo', 'tavily', 'brave', 'searxng'] as const;

export const CROSSFADE_DURATION_BOUNDS: SettingsNumericBound = { min: 0, max: 30 };
// −23 (EBU R128 broadcast) … −9 (very loud); −14 is the streaming standard.
export const LOUDNESS_TARGET_LUFS_BOUNDS: SettingsNumericBound = { min: -23, max: -9 };
// 0 disables boosting entirely (cut-only levelling); 12 dB is plenty.
export const LOUDNESS_MAX_BOOST_DB_BOUNDS: SettingsNumericBound = { min: 0, max: 12 };
// 0 disables burst-on-connect; past 60 a listener is a full minute behind the
// live edge and <queue-size> (which must exceed the burst) gets unreasonable.
// Named rather than inline because settings.load() bounds the stored value
// against the SAME figures — a hand-copied pair there is how the save path and
// the load path drift.
export const STREAM_BUFFER_SECONDS_BOUNDS: SettingsNumericBound = { min: 0, max: 60 };

// Falling back to the product default is what an emptied station name does —
// see stationSchema.
export const SETTINGS_STATION_DEFAULT_NAME = 'SUB/WAVE';
export const SETTINGS_STATION_NAME_MAX = 80;
export const SETTINGS_STATION_DESCRIPTION_MAX = 200;
export const SETTINGS_DJ_HOUSE_RULES_MAX = 2000;

// The player skin is stored as a slug and never checked against a registry:
// the WEB side resolves it and falls back on unknowns, so an unrecognised value
// is DROPPED here rather than refused.
export const SETTINGS_SKIN_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

// --- the converted keys ----------------------------------------------------

// How many tracks play between jingles. Needs a mixer restart, which update()
// still decides — a schema says what a value may BE, never what applying it
// costs.
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

export const transitionsPatchSchema = settingsBlockOf({
  // stemBlends is documented as needing pairDrain, but that dependency is
  // resolved at drain time in broadcast/drain-policy.ts and has never been a
  // save-time refusal. Do not add one here.
  pairDrain: settingsBoolLike(),
  stemBlends: settingsBoolLike(),
});

export const webhooksPolicyPatchSchema = settingsBlockOf({
  trackPlayListenerGated: settingsBoolLike(),
});

export const uiPatchSchema = settingsBlockOf({
  boothBuddy: settingsBoolLike(),
  tuneInOverlay: settingsBoolLike(),
  // Silently DROPPED when it doesn't match, never refused — and note there is
  // no `?? ''`, so String(null) is 'null' and String(7) is '7', both of which
  // match the slug pattern and are stored today. Returning undefined is how a
  // field opts out; the applier skips undefined.
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
  // The dash below is an EN DASH (U+2013), carried over verbatim from the
  // branch this replaces. Retyping it as a hyphen changes the operator's toast.
  retentionDays: settingsIntLike(
    { min: 0, max: 3650 },
    'archive.retentionDays must be 0 (keep forever) or 1–3650 days',
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
  // Number(), not parseInt — so '' / null / [] are 0 (a legal "no burst") and
  // '5abc' is refused. Bounds tested before the round; see the helper.
  bufferSeconds: settingsNumberPreRoundLike(
    STREAM_BUFFER_SECONDS_BOUNDS,
    `stream.bufferSeconds must be a number between ${STREAM_BUFFER_SECONDS_BOUNDS.min} and ${STREAM_BUFFER_SECONDS_BOUNDS.max}`,
  ),
  idleAfterMinutes: settingsIntLike(
    { min: 1, max: 1440 },
    'stream.idleAfterMinutes must be an integer between 1 and 1440',
  ),
});

export const weatherPatchSchema = settingsBlockOf({
  lat: settingsFloatLike({ min: -90, max: 90 }, 'weather.lat out of range'),
  lng: settingsFloatLike({ min: -180, max: 180 }, 'weather.lng out of range'),
  // Non-string or blank is IGNORED, not refused — the weather label can never
  // be blanked, and over-80 truncates rather than failing.
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

// Refuses over-length where load() truncates — the established strict/lenient
// split, not an oversight.
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

/**
 * Deliberately NOT settingsBoolLike(): this key's branch has always been the
 * strict `typeof !== 'boolean'` refusal, the same posture `requests`' booleans
 * take, and loosening it to `!!value` here would be a behaviour change smuggled
 * in with a conversion. A hand-edited settings.json is unaffected either way —
 * load() coerces a non-boolean to the default, so only a PATCH is refused.
 */
export const djSpeakClockSchema = z.boolean({
  error: 'djSpeakClock must be a boolean',
});

/**
 * Trim FIRST, then a strict pair — ' en-GB ' saves, 'en-gb' does not.
 *
 * Not settingsStrictOneOf: that tests the raw value, which is right for
 * weather.units / loudness.source / search.provider (all raw `includes` today)
 * and wrong here, where the branch coerces and trims before comparing.
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
  // Number() with NO floor — a fractional GB budget is stored as a float today,
  // and load() doesn't floor it either.
  stemCacheGb: settingsNumberLike(
    { min: 1, max: 1000 },
    'audio.stemCacheGb must be between 1 and 1000',
  ),
  analyzeQuietMinutes: settingsNumberFloorLike(
    { min: 1, max: 120 },
    'audio.analyzeQuietMinutes must be between 1 and 120',
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
  // The one field here that TYPE-CHECKS instead of coercing. A number or null
  // is refused, where scrobble.listenbrainz.baseUrl (same shape, same message
  // tail) stringifies it. Do not unify them.
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

export const scrobblePatchSchema = settingsBlockOf({
  lastfm: scrobbleLastfmSchema,
  listenbrainz: scrobbleListenbrainzSchema,
});

/**
 * `''` = Auto (container TZ). Anything else must be a zone ICU knows.
 *
 * A try/catch probe rather than `Intl.supportedValuesOf`, so ALIASES validate
 * too (Europe/Kiev, US/Pacific, and numeric offsets like +05:30). It is also
 * case-insensitive, and the accepted string is stored verbatim rather than
 * canonicalised. `Intl` exists in the browser, so this mirrors cleanly;
 * time.ts re-exports it rather than keeping a second copy.
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
        // The dash is an EM DASH (U+2014), carried over verbatim.
        message: `invalid timezone "${v}" — use an IANA name like Europe/Athens`,
      });
    }
  })
  .transform((raw) => String(raw ?? '').trim());

/**
 * The privacy block's FIELD rules. The lock-needs-a-password invariant is NOT
 * here and cannot be: it reads the MERGED state (a lock may be turned on by
 * this patch while the password comes from what is already stored), so it is a
 * property of the result rather than of the submitted value. It stays in
 * update(), which is also where the listenerAuth restart decision lives.
 *
 * `publishPersonaSouls` is deliberately outside that invariant — it is a
 * disclosure toggle, not a lock.
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
      // The password travels in basic-auth userinfo and ?auth= query strings;
      // whitespace/control chars only cause client-side grief there. trim()
      // has already stripped the ends, so this only fires on INTERIOR space.
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
 * schema's job is to decide "usable or absent" and let update() spread the
 * result over what is stored.
 *
 * The usability rule is `intIn`'s and it is deliberately narrow: only a number,
 * a bigint or a NON-BLANK string counts. `null`, `''`, `false` and `[]` all
 * coerce to 0 under `Number()`, and without this guard an emptied admin input
 * (which arrives as JSON null) clamped to the field's FLOOR and silently
 * committed it — clearing the station hourly cap set it to 5/hour and closed
 * the request line. Anything unusable is dropped here, which update() reads as
 * "leave it alone".
 *
 * Note the booleans are `typeof === 'boolean'`, NOT `!!` — a truthy non-boolean
 * is IGNORED rather than coerced, the opposite posture to ui/privacy. Both are
 * shipping behaviour and neither may be unified onto the other.
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

// --- the mood family -------------------------------------------------------

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
 * The context the three mood MAPS validate against.
 *
 * `moodNames` is nullable and null means "this caller cannot check that rule" —
 * the same convention ShowSchemaContext and ScheduleSchemaContext use. The
 * route passes null: the effective vocabulary depends on whether `moods` is in
 * the same patch and on what validating it produced, which is update()'s
 * ordering to know, not the middleware's. So the route checks SHAPE and
 * update() checks membership, one schema, two postures.
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
      // Duplicate detection runs on the NORMALISED name, so 'Chill' + 'chill'
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
 * A fixed-key mood map. Both maps are rebuilt over their own key set.
 *
 * `allowEmpty` is the one difference between the two and it is NOT cosmetic:
 * moodSchedule requires every one of its 8 periods (an omitted period coerces
 * to '' and refuses), while weatherMoods treats '' as "no mood steer" — so a
 * weatherMoods patch naming one condition silently BLANKS the other five and
 * answers 200. Both behaviours are preserved exactly as they are.
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

// Festival field bounds. Named rather than left as literals inside the schema
// because the admin editor needs the same numbers for its maxLength / min / max
// attributes, and it was hard-coding them — the drift that had already bitten
// the persona editor.
export const SETTINGS_FESTIVAL_NAME_MAX = 80;
export const SETTINGS_FESTIVAL_DESCRIPTION_MAX = 200;
// Days either side of the date on which the festival's mood applies. The
// ceiling is deliberately low: past a fortnight a "festival window" is just a
// season, which is what moodSchedule is for.
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
        // Feb allows 29 — in a common year a leap-day festival fires Mar 1
        // (Date.UTC rolls the date over in getFestivalContext). The day bound
        // is indexed off the month, so it must stay downstream of a valid one.
        // The `?? 31` is unreachable (month is already 1-12) but the WEB build
        // typechecks the mirror under noUncheckedIndexedAccess, where a bare
        // index is `number | undefined`.
        const daysInMonth = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 31;
        const day = Number(f.day);
        if (!Number.isInteger(day) || day < 1 || day > daysInMonth) {
          add(
            `festivals[${i}].day must be an integer 1-${daysInMonth} for month ${month}`,
            'day',
          );
          return;
        }
        const mood = String(f.mood ?? '').trim();
        // '' is NOT allowed — every festival must name a mood, so the empty
        // string simply fails the set membership.
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


// ── theme ────────────────────────────────────────────────────────────────────

/**
 * `theme` — only `active` is a settings value; everything else in the block is
 * derived at serve time.
 *
 * A NON-OBJECT block is a silent no-op (`patch.theme || {}`), so it is coerced
 * rather than refused — the settingsBlockOf posture. And `active` is optional
 * BECAUSE the branch acts only `if (t.active !== undefined)`: a patch of
 * `{theme: {}}` has always been a legal no-op.
 *
 * What stays in update(): the "is this a theme id that actually exists" check.
 * It is async (the registry reads the themes dir) and it FALLS BACK to the
 * built-in default rather than refusing (#917 — throwing there aborted the whole
 * restore for any install whose active theme id had since been retired), which
 * is a repair only the server can make.
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

// ── maxTrackSeconds ──────────────────────────────────────────────────────────

/**
 * The station-wide track-length cap. 0 = unlimited.
 *
 * BOUNDS ONLY. The crossfade-derived FLOOR ("a non-zero cap must leave solo
 * airtime") stays in update(), for the reason ShowSchemaContext's
 * `minTrackSeconds: null` documents: the floor is a function of the crossfade,
 * which the SAME patch may be changing, so only update() — which applies the
 * crossfade first — can judge it.
 *
 * The legacy `maxTrackMinutes` alias is deliberately NOT registered beside this.
 * One branch serves both keys through `rawMaxTrackSec`, whose precedence rule is
 * "seconds wins whenever it is present and non-empty" — so when both ride along,
 * an unusable minutes value is IGNORED today, and a schema on that key would
 * refuse a body that currently saves. An empty/absent seconds value passes here
 * for the same reason: precedence hands off to minutes, and update() is still
 * the authoritative chokepoint for whatever it resolves.
 */
export function maxTrackSecondsValueSchema(bounds: SettingsNumericBound) {
  return settingsIntLike(
    bounds,
    `maxTrackSeconds must be int in [${bounds.min}, ${bounds.max}]`,
  );
}

/**
 * The REGISTRY entry — the same rule, one posture looser.
 *
 * `rawMaxTrackSec`'s precedence is "seconds wins whenever it is present and
 * non-empty", so an absent or empty `maxTrackSeconds` beside a `maxTrackMinutes`
 * is a legal body that hands off rather than a failure. update() validates the
 * RESOLVED value with maxTrackSecondsValueSchema above, which is why the bound
 * itself is written once.
 *
 * The legacy `maxTrackMinutes` alias is deliberately NOT registered: when both
 * ride along, an unusable minutes value is IGNORED today, and a schema on that
 * key would refuse a body that currently saves.
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

// ── the DJ prompt selection ──────────────────────────────────────────────────

/**
 * `activeDjPromptId` — '' selects the built-in default, otherwise the id of a
 * djPrompts entry.
 *
 * Coercion ONLY: `String(x ?? '').trim()` is the whole of what the branch does
 * to this value. Whether the id resolves is a cross-key question answered after
 * `djPrompts` has been applied, and it stays in update() — the same patch may be
 * replacing the library the id has to name.
 */
export const activeDjPromptIdSchema = z
  .unknown()
  .optional()
  .transform((raw) => String(raw ?? '').trim());

/**
 * `djPrompt` — the legacy single-field prompt (onboarding, older clients).
 *
 * Its two rules are pure and convert; what stays in update() is the MAPPING onto
 * the library — '' selects the default, and custom text reuses the entry with
 * identical text or appends a new "Custom prompt" — which reads and writes
 * `next.djPrompts` and can hit the library cap.
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
