'use client';

import { V3AlertDialog } from '../../ui/alert-dialog';

const guide = 'https://github.com/perminder-klair/subwave/discussions/1817';
const guideSuffix = `\n\nHow to give your DJ Musical Leanings: ${guide}`;

export function ShowGenerationNotice({ message }: { message: string }) {
  const hasGuide = message.endsWith(guideSuffix);
  return <div className="space-y-2 text-[12px] text-muted">
    <p className="whitespace-pre-line">{hasGuide ? message.slice(0, -guideSuffix.length) : message}</p>
    {hasGuide && <a href={guide} target="_blank" rel="noopener noreferrer" className="inline-block underline hover:text-ink">
      How to give your DJ Musical Leanings ↗
    </a>}
  </div>;
}

/** Generation advice stays open until dismissed; it must not expire like a toast. */
export function ShowGenerationDialog({ message, onDismiss }: { message: string | null; onDismiss: () => void }) {
  return <V3AlertDialog
    open={message !== null}
    onOpenChange={open => { if (!open) onDismiss(); }}
    title="Sub/Show needs attention"
    description="Review the details below before trying again."
    details={message && <div className="mt-3 max-h-[50dvh] overflow-y-auto break-words">
      <ShowGenerationNotice message={message} />
    </div>}
    cancelLabel={null}
    confirmLabel="Dismiss"
    onConfirm={onDismiss}
  />;
}
