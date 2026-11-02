import type { FormState, CloudTtsCfg } from './shared';

export function rebaselineSavedPatch(
  baseline: FormState,
  current: FormState,
  patch: Record<string, unknown>,
): FormState {
  const next = JSON.parse(JSON.stringify(baseline)) as FormState;
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
  const adopt = (
    target: Record<string, unknown>,
    source: Record<string, unknown>,
    shape: Record<string, unknown>,
  ) => {
    for (const [key, value] of Object.entries(shape)) {
      if (!(key in source)) continue;
      if (isRecord(value) && isRecord(target[key]) && isRecord(source[key])) {
        adopt(target[key], source[key], value);
      } else {
        target[key] = source[key];
      }
    }
  };

  const nextRecord = next as unknown as Record<string, unknown>;
  const currentRecord = current as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'audio' && isRecord(value)) {
      adopt(
        next.transitions as unknown as Record<string, unknown>,
        current.transitions as unknown as Record<string, unknown>,
        value,
      );
      continue;
    }
    if (key === 'tts' && isRecord(value)) {
      adopt(
        next.tts as unknown as Record<string, unknown>,
        current.tts as unknown as Record<string, unknown>,
        value,
      );
      if (isRecord(value.kokoro) && 'lang' in value.kokoro) {
        next.kokoroLang = current.kokoroLang;
      }
      continue;
    }
    adopt(nextRecord, currentRecord, { [key]: value });
  }
  return next;
}

type CloudFields = Pick<CloudTtsCfg, 'provider' | 'model' | 'voice'>;
type CloudForm = { tts: { cloud: CloudFields } };

export interface CloudSaveSnapshot {
  submitted: CloudFields;
  provider: string;
  retained: Array<'model' | 'voice'>;
}

/** Capture omitted blanks before the request starts, including its provider. */
export function cloudSaveSnapshot(
  form: CloudForm,
  patch: Record<string, unknown>,
): CloudSaveSnapshot | null {
  const tts = patch.tts as { cloud?: Partial<CloudFields> } | undefined;
  const cloud = tts?.cloud;
  if (typeof cloud?.provider !== 'string') return null;
  return {
    submitted: {
      provider: form.tts.cloud.provider,
      model: form.tts.cloud.model,
      voice: form.tts.cloud.voice,
    },
    provider: cloud.provider,
    retained: (['model', 'voice'] as const).filter(
      field => cloud[field] === undefined && !form.tts.cloud[field].trim(),
    ),
  };
}

export interface PendingCloudSave {
  snapshot: CloudSaveSnapshot;
  refreshedAt?: number;
  refreshAfter: number;
}

/** A committed settings write waiting for a read that reflects it. */
export interface PendingCommittedRead {
  /** Revision of the write's own authoritative GET, absent when it failed. */
  refreshedAt?: number;
  /** When the write committed: without `refreshedAt`, only a later poll counts. */
  refreshAfter: number;
}

/** Has `revision` read the committed write? A failed post-write GET leaves the
 *  cached envelope at revision zero, and a poll that began before the write
 *  cannot reflect it. */
export function committedReadReady(write: PendingCommittedRead, revision: number): boolean {
  return revision > 0 && (write.refreshedAt !== undefined
    ? revision >= write.refreshedAt
    : revision > write.refreshAfter);
}

/** A failed post-save GET leaves the cached envelope at revision zero. */
export function cloudSaveReadReady(save: PendingCloudSave, revision: number): boolean {
  return committedReadReady(save, revision);
}

/**
 * The top-level FormState keys POST /settings/llm/swap writes under: both LLM
 * legs, and the embedding fields it pins when the Library tagger was
 * inheriting the primary.
 */
export const LLM_SWAP_FORM_KEYS = ['llm', 'embedding'] as const;

/**
 * Adopt a write the SERVER made (the LLM swap) under the top-level `keys`, from
 * its authoritative read, without waiting for the whole form to be clean.
 *
 * The hydration effect holds every new revision back while ANY section is
 * dirty, so a write the browser did not compose would otherwise leave those
 * paths showing their pre-write values — and the next ordinary save of that
 * section would post them straight back over the write. The baseline takes the
 * server's values outright; the form takes them leaf by leaf wherever the
 * operator had not edited the leaf, so an edit made while the write was in
 * flight stays (and stays dirty). An array is one control, as countLeafDiffs
 * treats it.
 */
export function adoptServerPaths(
  baseline: FormState,
  current: FormState,
  server: FormState,
  keys: readonly string[],
): { baseline: FormState; form: FormState } {
  const nextBaseline = JSON.parse(JSON.stringify(baseline)) as Record<string, unknown>;
  const nextForm = JSON.parse(JSON.stringify(current)) as Record<string, unknown>;
  const base = baseline as unknown as Record<string, unknown>;
  const srv = server as unknown as Record<string, unknown>;
  for (const key of keys) {
    nextBaseline[key] = clone(srv[key]);
    const merged = keepEdits(base[key], nextForm[key], srv[key]);
    if (merged === undefined) delete nextForm[key];
    else nextForm[key] = merged;
  }
  return { baseline: nextBaseline as unknown as FormState, form: nextForm as unknown as FormState };
}

const isPlain = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)) as T);

/** `server` wherever `current` still equals `base`; the operator's value elsewhere. */
function keepEdits(base: unknown, current: unknown, server: unknown): unknown {
  if (sameJson(current, base)) return clone(server);
  if (isPlain(base) && isPlain(current) && isPlain(server)) {
    const out: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(current), ...Object.keys(server)])) {
      const v = keepEdits(base[key], current[key], server[key]);
      if (v !== undefined) out[key] = v;
    }
    return out;
  }
  return current;
}

/** Reconcile a committed cloud save with the redacted authoritative read. */
export function reconcileSavedCloud<T extends CloudForm>(
  baseline: T,
  form: T,
  snapshot: CloudSaveSnapshot,
  saved: CloudFields,
): { baseline: T; form: T } {
  if (saved.provider !== snapshot.provider) return { baseline, form };

  const fields = ['provider', ...snapshot.retained] as const;
  const baselineCloud = { ...baseline.tts.cloud };
  const formCloud = { ...form.tts.cloud };
  const sameProvider = formCloud.provider === snapshot.submitted.provider;
  for (const field of fields) {
    baselineCloud[field] = saved[field];
    // Preserve changes made while the POST/GET was in flight, including a
    // provider switch whose new blank fields belong to a different engine.
    if (sameProvider && formCloud[field] === snapshot.submitted[field]) {
      formCloud[field] = saved[field];
    }
  }
  return {
    baseline: { ...baseline, tts: { ...baseline.tts, cloud: baselineCloud } },
    form: { ...form, tts: { ...form.tts, cloud: formCloud } },
  };
}
