// Free-form extra body fields for the `openai-compatible` cloud TTS provider
// (#1317), merged into the POST to /audio/speech. Only that provider reads
// them. ONE place for the rule: the save-time validator and the send path in
// llm/internal/speech/cloud-speech.ts both consume it, so a key that saves
// always sends.

export type CompatParam = { key: string; value: string };

export const COMPAT_PARAM_MAX_ENTRIES = 20;
export const COMPAT_PARAM_KEY_MAX = 60;
export const COMPAT_PARAM_VALUE_MAX = 400;

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
export function validateCompatParams(input: unknown): CompatParam[] {
  if (input === null || input === undefined) return [];
  if (!Array.isArray(input)) {
    throw new Error('tts.cloud.compatParams must be an array of {key, value}');
  }
  const out: CompatParam[] = [];
  const seen = new Set<string>();
  for (const row of input) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error('tts.cloud.compatParams entries must be objects with key and value');
    }
    const key = String((row as CompatParam).key ?? '').trim();
    const value = String((row as CompatParam).value ?? '').trim();
    if (!key && !value) continue; // untouched blank row
    if (!key) throw new Error('tts.cloud.compatParams entries need a parameter name');
    if (key.length > COMPAT_PARAM_KEY_MAX) {
      throw new Error(`tts.cloud.compatParams names must be 1-${COMPAT_PARAM_KEY_MAX} chars`);
    }
    // A body field that isn't a plain identifier is a typo far more often than
    // it is a real server contract.
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) {
      throw new Error(`tts.cloud.compatParams name "${key}" must start with a letter and use only letters, digits, _ . -`);
    }
    if (COMPAT_PARAM_RESERVED_KEYS.includes(key)) {
      throw new Error(`tts.cloud.compatParams cannot override "${key}" — SUB/WAVE sets it for every request`);
    }
    if (value.length > COMPAT_PARAM_VALUE_MAX) {
      throw new Error(`tts.cloud.compatParams values must be 0-${COMPAT_PARAM_VALUE_MAX} chars`);
    }
    if (seen.has(key)) {
      throw new Error(`tts.cloud.compatParams has a duplicate name "${key}"`);
    }
    seen.add(key);
    out.push({ key, value });
  }
  if (out.length > COMPAT_PARAM_MAX_ENTRIES) {
    throw new Error(`tts.cloud.compatParams is limited to ${COMPAT_PARAM_MAX_ENTRIES} entries`);
  }
  return out;
}

// The object merged into the outgoing /audio/speech body. Send path, so a
// malformed row is SKIPPED rather than thrown on — settings.json is
// hand-editable and a throw inside speak() costs the whole segment.
export function compatParamsBody(params: unknown): Record<string, unknown> {
  if (!Array.isArray(params)) return {};
  const body: Record<string, unknown> = {};
  for (const row of params.slice(0, COMPAT_PARAM_MAX_ENTRIES)) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const key = String((row as CompatParam).key ?? '').trim();
    if (!key || COMPAT_PARAM_RESERVED_KEYS.includes(key)) continue;
    body[key] = coerceCompatParamValue(String((row as CompatParam).value ?? ''));
  }
  return body;
}
