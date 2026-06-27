'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';
import { Input } from './ui/input';
import { cn } from '@/lib/cn';

// Shared location picker — type a city, pick from a dropdown, and the station's
// name + coordinates (+ IANA timezone, via onPick) fill in one tap. Used by both
// the admin Station tab and the onboarding wizard. Talks to the controller's
// unauthenticated GET /geocode proxy (Open-Meteo geocoding). Manual coordinate
// entry stays available as an always-works fallback for offline boxes.

const API_URL = process.env.NEXT_PUBLIC_API_URL || '/api';

export interface GeocodeResult {
  name: string;
  admin1?: string;
  country?: string;
  countryCode?: string;
  lat: number;
  lng: number;
  timezone?: string;
  label: string;
}

export interface LocationValue {
  locationName: string;
  lat: string;
  lng: string;
}

interface LocationPickerProps {
  value: LocationValue;
  onChange: (next: LocationValue) => void;
  // Fires with the full result on selection so a host can use extra fields —
  // both call sites use it for the picked timezone (admin suggests, onboarding
  // auto-applies). Omit to ignore.
  onPick?: (result: GeocodeResult) => void;
  // Cosmetic only: onboarding uses rounded inputs, the admin shell sharp ones.
  variant?: 'admin' | 'onboarding';
  className?: string;
}

// Out-of-range only flags a non-empty value; an empty field isn't an error.
function rangeError(value: string, min: number, max: number): boolean {
  if (value.trim() === '') return false;
  const n = Number(value);
  return Number.isNaN(n) || n < min || n > max;
}

export function LocationPicker({
  value,
  onChange,
  onPick,
  variant = 'admin',
  className,
}: LocationPickerProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GeocodeResult[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [manual, setManual] = useState(false);
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);

  const rounded = variant === 'onboarding' ? 'rounded' : '';

  // Debounced geocode lookup. < 2 chars makes no request.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setOpen(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      fetch(`${API_URL}/geocode?q=${encodeURIComponent(q)}`, { signal: ctrl.signal })
        .then(r => {
          if (!r.ok) throw new Error('geocode failed');
          return r.json() as Promise<{ results?: GeocodeResult[] }>;
        })
        .then(j => {
          setResults(j.results || []);
          setActive(-1);
          setFailed(false);
          setOpen(true);
        })
        .catch((e: unknown) => {
          if (e instanceof DOMException && e.name === 'AbortError') return;
          // Search is down (offline homelab, Open-Meteo unreachable) — surface a
          // hint and open the manual fields so config is never blocked.
          setFailed(true);
          setManual(true);
          setOpen(false);
        })
        .finally(() => setLoading(false));
    }, 300);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [query]);

  // Close the dropdown on an outside click.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const select = (r: GeocodeResult) => {
    onChange({ locationName: r.label, lat: String(r.lat), lng: String(r.lng) });
    onPick?.(r);
    setQuery('');
    setResults([]);
    setOpen(false);
    setActive(-1);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open && results.length) setOpen(true);
      setActive(a => (results.length ? (a + 1) % results.length : -1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(a => (results.length ? (a <= 0 ? results.length - 1 : a - 1) : -1));
    } else if (e.key === 'Enter') {
      if (open && active >= 0 && results[active]) {
        e.preventDefault();
        select(results[active]);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  const latErr = rangeError(value.lat, -90, 90);
  const lngErr = rangeError(value.lng, -180, 180);
  const hasValue = Boolean(value.locationName || value.lat || value.lng);

  return (
    <div ref={rootRef} className={cn('relative flex flex-col gap-2', className)}>
      {/* Search box */}
      <div className="relative w-full max-w-[420px]">
        <Input
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? `${listId}-opt-${active}` : undefined}
          placeholder="Search a city or place…"
          value={query}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => {
            if (results.length) setOpen(true);
          }}
          className={cn('pr-8', rounded)}
        />
        {loading ? (
          <span
            aria-hidden
            className="absolute top-1/2 right-2.5 h-3.5 w-3.5 -translate-y-1/2 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent"
          />
        ) : null}

        {open ? (
          <ul
            id={listId}
            role="listbox"
            className={cn(
              'absolute z-20 mt-1 max-h-64 w-full overflow-auto border border-input bg-popover text-popover-foreground shadow-md',
              rounded,
            )}
          >
            {results.length === 0 ? (
              <li className="px-3 py-2 text-[13px] text-muted-foreground">No matches</li>
            ) : (
              results.map((r, i) => (
                <li
                  key={`${r.label}-${r.lat}-${r.lng}`}
                  id={`${listId}-opt-${i}`}
                  role="option"
                  aria-selected={i === active}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={e => {
                    e.preventDefault();
                    select(r);
                  }}
                  className={cn(
                    'flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-[13px]',
                    i === active ? 'bg-muted' : '',
                  )}
                >
                  <span className="truncate">{r.label}</span>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {r.lat.toFixed(2)}, {r.lng.toFixed(2)}
                  </span>
                </li>
              ))
            )}
          </ul>
        ) : null}
      </div>

      {/* Current selection summary */}
      {hasValue ? (
        <div className="text-[13px] text-muted-foreground">
          Selected: <span className="text-foreground">{value.locationName || '—'}</span>
          {value.lat && value.lng ? (
            <span className="tabular-nums">
              {' '}
              @ {value.lat}, {value.lng}
            </span>
          ) : null}
        </div>
      ) : null}

      {failed ? (
        <div className="text-[13px] text-destructive">
          Search unavailable — enter coordinates manually below.
        </div>
      ) : null}

      {/* Manual entry disclosure — always reachable */}
      <button
        type="button"
        onClick={() => setManual(m => !m)}
        className="self-start text-xs text-muted-foreground hover:text-foreground"
      >
        {manual ? '▾' : '▸'} Enter coordinates manually
      </button>

      {manual ? (
        <div className="flex flex-wrap gap-2">
          <Input
            placeholder="name"
            aria-label="location name"
            value={value.locationName}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              onChange({ ...value, locationName: e.target.value })
            }
            className={cn('w-[200px]', rounded)}
          />
          <div className="flex flex-col">
            <Input
              className={cn('w-[132px] tabular-nums', rounded)}
              type="number"
              step="any"
              placeholder="lat"
              aria-label="latitude"
              aria-invalid={latErr}
              value={value.lat}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                onChange({ ...value, lat: e.target.value })
              }
            />
            {latErr ? <span className="mt-0.5 text-xs text-destructive">−90 to 90</span> : null}
          </div>
          <div className="flex flex-col">
            <Input
              className={cn('w-[132px] tabular-nums', rounded)}
              type="number"
              step="any"
              placeholder="lng"
              aria-label="longitude"
              aria-invalid={lngErr}
              value={value.lng}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                onChange({ ...value, lng: e.target.value })
              }
            />
            {lngErr ? <span className="mt-0.5 text-xs text-destructive">−180 to 180</span> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
