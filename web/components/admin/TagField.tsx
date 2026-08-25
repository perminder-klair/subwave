'use client';

/* The tag editor, shared by the show and persona editors.
 *
 * Skills had this markup first (skills/SkillEditModal.tsx), and it is NOT
 * lifted out of there: that copy is styled with the modal's own inline style
 * objects — `chipStyle`, `inputBase`, `sectionLabel` — which belong to the
 * modal, not to a tag. This one is written against the admin `.tag` classes the
 * rest of the panels use. Two renderings, one behaviour: the add/validate/cap
 * rules live here and the skills modal is free to follow later.
 *
 * The RULES are the caller's, passed in rather than imported, because the three
 * tag vocabularies are three separate schema constants by design — a mirrored
 * schema module may import only zod, so SKILL_TAG_RE, SHOW_TAG_RE and
 * PERSONA_TAG_RE are three declarations of one pattern. Hard-coding one of them
 * here would silently make this component enforce the wrong cap for two of its
 * three callers the first time any of them diverges. */

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
  /** A malformed, uncommitted draft must participate in the parent editor's
   *  save gate; otherwise clicking Save blurs this input, reports the error
   *  locally, then submits the old tag array and silently loses the draft. */
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
  // Inline rather than a toast: the input that caused it is on screen, and a
  // toast for a typo the operator is still mid-correction on reads as an error
  // about the save.
  const [err, setErr] = useState<string | null>(null);

  const add = (raw: string) => {
    const tag = raw.trim().toLowerCase();
    if (!tag) { setErr(null); onDraftBlockedChange?.(false); return; }
    if (!pattern.test(tag)) {
      setErr(`“${tag}” isn’t a valid tag — lowercase letters, digits and hyphens, max ${charMax} characters`);
      onDraftBlockedChange?.(true);
      return;
    }
    // Re-typing a tag that is already on is a no-op, not an error: it is what
    // an operator does when they have lost track of which chips are set.
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
          // Committing on blur is what makes a typed-but-not-Entered tag
          // survive the operator clicking straight on Save.
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
