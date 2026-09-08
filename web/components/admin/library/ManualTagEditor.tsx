'use client';

import type { ChangeEvent } from 'react';
import { useState } from 'react';
import { Btn, Eyebrow, Pill, Seg } from '../ui';
import { cn } from '../../../lib/cn';
 
import { SkeletonText } from '@/components/ui/skeleton';
import type { Track } from './types';

const ENERGY_SEG: { id: string; label: string }[] = [
  { id: 'none', label: 'none' },
  { id: 'low', label: 'low' },
  { id: 'medium', label: 'med' },
  { id: 'high', label: 'high' },
];

// Browser half of show-filter.resolveEraYear, mirrored (the resolver is not a
// schema, so not in the generated mirror). Keep the precedence in step.
function eraYearOf(track: Track): number | null {
  const oy = Number(track.originalYear);
  if (Number.isFinite(oy) && oy > 0) return oy;
  // Either signal is enough: isCompilation is unset on the reissue anthologies
  // eraUntrusted exists to catch (#1418).
  if (track.isCompilation || track.eraUntrusted) return null;
  const y = Number(track.year);
  return Number.isFinite(y) && y > 0 ? y : null;
}

// Where the era year came from. 'album-tag' is flagged as weak: on a reissue the
// album's originalReleaseDate is the reissue's date (#1418).
function eraSourceNote(track: Track): string {
  const era = eraYearOf(track);
  if (era == null) {
    return track.isCompilation || track.eraUntrusted
      ? 'no era year — the album’s date is the release’s, and the real one is unresolved, so era-bounded shows skip this track'
      : 'no era year — this track is invisible to era-bounded shows';
  }
  switch (track.originalYearSource) {
    case 'manual':      return `${era} · set by hand`;
    case 'musicbrainz': return `${era} · from MusicBrainz`;
    case 'album-tag':   return `${era} · from the album tag — on a reissue this is the reissue’s date`;
    default:            return `${era} · the file’s own year`;
  }
}

export function ManualTagEditor(props: {
  track: Track;
  vocab: string[];
  busy: boolean;
  eraBusy: boolean;
  onSave: (moods: string[], energy: string | null, applyToAlbum: boolean) => void;
  onSaveEraYear: (originalYear: number | null, applyToAlbum: boolean) => void;
  onCancel: () => void;
}) {
  const { track, vocab, busy, eraBusy } = props;
  const [sel, setSel] = useState<string[]>((track.moods || []).slice(0, 3));
  const [energy, setEnergy] = useState<string>(track.energy || 'none');
  const [applyToAlbum, setApplyToAlbum] = useState(false);
  // Seeded from the manual override only, never the resolved era year: a
  // prefilled guess gets "confirmed" into an override that outranks every later fix.
  const [eraInput, setEraInput] = useState<string>(
    track.originalYearSource === 'manual' && track.originalYear != null ? String(track.originalYear) : '',
  );

  const toggle = (m: string) =>
    setSel(cur => cur.includes(m) ? cur.filter(x => x !== m) : (cur.length >= 3 ? cur : [...cur, m]));
  const energyVal = energy === 'none' ? null : energy;

  const eraTyped = eraInput.trim();
  const eraParsed = /^\d{4}$/.test(eraTyped) ? Number(eraTyped) : null;
  const eraValid = eraParsed != null && eraParsed >= 1900 && eraParsed <= new Date().getFullYear() + 1;
  const hasOverride = track.originalYearSource === 'manual';

  return (
    // Renders as a sibling of .lib-row, so the testid is the only way to scope to it.
    <div data-testid="manual-tag-editor" className="grid gap-3 border-b border-ink bg-[var(--ink-softer)] px-4 py-3">
      <div className="grid gap-1.5">
        <Eyebrow>moods · up to 3</Eyebrow>
        <div className="flex flex-wrap gap-1.5">
          {vocab.length === 0 && <SkeletonText lines={1} />}
          {vocab.map(m => {
            const on = sel.includes(m);
            // Pass `disabled` rather than dropping onClick: without a handler the
            // Pill falls back to a Badge <span>, unfocusable and unannounced.
            const unavailable = busy || (!on && sel.length >= 3);
            return (
              <Pill
                key={m}
                tone={on ? 'accent' : 'default'}
                pressed={on}
                disabled={unavailable}
                onClick={() => toggle(m)}
                className={cn(unavailable && !on && 'opacity-40')}
              >
                {m}
              </Pill>
            );
          })}
        </div>
      </div>
      <div className="grid gap-1.5">
        <Eyebrow>energy</Eyebrow>
        <div><Seg value={energy} options={ENERGY_SEG} onChange={setEnergy} /></div>
      </div>
      <div className="grid gap-1.5">
        <Eyebrow>original year · era</Eyebrow>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            inputMode="numeric"
            aria-label="original recording year"
            placeholder={track.year ? `file says ${track.year}` : 'yyyy'}
            value={eraInput}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setEraInput(e.target.value)}
            disabled={eraBusy}
            className="w-[9.5rem] rounded border border-ink bg-transparent px-2 py-1 text-[12px] text-ink"
          />
          <Btn
            sm
            tone="accent"
            onClick={() => props.onSaveEraYear(eraParsed, applyToAlbum)}
            disabled={eraBusy || !eraValid}
          >
            {eraBusy ? 'Saving…' : 'Set year'}
          </Btn>
          {hasOverride && (
            <Btn sm tone="danger" onClick={() => props.onSaveEraYear(null, applyToAlbum)} disabled={eraBusy}>
              Clear override
            </Btn>
          )}
        </div>
        {/* text-muted, not text-ink-soft: that is a surface token and renders
            near-invisible as a text colour. */}
        <p className="mt-1 max-w-[68ch] text-[11px] leading-[1.6] text-muted">
          {eraSourceNote(track)}. Set the real recording year here — it
          outranks the album tag and MusicBrainz, and drives era shows, the
          DJ&rsquo;s intro and the player&rsquo;s year.
        </p>
      </div>
      <label className="flex items-center gap-2 text-[12px] text-ink">
        <input
          type="checkbox"
          checked={applyToAlbum}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setApplyToAlbum(e.target.checked)}
          disabled={busy || eraBusy}
        />
        {/* Shared by both saves below. */}
        apply to whole album{track.album ? ` “${track.album}”` : ''}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Btn sm tone="accent" onClick={() => props.onSave(sel, energyVal, applyToAlbum)} disabled={busy || eraBusy || sel.length === 0}>
          {busy ? 'Saving…' : 'Save tags'}
        </Btn>
        <Btn sm tone="danger" onClick={() => props.onSave([], null, applyToAlbum)} disabled={busy || eraBusy}>
          Clear tags
        </Btn>
        <Btn sm onClick={props.onCancel} disabled={busy || eraBusy}>Cancel</Btn>
      </div>
    </div>
  );
}

