'use client';

import { useEffect, useRef } from 'react';

const TEXT_INPUT_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

function isTextEntry(el: EventTarget | null): boolean {
  if (!el) return false;
  if (!(el instanceof HTMLElement)) return false;
  if (TEXT_INPUT_TAGS.has(el.tagName)) return true;
  return el.isContentEditable === true;
}

export type ShortcutHandler = (e: KeyboardEvent) => void;
export type ShortcutHandlers = Record<string, ShortcutHandler | undefined>;

export interface UseKeyboardShortcutsOptions {
  disabled?: boolean;
}

// Bare keys yield to text entry and disabled state. Cmd/Ctrl+K remains available to toggle the
// palette. Refs keep the window listener stable across renders.
export function useKeyboardShortcuts(
  handlers: ShortcutHandlers,
  { disabled = false }: UseKeyboardShortcutsOptions = {},
): void {
  const handlersRef = useRef<ShortcutHandlers>(handlers);
  handlersRef.current = handlers;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.repeat) return;

      // Respect earlier handlers so one keypress performs only one action.
      if (e.defaultPrevented) return;

      // Allow Cmd/Ctrl+K during text entry; leave other modified keys to the browser.
      if (e.metaKey || e.ctrlKey || e.altKey) {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
          const run = handlersRef.current['mod+k'];
          if (run) {
            e.preventDefault();
            run(e);
          }
        }
        return;
      }

      if (disabledRef.current || isTextEntry(e.target)) return;

      const key = e.key === ' ' ? 'space' : e.key.toLowerCase();
      const run = handlersRef.current[key];
      if (!run) return;
      e.preventDefault();
      run(e);
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
