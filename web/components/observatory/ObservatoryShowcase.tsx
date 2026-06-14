'use client';

import { useCallback, useMemo, useState } from 'react';
import ConstellationMap from './ConstellationMap';
import Tooltip, { type TipState } from './Tooltip';
import { StatsView, Dossier } from './panels';
import { buildMockLibrary, buildMockDetail, nearest, type ObsTrack } from './data';

// The Library Observatory, embedded on the public landing page (inside the DJ
// section). Runs entirely on the seeded mock library + mock dossier — no admin
// auth, no controller, no real catalogue — so a first-time visitor sees the
// constellation, and one track's full dossier, without a backing install.
//
// Presented as a plain bordered editorial figure (no browser-window chrome).
// Two columns mirror the real /observatory app minus the filter rail: the
// constellation on the left, the right rail showing the inspected track's
// Dossier (a node is pre-selected so the rich data is visible on arrival) and
// falling back to the library StatsView when the visitor closes it.
//
// colour-by is pinned to ENERGY, the signature ink→vermilion heat ramp. The
// map is interactive: hover for a read-out, click a star to inspect it (and
// light its nearest neighbours), scroll to zoom, drag to pan. Mounted via
// next/dynamic({ ssr: false }) by the embed wrapper, so the map's client-only
// APIs never run during SSR.

export default function ObservatoryShowcase() {
  // Seeded + deterministic, so it's built once and identical every render.
  // 800 nodes — a denser map, still under the SVG→canvas threshold (3000).
  const lib = useMemo(() => buildMockLibrary(800), []);

  // Open a representative track by default: analysed, keyed, a couple of moods,
  // with some energy — so the dossier lands on something rich, not a stub.
  const defaultTrack = useMemo(
    () =>
      lib.tracks.find((t) => t.analysed && !!t.musicalKey && t.moods.length >= 2 && t.energy !== 'low') ??
      lib.tracks[0] ??
      null,
    [lib],
  );

  const [selected, setSelected] = useState<ObsTrack | null>(defaultTrack);
  const [tip, setTip] = useState<TipState | null>(null);

  // Nothing is filtered out in the showcase — every node is "in view".
  const matchSet = useMemo(() => new Set(lib.tracks.map((t) => t.idx)), [lib]);

  // Mix-next wiring + dossier list: the 8 spatially-nearest tracks.
  const mixNodes = useMemo(
    () => (selected ? nearest(selected, lib.tracks, 8) : []),
    [selected, lib],
  );

  // Synthesised rich detail (embeddings + song shape + enrichment) for the open
  // node, rebuilt when the selection changes. Deterministic off its seed.
  const detail = useMemo(() => (selected ? buildMockDetail(selected) : null), [selected]);

  // Stable identities so ConstellationMap's memoised node layer survives the
  // re-render a hover (tip state) triggers — matching ObservatoryApp.
  const onHover = useCallback((t: ObsTrack | null, e?: React.MouseEvent) => {
    if (!t || !e) {
      setTip(null);
      return;
    }
    setTip({ track: t, x: e.clientX, y: e.clientY });
  }, []);
  const onSelect = useCallback((t: ObsTrack | null) => setSelected(t), []);

  return (
    <div className="obs-embed-box">
      <div
        className="observatory-root obs-embed"
        aria-label="Library Observatory — a constellation of a sample music library, every track placed by genre and lit by energy"
      >
        <section className="obs-embed-stage">
          <ConstellationMap
            lib={lib}
            matchSet={matchSet}
            colorBy="energy"
            selected={selected}
            neighbours={mixNodes}
            hovered={tip ? tip.track : null}
            onHover={onHover}
            onSelect={onSelect}
          />
          <span className="obs-embed-badge t-caption">
            SAMPLE LIBRARY · <span className="t-nums acc">{lib.stats.total}</span> TRACKS
          </span>
        </section>

        <aside className="obs-side obs-embed-side">
          {selected ? (
            <Dossier
              track={selected}
              detail={detail}
              loading={false}
              mixNodes={mixNodes}
              onSelect={setSelected}
              onClose={() => setSelected(null)}
            />
          ) : (
            <StatsView stats={lib.stats} list={lib.tracks} filtered={false} />
          )}
        </aside>
      </div>

      <Tooltip data={tip} />
    </div>
  );
}
