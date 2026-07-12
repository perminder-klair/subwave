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

      const mod = e.metaKey || e.ctrlKey;

      // Command palette chord — available even inside text fields.
      if (mod && e.key.toLowerCase() === 'k') {
        const run = handlersRef.current['mod+k'];
        if (run) {
          e.preventDefault();
          run(e);
        }
        return;
      }

      // Leave every other modifier combo to the browser (copy/paste/etc).
      if (mod || e.altKey) return;

      // Bare keys: never while typing, or while a palette/dialog owns input.
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
