import { toast } from 'sonner';

// Thin wrapper around Sonner so every transient notification goes through one
// call site. `busy` stays up until the caller dismisses it by the returned id;
// `undo` is `ok` plus an Undo button and a longer dwell, preferred over a
// confirm dialog. Not for persistent offline/load-failure states (inline
// V3Alert cards) or field-level validation errors (inline by the field).

export const notify = {
  ok: (message: string) => toast.success(message),
  err: (message: string) => toast.error(message, { duration: 6000 }),
  info: (message: string) => toast(message),
  // 10s: long enough to read the message and reach the button.
  undo: (message: string, onUndo: () => void) =>
    toast.success(message, { duration: 10_000, action: { label: 'Undo', onClick: onUndo } }),
  busy: (message: string): string | number =>
    toast.loading(message, { duration: Infinity }),
  dismiss: (id: string | number) => toast.dismiss(id),
};

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
