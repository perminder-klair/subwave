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

/** A failed post-save GET leaves the cached envelope at revision zero. */
export function cloudSaveReadReady(save: PendingCloudSave, revision: number): boolean {
  return revision > 0 && (save.refreshedAt !== undefined
    ? revision >= save.refreshedAt
    : revision > save.refreshAfter);
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
