import { createElement } from 'react';
import { toast } from 'sonner';

export interface NotifyChoice {
  label: string;
  onClick: () => void;
}

const CHOICE_BUTTON =
  'v3-eyebrow v3-focus cursor-pointer border border-ink bg-transparent px-2.5 py-1 text-[10px] text-ink';
let choiceToasts = 0;

export const notify = {
  ok: (message: string) => toast.success(message),
  err: (message: string) => toast.error(message, { duration: 6000 }),
  info: (message: string) => toast(message),
  // 10s: long enough to read the message and reach the button. 'err' is a
  // partial failure whose landed half can still be undone.
  undo: (message: string, onUndo: () => void, tone: 'ok' | 'err' = 'ok') => {
    const options = { duration: 10_000, action: { label: 'Undo', onClick: onUndo } };
    return tone === 'err' ? toast.error(message, options) : toast.success(message, options);
  },
  // A success with follow-ups, each a real button. Sonner draws one action
  // from `{ label, onClick }`, so the row rides its action slot as an element.
  // A pick closes the toast. 10s, like Undo.
  choices: (message: string, description: string, choices: NotifyChoice[]) => {
    const id = `notify-choices-${++choiceToasts}`;
    const row = createElement(
      'span',
      { className: 'mt-2.5 flex flex-wrap gap-2' },
      choices.map(c =>
        createElement(
          'button',
          {
            key: c.label,
            type: 'button',
            className: CHOICE_BUTTON,
            onClick: () => {
              toast.dismiss(id);
              c.onClick();
            },
          },
          c.label,
        ),
      ),
    );
    return toast.success(message, { id, description, duration: 10_000, action: row });
  },
  busy: (message: string): string | number =>
    toast.loading(message, { duration: Infinity }),
  dismiss: (id: string | number) => toast.dismiss(id),
};

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
