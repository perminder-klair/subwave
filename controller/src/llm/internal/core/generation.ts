// Non-streaming provider generation lifecycle. Counts are client observations in
// this process, never provider queue depth or a promise of remote slot release.
import { randomUUID } from 'node:crypto';
import { wrapLanguageModel, type LanguageModel } from 'ai';

export interface GenerationMetadata {
  kind: string;
  leg: 'primary' | 'fallback';
  provider: string;
  modelLabel: string;
  targetId: string;
  timeoutMs: number;
}
interface ActiveGeneration extends GenerationMetadata {
  requestId: string;
  startedAt: string;
  startedMono: number;
}
interface TimeoutEvidence {
  requestId: string;
  at: string;
  mono: number;
  timeoutMs: number;
}
interface TargetEvidence {
  provider: string;
  timeout?: TimeoutEvidence;
}

export class ProviderRequestTimeoutError extends Error {
  readonly code = 'PROVIDER_REQUEST_TIMEOUT';
  constructor(readonly requestId: string, readonly metadata: GenerationMetadata) {
    super(`Provider generation exceeded ${metadata.timeoutMs}ms (${metadata.provider}, ${metadata.leg}, ${requestId})`);
    this.name = 'ProviderRequestTimeoutError';
  }
}
export class GenerationCancelledError extends Error {
  readonly code = 'GENERATION_CANCELLED';
  constructor(reason: unknown) {
    super('Generation cancelled by caller', { cause: reason });
    this.name = 'GenerationCancelledError';
  }
}
export function cancellationError(signal: AbortSignal): Error {
  // Agent budgets remain a distinct control error, not a provider failure.
  if (signal.reason instanceof Error && signal.reason.name === 'AgentDeadlineError') return signal.reason;
  return new GenerationCancelledError(signal.reason);
}
export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancellationError(signal);
}

const TIMEOUT_RETENTION_MS = 300_000;
const MAX_RETAINED_TARGETS = 128;

// Injecting time is solely a test seam. Production always uses monotonic age.
export function createGenerationLifecycle(now = () => performance.now(), wallNow = () => Date.now()) {
  const active = new Map<string, ActiveGeneration>();
  const evidence = new Map<string, TargetEvidence>();
  function retain(targetId: string, value: TargetEvidence) {
    evidence.delete(targetId);
    evidence.set(targetId, value);
    while (evidence.size > MAX_RETAINED_TARGETS) evidence.delete(evidence.keys().next().value!);
  }
  function snapshot() {
    const mono = now();
    for (const [id, value] of evidence) {
      if (!value.timeout || mono - value.timeout.mono >= TIMEOUT_RETENTION_MS) evidence.delete(id);
    }
    const requests = [...active.values()].map(({ startedMono, ...row }) => ({
      ...row,
      ageMs: Math.max(0, mono - startedMono),
      staleAfterMs: Math.floor(0.8 * row.timeoutMs),
    }));
    const targets = [...new Set([...requests.map((r) => r.targetId), ...evidence.keys()])].map((targetId) => {
      const rows = requests.filter((r) => r.targetId === targetId);
      const oldest = rows.reduce<typeof rows[number] | undefined>((a, b) => !a || b.ageMs > a.ageMs ? b : a, undefined);
      const timeout = evidence.get(targetId)?.timeout;
      return {
        targetId,
        provider: oldest?.provider ?? evidence.get(targetId)!.provider,
        inFlightCount: rows.length,
        oldestInFlightAgeMs: oldest?.ageMs ?? null,
        oldestStartedAt: oldest?.startedAt ?? null,
        requestTimeoutMs: oldest?.timeoutMs ?? timeout?.timeoutMs ?? null,
        staleAfterMs: oldest?.staleAfterMs ?? (timeout ? Math.floor(0.8 * timeout.timeoutMs) : null),
        status: rows.some((r) => r.ageMs >= r.staleAfterMs) || timeout ? 'fail' : rows.length ? 'ok' : 'idle',
        recentTimeout: timeout ? { requestId: timeout.requestId, at: timeout.at, timeoutMs: timeout.timeoutMs } : null,
      };
    });
    return {
      scope: 'process-local client-observed generations (not provider queue depth)',
      status: targets.some((t) => t.status === 'fail') ? 'fail' : requests.length ? 'ok' : 'idle',
      inFlightCount: requests.length,
      oldestInFlightAgeMs: requests.length ? Math.max(...requests.map((r) => r.ageMs)) : null,
      targets,
      requests,
    };
  }
  function guard(model: LanguageModel, metadata: GenerationMetadata) {
    if (typeof model === 'string') throw new Error('Generation guard requires a resolved model');
    return wrapLanguageModel({
      model,
      middleware: {
        specificationVersion: 'v4',
        wrapGenerate: async ({ model: adapter, params }) => {
          const parent = params.abortSignal;
          throwIfCancelled(parent);
          const row: ActiveGeneration = { ...metadata, requestId: randomUUID(), startedAt: new Date(wallNow()).toISOString(), startedMono: now() };
          const controller = new AbortController();
          let timer: ReturnType<typeof setTimeout> | undefined;
          let onAbort: (() => void) | undefined;
          let abandoned = false;
          active.set(row.requestId, row);
          const stop = new Promise<never>((_, reject) => {
            function abandon(error: Error) {
              if (abandoned) return;
              abandoned = true;
              // Publish the winning error before transports synchronously react.
              reject(error);
              controller.abort(error);
            }
            onAbort = () => abandon(cancellationError(parent!));
            parent?.addEventListener('abort', onAbort, { once: true });
            timer = setTimeout(() => {
              if (abandoned) return;
              const error = new ProviderRequestTimeoutError(row.requestId, metadata);
              retain(row.targetId, { provider: row.provider, timeout: { requestId: row.requestId, at: new Date(wallNow()).toISOString(), mono: now(), timeoutMs: row.timeoutMs } });
              console.warn('[llm] provider-request-timeout', { requestId: row.requestId, ...metadata, remoteSlotReleaseGuaranteed: false });
              abandon(error);
            }, metadata.timeoutMs);
          });
          try {
            // Race covers body consumption as well as headers. Late adapter
            // results/rejections are consumed, never returned to the SDK/tool loop.
            const result = await Promise.race([stop, Promise.resolve().then(() => {
              throwIfCancelled(parent);
              return adapter.doGenerate({ ...params, abortSignal: controller.signal });
            })]);
            const lastTimeout = evidence.get(row.targetId)?.timeout;
            if (!lastTimeout || row.startedMono >= lastTimeout.mono) evidence.delete(row.targetId);
            return result;
          } finally {
            clearTimeout(timer);
            if (onAbort) parent?.removeEventListener('abort', onAbort);
            active.delete(row.requestId);
          }
        },
      },
    });
  }
  return { guard, snapshot };
}
const lifecycle = createGenerationLifecycle();
export const guardGenerationModel = lifecycle.guard;
export const generationHealthSnapshot = lifecycle.snapshot;
