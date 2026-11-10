'use client';

import { useCallback, useMemo, useState } from 'react';
import ConstellationGalaxy from './ConstellationGalaxy';
import Tooltip, { type TipState } from './Tooltip';
import { StatsView, Dossier } from './panels';
import { buildMockLibrary, buildMockDetail, nearest, type ObsTrack } from './data';

// The Library Observatory embedded on the public landing page. Runs on the
// seeded mock library + mock dossier only: no admin auth, no controller.
//
// Two columns mirror /observatory minus the filter rail, with colour-by pinned
// to ENERGY. Mounted via next/dynamic({ ssr: false }), so the map's client-only
// APIs never run during SSR.

export default function ObservatoryShowcase() {
  // Seeded, so it's built once and identical every render.
  const lib = useMemo(() => buildMockLibrary(800), []);

  // Open a representative track so the dossier lands on something rich.
  const defaultTrack = useMemo(
    () =>
      lib.tracks.find((t) => t.analysed && !!t.musicalKey && t.moods.length >= 2 && t.energy !== 'low') ??
      lib.tracks[0] ??
      null,
    [lib],
  );

  const [selected, setSelected] = useState<ObsTrack | null>(defaultTrack);
  const [tip, setTip] = useState<TipState | null>(null);

  const matchSet = useMemo(() => new Set(lib.tracks.map((t) => t.idx)), [lib]);

  const mixNodes = useMemo(
    () => (selected ? nearest(selected, lib.tracks, 8) : []),
    [selected, lib],
  );

  // Synthesised detail for the open node, deterministic off its seed.
  const detail = useMemo(() => (selected ? buildMockDetail(selected) : null), [selected]);

  // Stable identities, or the galaxy's attribute-refresh effects re-run on
  // every hover re-render.
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
          <ConstellationGalaxy
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
