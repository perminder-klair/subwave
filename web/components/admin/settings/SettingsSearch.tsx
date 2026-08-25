'use client';

// Search across every setting, so "crossfade" or "api key" reaches the control
// without the operator remembering which of twelve sections owns it.
//
// Built on the vendored cmdk primitives rather than the design's hand-rolled
// scorer: the fuzzy ranking, the arrow-key navigation and the focus trap are
// already there and already match the rest of the admin's palettes.
//
// The chord is `/`, NOT ⌘K — AdminShell already owns ⌘K for the admin-wide
// panel jump list, and shadowing it inside one panel would make the same
// keystroke mean two things depending on where you were.

import { useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import {
  CommandDialog, CommandEmpty, CommandInput, CommandItem, CommandList,
} from '../../ui/command';
import { Kbd } from '../../ui/kbd';
import { Pill } from '../ui';
import {
  SETTINGS_INDEX, sectionById, isAdvancedCard, type SectionId,
} from './registry';
import { cardAnchor } from '../ui';

export interface SettingsJump {
  section: SectionId;
  /** `data-card` slug to scroll to and flash. */
  anchor: string;
  /** Whether the target sits behind the section's Advanced disclosure. */
  advanced: boolean;
}

interface SettingsSearchProps {
  onJump: (jump: SettingsJump) => void;
}

/** Is the operator typing into something? `/` must not steal that keystroke. */
function isTyping(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function SettingsSearch({ onJump }: SettingsSearchProps) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== '/' || isTyping()) return;
      e.preventDefault();
      setOpen(true);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const pick = (index: number) => {
    const entry = SETTINGS_INDEX[index];
    if (!entry) return;
    setOpen(false);
    const anchor = cardAnchor(entry.card);
    onJump({
      section: entry.section,
      anchor,
      advanced: isAdvancedCard(entry.section, anchor),
    });
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full cursor-pointer items-stretch border border-ink bg-[var(--field)] text-left font-[inherit] transition-colors hover:bg-[var(--ink-soft)]"
      >
        <span className="inline-flex items-center border-r border-[var(--separator-strong)] px-2.5 text-muted">
          <Search className="size-3.5" strokeWidth={2} aria-hidden />
        </span>
        <span className="min-w-0 flex-1 truncate px-2.5 py-2 text-[13px] text-muted">
          Search settings — crossfade, api key, bitrate, timezone…
        </span>
        <span className="inline-flex items-center border-l border-[var(--separator-strong)] px-2.5">
          <Kbd>/</Kbd>
        </span>
      </button>

      <CommandDialog open={open} onOpenChange={setOpen} label="Search settings">
        <CommandInput placeholder="Search every setting…" />
        {/* Deliberately FLAT — no CommandGroup per section. cmdk sorts within a
            group and leaves group order as authored, so grouping buried the
            best match: typing "bitrate" put Station's "Seconds between
            requests" above every actual bitrate field, purely because Station
            is the first section. Flat lets one ranking cover all 100 rows, and
            each row carries its own section in the trail line anyway. */}
        <CommandList>
          <CommandEmpty>No matching settings.</CommandEmpty>
          {SETTINGS_INDEX.map((entry, index) => {
            const section = sectionById(entry.section);
            const anchor = cardAnchor(entry.card);
            return (
              <CommandItem
                key={index}
                // Labels repeat across cards ("Bitrate" three times in the
                // danger zone, "Provider" in four sections) and cmdk keys on
                // `value`, so the index disambiguates. Everything else that
                // should MATCH rides `keywords`, which cmdk scores below the
                // value — a hit on the field's own name outranks a hit on its
                // synonyms, which is the ordering the operator expects.
                value={`${entry.label} ${entry.card} #${index}`}
                keywords={[section?.label ?? '', entry.keywords ?? ''].filter(Boolean)}
                onSelect={() => pick(index)}
              >
                <span className="grid min-w-0 gap-0.5">
                  <span className="truncate text-[13px] font-semibold">{entry.label}</span>
                  <span className="truncate text-[10px] tracking-[0.14em] uppercase opacity-70">
                    {section?.label} · {entry.card}
                  </span>
                </span>
                {isAdvancedCard(entry.section, anchor) && (
                  <Pill className="shrink-0">adv</Pill>
                )}
              </CommandItem>
            );
          })}
        </CommandList>
      </CommandDialog>
    </>
  );
}
