// The year fields of the Era tab: a recording year between 1900 (the
// controller's ORIGINAL_YEAR_MIN) and this year, four digits, nothing else.
// An empty field's spinner or arrow keys start from the album's own year
// rather than from 0 or 1900.
import type { ChangeEvent, KeyboardEvent } from 'react';
import { ORIGINAL_YEAR_MIN } from '../../../lib/schemas.generated';

export const ERA_YEAR_MIN = ORIGINAL_YEAR_MIN;
/** Read per call, so a tab left open over New Year moves with the calendar. */
export const eraYearMax = () => new Date().getFullYear();

/** The year typed in, or null when it is not a whole year in range. */
export function parseEraYear(raw: string | null | undefined): number | null {
  const s = String(raw ?? '').trim();
  if (!/^\d{4}$/.test(s)) return null;
  const y = Number(s);
  return y >= ERA_YEAR_MIN && y <= eraYearMax() ? y : null;
}

/** Something typed that is not a valid year (an empty field is not invalid). */
export function eraYearInvalid(raw: string | null | undefined): boolean {
  return String(raw ?? '').trim() !== '' && parseEraYear(raw) == null;
}

export function eraYearError(): string {
  return `Type a year between ${ERA_YEAR_MIN} and ${eraYearMax()}`;
}

/**
 * Props for a year <Input>: the range, and a start from `startYear` when the
 * field is empty and the operator nudges it (arrow keys or the spinner, which
 * would otherwise begin at the range's end).
 */
export function eraYearInputProps(value: string, startYear: number | null | undefined, set: (v: string) => void) {
  const max = eraYearMax();
  const start = startYear != null && startYear >= ERA_YEAR_MIN && startYear <= max ? startYear : max;
  return {
    type: 'number' as const,
    inputMode: 'numeric' as const,
    min: ERA_YEAR_MIN,
    max,
    step: 1,
    placeholder: startYear ? String(startYear) : 'year',
    'aria-invalid': eraYearInvalid(value) || undefined,
    onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => {
      if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && value.trim() === '') {
        e.preventDefault();
        set(String(start));
      }
    },
    onChange: (e: ChangeEvent<HTMLInputElement>) => {
      const v = e.currentTarget.value;
      const typed = (e.nativeEvent as InputEvent).inputType?.startsWith('insert') || (e.nativeEvent as InputEvent).inputType?.startsWith('delete');
      // The spinner on an empty field lands on min or max: start at the album year instead.
      if (!typed && value.trim() === '' && (v === String(ERA_YEAR_MIN) || v === String(max))) set(String(start));
      else set(v.slice(0, 4));
    },
  };
}
