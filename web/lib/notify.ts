import { toast } from 'sonner';


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
