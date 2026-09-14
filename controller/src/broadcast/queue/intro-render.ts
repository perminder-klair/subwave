// Lifecycle for a queued track's optional intro/link pre-render.
//
// The drain may stop WAITING for TTS when its runway expires, but the render
// itself cannot be cancelled. Keep that one in-flight promise addressable so
// airIntro can reuse it instead of starting the same expensive job again.

export type IntroRenderResult =
  | { status: 'rendered'; wav: string }
  | { status: 'failed'; error: unknown };

export type IntroRenderWaitResult = IntroRenderResult | { status: 'timed-out' };

export class IntroRenderTracker<Item extends object> {
  private active = new WeakMap<Item, Promise<IntroRenderResult>>();

  private track(item: Item, pending: Promise<IntroRenderResult>): void {
    this.active.set(item, pending);
    void pending.then(() => {
      if (this.active.get(item) === pending) this.active.delete(item);
    });
  }

  start(item: Item, render: () => Promise<string>): Promise<IntroRenderResult> {
    const existing = this.active.get(item);
    if (existing) return existing;

    const pending: Promise<IntroRenderResult> = Promise.resolve()
      .then(render)
      .then(
        wav => ({ status: 'rendered' as const, wav }),
        error => ({ status: 'failed' as const, error }),
      );
    this.track(item, pending);
    return pending;
  }

  get(item: Item): Promise<IntroRenderResult> | null {
    return this.active.get(item) ?? null;
  }

  invalidate(item: Item): void {
    this.active.delete(item);
  }

  transfer(from: Item, to: Item): void {
    const pending = this.active.get(from);
    if (!pending) return;
    this.active.delete(from);
    this.track(to, pending);
  }
}

export async function awaitIntroRender(
  pending: Promise<IntroRenderResult>,
  budgetMs: number | null,
): Promise<IntroRenderWaitResult> {
  if (budgetMs == null) return pending;

  let timer: NodeJS.Timeout | undefined;
  const result = await Promise.race<IntroRenderWaitResult>([
    pending,
    new Promise<{ status: 'timed-out' }>(resolve => {
      timer = setTimeout(() => resolve({ status: 'timed-out' }), budgetMs);
    }),
  ]);
  clearTimeout(timer);
  return result;
}
