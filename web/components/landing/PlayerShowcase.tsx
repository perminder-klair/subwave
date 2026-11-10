'use client';

import { useEffect, useState } from 'react';
import { m } from 'motion/react';
import PlayerApp from '../PlayerApp';
import {
  DEFAULT_STATION_ORIGIN,
  StationOriginProvider,
  originForStation,
} from '@/lib/stationOrigin';
import type { ShowcaseStation } from '@/lib/stations';

// Contained PlayerApp portals overlays into the frame. Changing stations remounts it to reset feed,
// audio, and tune-in state.

export interface PlayerShowcaseProps {
  stations?: ShowcaseStation[];
}

function hostLabel(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return 'getsubwave.com';
  }
}

// Probe timeout — a station that can't answer /now-playing in this window is
// treated as off air and never gets a tab.
const LIVENESS_TIMEOUT_MS = 5000;

export default function PlayerShowcase({ stations = [] }: PlayerShowcaseProps) {
  const [activeSlug, setActiveSlug] = useState<string | null>(null);

  // Add remote tabs after a successful probe and retain them. Start with the local tab for consistent hydration.
  const [liveSlugs, setLiveSlugs] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    for (const s of stations) {
      if (s.isLocal) continue;
      void (async () => {
        try {
          const base = s.url.replace(/\/+$/, '');
          const res = await fetch(`${base}/api/now-playing`, {
            cache: 'no-store',
            signal: AbortSignal.timeout(LIVENESS_TIMEOUT_MS),
          });
          if (!res.ok) return;
          const data: unknown = await res.json();
          const online = (data as { streamOnline?: unknown } | null)?.streamOnline;
          if (online === false) return;
          setLiveSlugs((prev) => new Set(prev).add(s.slug));
        } catch {
          // Unreachable / CORS-blocked / timed out — leave it off the strip.
        }
      })();
    }
  }, [stations]);

  const visible = stations.filter((s) => s.isLocal || liveSlugs.has(s.slug));
  const active =
    visible.find((s) => s.slug === activeSlug) ?? visible[0] ?? null;

  const origin =
    !active || active.isLocal ? DEFAULT_STATION_ORIGIN : originForStation(active.url);

  return (
    <div className="bs-frame">
      {visible.length > 1 && (
        <div className="bs-frame-tabs" role="tablist" aria-label="Stations">
          {visible.map((s, i) => {
            const selected = s.slug === active?.slug;
            return (
              <button
                key={s.slug}
                type="button"
                role="tab"
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                className="bs-frame-tab"
                data-active={selected || undefined}
                onClick={() => setActiveSlug(s.slug)}
                onKeyDown={(e) => {
                  // Roving-tabindex tablist: arrows move between station tabs,
                  // selection follows focus (each tab swap is cheap — a remount
                  // of the embedded player).
                  const delta =
                    e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
                  const next =
                    delta !== 0
                      ? (i + delta + visible.length) % visible.length
                      : e.key === 'Home'
                        ? 0
                        : e.key === 'End'
                          ? visible.length - 1
                          : null;
                  const target = next === null ? undefined : visible[next];
                  if (next === null || !target) return;
                  e.preventDefault();
                  setActiveSlug(target.slug);
                  const tabs =
                    e.currentTarget.parentElement?.querySelectorAll<HTMLElement>(
                      '[role="tab"]',
                    );
                  tabs?.[next]?.focus();
                }}
                title={s.genre || s.name}
              >
                <span className="bs-frame-tab-dot" aria-hidden="true" />
                <span className="bs-frame-tab-name">{s.name}</span>
              </button>
            );
          })}
        </div>
      )}

      <div className="bs-frame-bar">
        <div className="bs-frame-dots" aria-hidden="true">
          <span className="bs-frame-dot" data-tone="r" />
          <span className="bs-frame-dot" data-tone="y" />
          <span className="bs-frame-dot" data-tone="g" />
        </div>
        <div className="bs-frame-url">
          <span className="text-muted">https://</span>
          <span>{active ? hostLabel(active.url) : 'getsubwave.com'}</span>
          <span className="text-muted">/listen</span>
        </div>
        <m.div
          className="bs-frame-live"
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 0.6, ease: [0.2, 0.7, 0.2, 1] }}
          aria-hidden="true"
        >
          <span className="bs-live-dot" />
          <span>LIVE</span>
        </m.div>
      </div>

      <div className="bs-frame-screen">
        <StationOriginProvider value={origin}>
          <PlayerApp key={active?.slug ?? 'local'} contained />
        </StationOriginProvider>
      </div>
    </div>
  );
}
