'use client';

import type { ReactNode } from 'react';
import { V3Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

/* Shared error state for the admin console. One look for the "a fetch failed"
   panel, standardized on V3Alert (tone="error") with an optional Retry — the
   same shape the admin error boundary (app/admin/error.tsx) already uses.
   Replaces the three competing patterns the panels grew: the bare
   `<div class="text-[var(--danger)]">controller error: {err}</div>`, the
   accent `<p>{err}</p>`, and the assorted hand-rolled V3Alert callouts.

   `error` is the raw controller message (rendered quietly under the body);
   `onRetry` re-runs the panel's own fetch (panels own their retry logic). */
export interface ErrorStateProps {
  /** Callout heading. Defaults to the controller-unreachable framing. */
  title?: ReactNode;
  /** Human explanation; a sensible default is shown when omitted. */
  children?: ReactNode;
  /** The raw error string/message from the controller, shown de-emphasised. */
  error?: ReactNode;
  onRetry?: () => void;
  retrying?: boolean;
  retryLabel?: string;
}

export function ErrorState({
  title = "Can't reach the controller",
  children,
  error,
  onRetry,
  retrying,
  retryLabel = 'Retry',
}: ErrorStateProps) {
  return (
    <div className="grid gap-3">
      <V3Alert tone="error" title={title}>
        {children ?? (
          <p>
            Something went wrong talking to the controller. It may be restarting — give it a
            moment and retry.
          </p>
        )}
        {error ? <p className="mt-2 break-words opacity-80">{error}</p> : null}
      </V3Alert>
      {onRetry && (
        <div>
          <Button variant="accent" size="sm" onClick={onRetry} disabled={retrying}>
            {retrying ? 'Retrying…' : retryLabel}
          </Button>
        </div>
      )}
    </div>
  );
}
