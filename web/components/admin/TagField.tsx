'use client';

/* The tag editor, shared by the show and persona editors. The skills modal has
 * its own copy of this markup, styled with the modal's inline style objects.
 *
 * The rules are PASSED IN, not imported: SKILL_TAG_RE, SHOW_TAG_RE and
 * PERSONA_TAG_RE are three separate declarations of one pattern (a mirrored
 * schema module may import only zod), so hard-coding one would enforce the
 * wrong cap for the other callers the moment they diverge. */

import type { ChangeEvent } from 'react';
import { useState } from 'react';
import { cn } from '../../lib/cn';
import { Input } from '../ui/input';
import { Pill } from './ui';

export interface TagFieldProps {
  /** Current tags, already lowercase. */
  value: string[];
  onChange: (next: string[]) => void;
  /** Shape rule for one tag — the caller's own schema constant. */
  pattern: RegExp;
  /** Max tags, and max characters in one tag — the caller's own constants. */
  max: number;
  charMax: number;
  /** Tags already in use elsewhere in this list, offered as one-click adds. */
  suggestions?: string[];
  /** What a tag is being attached to, for the messages ("show", "DJ"). */
  noun: string;
  /** A malformed, uncommitted draft must reach the parent editor's save gate,
   *  or Save submits the old array and drops the draft. */
  onDraftBlockedChange?: (blocked: boolean) => void;
  disabled?: boolean;
  className?: string;
}

export function tagDraftBlocksSave(draft: string, pattern: RegExp): boolean {
  const tag = draft.trim().toLowerCase();
  return tag !== '' && !pattern.test(tag);
}

export function TagField({
  value, onChange, pattern, max, charMax, suggestions, noun,
  onDraftBlockedChange, disabled, className,
}: TagFieldProps) {
  const [draft, setDraft] = useState('');
  // Inline rather than a toast: the offending input is on screen.
  const [err, setErr] = useState<string | null>(null);

  const add = (raw: string) => {
    const tag = raw.trim().toLowerCase();
    if (!tag) { setErr(null); onDraftBlockedChange?.(false); return; }
    if (!pattern.test(tag)) {
      setErr(`“${tag}” isn’t a valid tag — lowercase letters, digits and hyphens, max ${charMax} characters`);
      onDraftBlockedChange?.(true);
      return;
    }
    // Re-typing an existing tag is a no-op, not an error.
    if (value.includes(tag)) {
      setDraft(''); setErr(null); onDraftBlockedChange?.(false); return;
    }
    if (value.length >= max) {
      setErr(`At most ${max} tags per ${noun}`);
      return;
    }
    onChange([...value, tag]);
    setDraft('');
    setErr(null);
    onDraftBlockedChange?.(false);
  };

  const unused = (suggestions || []).filter(t => !value.includes(t));

  return (
    <div className={cn('grid gap-2', className)}>
      <div className="flex flex-wrap items-center gap-2">
        {value.map(t => (
          <Pill
            key={t}
            tone="ink"
            title={`Remove tag “${t}”`}
            onClick={disabled ? undefined : () => onChange(value.filter(x => x !== t))}
          >
            #{t} <span aria-hidden>×</span>
          </Pill>
        ))}
        <Input
          className="w-40"
          type="text"
          maxLength={charMax}
          value={draft}
          disabled={disabled || value.length >= max}
          onChange={(e: ChangeEvent<HTMLInputElement>) => {
            const next = e.target.value;
            setDraft(next);
            setErr(null);
            onDraftBlockedChange?.(tagDraftBlocksSave(next, pattern));
          }}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ',') {
              // Enter inside an editor form would otherwise submit it.
              e.preventDefault();
              add(draft);
            }
          }}
          // Commit on blur so a typed-but-not-Entered tag survives a Save click.
          onBlur={() => add(draft)}
          placeholder={value.length ? 'add tag…' : 'late-night, weekend…'}
          aria-label={`Add ${noun} tag`}
        />
      </div>
      {err && <div role="alert" className="text-[11px] text-vermilion">{err}</div>}
      {unused.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="caption mr-1">in use</span>
          {unused.map(t => (
            <Pill key={t} onClick={disabled ? undefined : () => add(t)} title={`Add tag “${t}”`}>
              #{t}
            </Pill>
          ))}
        </div>
      )}
    </div>
  );
}

export default TagField;
