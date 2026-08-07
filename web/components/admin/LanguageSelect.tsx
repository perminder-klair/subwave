'use client';
// A language picker for anything that matches against persona.language's
// free-text convention (Moods → Speech tab: per-correction language scoping,
// and the "Test corrections" preview). Dropdown of known languages + an
// "All languages" default + a "Custom…" option that reveals free text for
// anything not in the known list — same shape as the cloud-voice picker's
// preset+custom pattern elsewhere in admin, kept lightweight (no search
// dialog, no audio preview) since this list has no audition affordance and
// is short enough for a plain <Select>.
import type { ChangeEvent } from 'react';
import { Input } from '../ui/input';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '../ui/select';

// Radix Select forbids empty-string item values, so "All languages" and
// "Custom…" ride sentinels that map to/from the real value ('' and
// whatever free text the operator typed, respectively).
const ALL = '__all__';
const CUSTOM = '__custom__';
const CUSTOM_LANGUAGE_MAX = 80;

export interface LanguageSelectProps {
  // '' = all languages (the default); a known name from `languages`; or any
  // other free text (rendered as "Custom…" with the text box populated).
  value: string;
  onChange: (v: string) => void;
  // Known language display names (GET /settings tts.speechLanguages).
  languages: string[];
  className?: string;
  ariaLabel?: string;
}

export function LanguageSelect({
  value, onChange, languages, className, ariaLabel = 'Language',
}: LanguageSelectProps) {
  const isKnown = value !== '' && languages.includes(value);
  const isCustom = value !== '' && !isKnown;
  const selectValue = value === '' ? ALL : isKnown ? value : CUSTOM;

  return (
    <div className={className}>
      <Select
        value={selectValue}
        onValueChange={v => {
          if (v === ALL) onChange('');
          else if (v === CUSTOM) onChange(isCustom ? value : '');
          else onChange(v);
        }}
      >
        <SelectTrigger aria-label={ariaLabel}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All languages</SelectItem>
          {languages.map(l => (
            <SelectItem key={l} value={l}>{l}</SelectItem>
          ))}
          <SelectItem value={CUSTOM}>Custom…</SelectItem>
        </SelectContent>
      </Select>
      {selectValue === CUSTOM && (
        <Input
          aria-label="Custom language"
          value={value}
          onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
          placeholder="Language name (e.g. Swahili)"
          maxLength={CUSTOM_LANGUAGE_MAX}
          className="mt-1.5"
        />
      )}
    </div>
  );
}
