// Free-form extra body fields, as `{ key, value }` rows. Two readers:
//   • the `openai-compatible` cloud TTS provider (#1317), merged into the POST
//     to /audio/speech by llm/internal/speech/cloud-speech.ts;
//   • the openai-compatible / locca chat legs' `llm.bodyParams` and
//     `llm.toolCallBodyParams` (#2296), merged by the chat transport in
//     llm/internal/provider/registry.ts.
// ONE place for the rule: the save-time validator and each send path consume
// it, so a key that saves always sends. The row grammar and limits live in
// schemas/settings.ts so the admin form runs the same check before a save.

import {
  BODY_PARAM_KEY_RE,
  BODY_PARAM_MAX_ENTRIES,
  BODY_PARAM_KEY_MAX,
  BODY_PARAM_VALUE_MAX,
  LLM_BODY_PARAM_RESERVED_KEYS,
} from '../schemas/settings.js';

export type CompatParam = { key: string; value: string };

export const COMPAT_PARAM_MAX_ENTRIES = BODY_PARAM_MAX_ENTRIES;
export const COMPAT_PARAM_KEY_MAX = BODY_PARAM_KEY_MAX;
export const COMPAT_PARAM_VALUE_MAX = BODY_PARAM_VALUE_MAX;

// Body fields the station resolves itself, rejected at save time rather than
// dropped at send time. model/voice have their own settings fields, `input` is
// the script text, and `speed` would compound with the local ffmpeg atempo
// stretch these servers get instead of a server-side speed (#942).
export const COMPAT_PARAM_RESERVED_KEYS = ['model', 'input', 'voice', 'speed'];

// Stored values are text but servers want real JSON types, so a value that
// parses as a JSON literal is sent as one and anything else stays a string.
// `007` therefore stays a string, which is right for id-shaped values.
export function coerceCompatParamValue(raw: string): unknown {
  const v = String(raw ?? '').trim();
  if (v === '') return '';
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

// Validate + normalise. Throws rather than clamps: a bad param 422s the render
// and drops the show to a fallback voice. Blank rows are dropped — the UI
// appends one on "Add".
// `label` names the field in every message and `reserved` is the list of
// body fields that field may not override; the defaults are the TTS field's.
export function validateCompatParams(
  input: unknown,
  label = 'tts.cloud.compatParams',
  reserved: readonly string[] = COMPAT_PARAM_RESERVED_KEYS,
): CompatParam[] {
  if (input === null || input === undefined) return [];
  if (!Array.isArray(input)) {
    throw new Error(`${label} must be an array of {key, value}`);
  }
  const out: CompatParam[] = [];
  const seen = new Set<string>();
  for (const row of input) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`${label} entries must be objects with key and value`);
    }
    const key = String((row as CompatParam).key ?? '').trim();
    const value = String((row as CompatParam).value ?? '').trim();
    if (!key && !value) continue; // untouched blank row
    if (!key) throw new Error(`${label} entries need a parameter name`);
    if (key.length > COMPAT_PARAM_KEY_MAX) {
      throw new Error(`${label} names must be 1-${COMPAT_PARAM_KEY_MAX} chars`);
    }
    // A body field that isn't a plain identifier is a typo far more often than
    // it is a real server contract.
    if (!BODY_PARAM_KEY_RE.test(key)) {
      throw new Error(`${label} name "${key}" must start with a letter and use only letters, digits, _ . -`);
    }
    if (reserved.includes(key)) {
      throw new Error(`${label} cannot override "${key}" — SUB/WAVE sets it for every request`);
    }
    if (value.length > COMPAT_PARAM_VALUE_MAX) {
      throw new Error(`${label} values must be 0-${COMPAT_PARAM_VALUE_MAX} chars`);
    }
    if (seen.has(key)) {
      throw new Error(`${label} has a duplicate name "${key}"`);
    }
    seen.add(key);
    out.push({ key, value });
  }
  if (out.length > COMPAT_PARAM_MAX_ENTRIES) {
    throw new Error(`${label} is limited to ${COMPAT_PARAM_MAX_ENTRIES} entries`);
  }
  return out;
}

// The object merged into the outgoing /audio/speech body. Send path, so a
// malformed row is SKIPPED rather than thrown on — settings.json is
// hand-editable and a throw inside speak() costs the whole segment.
export function compatParamsBody(
  params: unknown,
  reserved: readonly string[] = COMPAT_PARAM_RESERVED_KEYS,
): Record<string, unknown> {
  if (!Array.isArray(params)) return {};
  const body: Record<string, unknown> = {};
  for (const row of params.slice(0, COMPAT_PARAM_MAX_ENTRIES)) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const key = String((row as CompatParam).key ?? '').trim();
    if (!key || reserved.includes(key)) continue;
    body[key] = coerceCompatParamValue(String((row as CompatParam).value ?? ''));
  }
  return body;
}

// ── Chat legs (#2296) ────────────────────────────────────────────────────────
// `llm.bodyParams` ("Request parameters") go on every call of an
// openai-compatible / locca leg. `llm.toolCallBodyParams` ("Structured &
// tool-call overrides") are laid over them, key by key, only on the leg's
// no-think client: the one every forced-tool and structured-output call uses.
// A thinking switch goes in the first list and its off-switch in the second,
// so the code never needs to know any server's spelling of "thinking".

// Save path for either list: strict, throws a plain Error naming the field.
export function validateLlmBodyParams(input: unknown, label: string): CompatParam[] {
  return validateCompatParams(input, label, LLM_BODY_PARAM_RESERVED_KEYS);
}

// Load path: lenient like tts.cloud.compatParams — a hand-edited list that no
// longer validates loads as none rather than wedging boot.
export function normalizeLlmBodyParams(raw: unknown, label: string): CompatParam[] {
  try {
    return validateLlmBodyParams(raw, label);
  } catch {
    return [];
  }
}

// The fields a chat request gets on top of the SDK's own body. Without
// `overrides` it is the request list alone (the leg's normal client). With
// them (the no-think client), each override row replaces the request row of
// the same name, and an override whose value is JSON `null` removes that key
// instead, so a budget or switch can be dropped from forced calls without
// restating the rest. Reserved keys are skipped here too: settings.json is
// hand-editable.
export function llmBodyParamsBody(bodyParams: unknown, overrides?: unknown): Record<string, unknown> {
  const body = compatParamsBody(bodyParams, LLM_BODY_PARAM_RESERVED_KEYS);
  if (overrides === undefined) return body;
  for (const [key, value] of Object.entries(llmToolCallOverrides(overrides))) {
    if (value === null) delete body[key];
    else body[key] = value;
  }
  return body;
}

// The override rows as fields, a `null` (a removal) kept as null.
export function llmToolCallOverrides(overrides: unknown): Record<string, unknown> {
  return compatParamsBody(overrides, LLM_BODY_PARAM_RESERVED_KEYS);
}
