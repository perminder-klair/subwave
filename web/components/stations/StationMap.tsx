import { createMap } from 'svg-dotted-map';
import type { Station } from '@/lib/stations';

// A world chart for the stations directory. Renders an actual dotted continent
// silhouette (via svg-dotted-map's `createMap`) rather than a bare graticule, so
// it reads as a real coverage map — land stippled in a muted ink, each station
// plotted as a pulsing vermilion marker with a mono label.
//
// Pure server render: `createMap` has no DOM dependency, the /stations route is
// statically generated, so the dot field is computed once at build time. We keep
// the magicui DottedMap maths (stagger offsets) but inline them — no `useMemo`,
// no `'use client'` — to stay a server component.

const W = 360; // viewBox width  — matched to the old chart so the CSS scale carries over
const H = 180; // viewBox height
const SAMPLES = 10000; // sample density for the land dot field

// Marker payload threaded through addMarkers (lat/lng are stripped on the way out).
interface StationMarker {
  size?: number;
  slug: string;
  name: string;
  label: string;
}

export default function StationMap({ stations }: { stations: Station[] }) {
  const plotted = stations.filter((s) => s.lat != null && s.lon != null);

  const { points, addMarkers } = createMap({ width: W, height: H, mapSamples: SAMPLES });

  const markers = addMarkers(
    plotted.map<{ lat: number; lng: number } & StationMarker>((s) => ({
      lat: s.lat as number,
      lng: s.lon as number,
      size: 2.4,
      slug: s.slug,
      name: s.name,
      label: s.location || s.name,
    })),
  );

  // Stagger: offset every other dot row by half a column so the field reads as a
  // honeycomb rather than a rigid grid. Single pass — find the row order (y →
  // index) and the smallest positive x-step within a row.
  const sorted = [...points].sort((a, b) => a.y - b.y || a.x - b.x);
  const rowIndexByY = new Map<number, number>();
  let xStep = 0;
  let prevY = Number.NaN;
  let prevX = Number.NaN;
  for (const p of sorted) {
    if (p.y !== prevY) {
      prevY = p.y;
      prevX = Number.NaN;
      if (!rowIndexByY.has(p.y)) rowIndexByY.set(p.y, rowIndexByY.size);
    }
    if (!Number.isNaN(prevX)) {
      const delta = p.x - prevX;
      if (delta > 0) xStep = xStep === 0 ? delta : Math.min(xStep, delta);
    }
    prevX = p.x;
  }
  if (xStep === 0) xStep = 1;
  const offsetFor = (y: number) => ((rowIndexByY.get(y) ?? 0) % 2 === 1 ? xStep / 2 : 0);

  return (
    <figure
      className="bs-station-map"
      aria-label={`World map of ${plotted.length} SUB/WAVE stations`}
    >
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="bs-station-map-svg"
        role="img"
        preserveAspectRatio="xMidYMid meet"
      >
        {/* Land — stippled dot field */}
        <g className="bs-map-land">
          {points.map((p, i) => (
            <circle key={i} cx={p.x + offsetFor(p.y)} cy={p.y} r={0.55} />
          ))}
        </g>

        {/* Stations */}
        {markers.map((m) => {
          const x = m.x + offsetFor(m.y);
          const y = m.y;
          const flip = x > W - 70; // keep right-edge labels inside the frame
          return (
            <g key={m.slug} className="bs-map-station">
              <title>{m.label === m.name ? m.name : `${m.name} — ${m.label}`}</title>
              {/* Pulse ring */}
              <circle cx={x} cy={y} r={2.6} className="bs-map-pulse">
                <animate
                  attributeName="r"
                  values="2.6;7"
                  dur="1.8s"
                  repeatCount="indefinite"
                />
                <animate
                  attributeName="opacity"
                  values="0.6;0"
                  dur="1.8s"
                  repeatCount="indefinite"
                />
              </circle>
              <circle cx={x} cy={y} r={5.5} className="bs-map-halo" />
              <circle cx={x} cy={y} r={2.4} className="bs-map-dot" />
              <text
                x={flip ? x - 5 : x + 5}
                y={y + 2.2}
                className="bs-map-label"
                textAnchor={flip ? 'end' : 'start'}
              >
                {m.label}
              </text>
            </g>
          );
        })}
      </svg>
      {plotted.length === 0 ? (
        <figcaption className="bs-map-caption">
          No stations plotted yet — add yours below.
        </figcaption>
      ) : null}
    </figure>
  );
}
