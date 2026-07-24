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

// Registers global keydown shortcuts on window. `handlers` maps a normalised
// key string ('space', 'arrowup', 't', '?', 'mod+k', …) to a callback.
//
// Bare-key shortcuts are suppressed while the user is typing in a field or
// while `disabled` is true; the command-palette chord (Cmd/Ctrl+K) always
// fires so the palette can be opened — and toggled shut — from anywhere.
//
// Handlers/disabled are read through refs so the window listener binds once
// and survives PlayerApp's per-second re-renders.
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
      // Ignore auto-repeat from a held key — a shortcut should fire once per
      // press, not stutter (a held Space would otherwise toggle tune in/out).
      if (e.repeat) return;

      // Another listener already claimed this press (several shortcut maps
      // coexist: the shell's cycling keys, the skin's map, a skin's any-key
      // tune-in gate). First consumer wins; one keypress never does two
      // things.
      if (e.defaultPrevented) return;

      // Modifier chords are handled first and are exempt from the typing guard —
      // a chord (Cmd/Ctrl+…) can't be produced by ordinary typing. Only the
      // command-palette chord (Cmd/Ctrl+K) is claimed; every other combo is left
      // to the browser (copy/paste/etc). Nothing past this block runs for a
      // modified keypress.
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

      // Bare keys ONLY reach here. Never fire while the user is typing in an
      // input/textarea/select/contenteditable, or while a palette/dialog owns
      // input via `disabled` — this guard precedes every bare-key comparison.
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
