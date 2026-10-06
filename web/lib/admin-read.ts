export const ADMIN_READ_TIMEOUT_MS = 15_000;

export class AdminReadTimeoutError extends Error {
  constructor() {
    super('The controller took too long to respond. Check your connection and retry.');
    this.name = 'AdminReadTimeoutError';
  }
}

export async function runAdminRead<T>({ request, signal, timeoutMs = ADMIN_READ_TIMEOUT_MS }: {
  request: (signal: AbortSignal) => Promise<T>;
  signal: AbortSignal;
  timeoutMs?: number;
}): Promise<T> {
  signal.throwIfAborted();
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  signal.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new AdminReadTimeoutError()), timeoutMs);
  let rejectOnAbort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', rejectOnAbort, { once: true });
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return request(controller.signal);
      }),
      aborted,
    ]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', rejectOnAbort);
  }
}
