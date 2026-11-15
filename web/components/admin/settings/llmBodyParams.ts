// Extra request-body fields for an OpenAI-compatible / locca LLM leg (#2296):
// `llm.bodyParams` ("Request parameters", every call) and
// `llm.toolCallBodyParams` ("Structured & tool-call overrides", laid over the
// first list on forced-tool and structured calls only; a `null` value removes
// a key there). The controller owns the rule (settings/compat-params.ts); the
// row grammar and reserved names come from the generated schema mirror, so the
// editor flags exactly what a save would refuse.
//
// Pure: the editor, the preset button and the save payload all go through
// here, so the tests can pin them without rendering the section.

import {
  BODY_PARAM_KEY_RE,
  BODY_PARAM_KEY_MAX,
  BODY_PARAM_VALUE_MAX,
  BODY_PARAM_MAX_ENTRIES,
  LLM_BODY_PARAM_RESERVED_KEYS,
} from '../../../lib/schemas.generated';
import type { FormState } from './shared';

export interface LlmBodyParamRow {
  key: string;
  value: string;
}

export const LLM_BODY_PARAMS_MAX = BODY_PARAM_MAX_ENTRIES;

export type LlmBodyParamList = 'bodyParams' | 'toolCallBodyParams';
export type LlmLegId = 'primary' | 'fallback';

/**
 * "Fill for…" presets. Only ones a real server was tested with: the reporter
 * of #2296 confirmed on Hetzner Inference (Qwen/Qwen3.6-35B-A3B-FP8) that a
 * top-level `enable_thinking: false` brings reasoning tokens to 0, and the
 * same field is what vLLM-style Qwen3 servers read. A preset only fills the
 * editor; nothing is stored until the operator saves.
 */
export const LLM_BODY_PARAM_PRESETS = [
  {
    id: 'hetzner-qwen',
    label: 'Hetzner / vLLM-style Qwen',
    list: 'bodyParams' as LlmBodyParamList,
    rows: [{ key: 'enable_thinking', value: 'false' }] as readonly LlmBodyParamRow[],
  },
] as const;

export type LlmBodyParamPresetId = (typeof LLM_BODY_PARAM_PRESETS)[number]['id'];

/** Stored list → editor rows. Anything malformed is dropped, as on load. */
export function bodyParamRows(raw: unknown): LlmBodyParamRow[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is { key?: unknown; value?: unknown } => !!r && typeof r === 'object' && !Array.isArray(r))
    .map(r => ({ key: String(r.key ?? ''), value: String(r.value ?? '') }));
}

/** Editor rows → the list POSTed. Untouched blank rows are not sent. */
export function bodyParamsPayload(rows: readonly LlmBodyParamRow[]): LlmBodyParamRow[] {
  return rows
    .map(r => ({ key: (r.key || '').trim(), value: (r.value || '').trim() }))
    .filter(r => r.key || r.value);
}

/** What a save would refuse about this row, or '' when it is fine. */
export function bodyParamProblem(row: LlmBodyParamRow, rows: readonly LlmBodyParamRow[]): string {
  const key = (row.key || '').trim();
  const value = (row.value || '').trim();
  if (!key && !value) return '';
  if (!key) return 'Name the field';
  if (key.length > BODY_PARAM_KEY_MAX) return `Names must be ${BODY_PARAM_KEY_MAX} chars or fewer`;
  if (!BODY_PARAM_KEY_RE.test(key)) return 'Start with a letter; letters, digits and _ . - only';
  if (LLM_BODY_PARAM_RESERVED_KEYS.includes(key)) return `SUB/WAVE sets "${key}" on every request`;
  if (value.length > BODY_PARAM_VALUE_MAX) return `Value must be ${BODY_PARAM_VALUE_MAX} chars or fewer`;
  if (rows.filter(r => (r.key || '').trim() === key).length > 1) return `"${key}" is listed twice`;
  return '';
}

/**
 * The preset's rows merged into a list: a row with the same name takes the
 * preset's value, anything else the operator has is kept, in order.
 */
export function withPresetRows(
  rows: readonly LlmBodyParamRow[],
  presetRows: readonly LlmBodyParamRow[],
): LlmBodyParamRow[] {
  const out = rows.map(r => ({ ...r }));
  for (const p of presetRows) {
    const at = out.findIndex(r => (r.key || '').trim() === p.key);
    if (at >= 0) out[at] = { key: p.key, value: p.value };
    else out.push({ key: p.key, value: p.value });
  }
  return out;
}

/**
 * The form updater a "Fill for…" button hands setForm. It edits the form
 * only: the saved baseline is untouched, so the save bar shows the change as
 * unsaved until the operator saves.
 */
export function fillBodyParamsPreset(leg: LlmLegId, presetId: LlmBodyParamPresetId) {
  const preset = LLM_BODY_PARAM_PRESETS.find(p => p.id === presetId);
  return (f: FormState): FormState => {
    if (!preset) return f;
    if (leg === 'primary') {
      return { ...f, llm: { ...f.llm, [preset.list]: withPresetRows(f.llm[preset.list], preset.rows) } };
    }
    return {
      ...f,
      llm: { ...f.llm, fallback: { ...f.llm.fallback, [preset.list]: withPresetRows(f.llm.fallback[preset.list], preset.rows) } },
    };
  };
}
