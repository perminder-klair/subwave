'use client';

import { cn } from '../../../lib/cn';

/** A connection test's answer, under its Test button. */
export function TestResultLine({ ok, text }: { ok: boolean; text: string }) {
  return (
    <div
      role="status"
      className={cn(
        'mt-2 max-w-[560px] border bg-[var(--ink-softer)] px-3 py-2 text-[11px] leading-[1.6] whitespace-pre-wrap',
        ok ? 'border-[var(--accent)] text-[color:var(--accent)]' : 'border-[var(--danger)] text-[var(--danger)]',
      )}
    >
      {ok ? '✓ ' : '✗ '}
      {text}
    </div>
  );
}
