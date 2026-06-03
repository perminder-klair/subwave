import type { Station } from '@/lib/stations';

// A world chart for the stations directory. No mapping library and no vendored
// continent geometry — instead an equirectangular GRATICULE (meridians +
// parallels, with the equator and prime meridian emphasised), framed in
// broadsheet rules, with each station plotted as a pulsing vermilion dot. It
// reads as a shortwave / coverage chart, which suits a radio project, and keeps
// the page self-contained.
//
// Projection (equirectangular): x = lon + 180  ∈ [0, 360];  y = 90 - lat ∈ [0, 180].
// Server component — pure render from the station list passed in.

const W = 360; // world width in user units (lon span 360°)
const H = 180; // world height in user units (lat span 180°)
const PAD = 14; // breathing room for edge labels / glow

function project(lat: number, lon: number): { x: number; y: number } {
  return { x: lon + 180, y: 90 - lat };
}

export default function StationMap({ stations }: { stations: Station[] }) {
  const plotted = stations.filter((s) => s.lat != null && s.lon != null);

  // Meridians every 30° of longitude, parallels every 30° of latitude.
  const meridians: number[] = [];
  for (let lon = -180; lon <= 180; lon += 30) meridians.push(lon);
  const parallels: number[] = [];
  for (let lat = 90; lat >= -90; lat -= 30) parallels.push(lat);

  return (
    <figure className="bs-station-map" aria-label={`World map of ${plotted.length} SUB/WAVE stations`}>
      <svg
        viewBox={`${-PAD} ${-PAD} ${W + PAD * 2} ${H + PAD * 2}`}
        className="bs-station-map-svg"
        role="img"
        preserveAspectRatio="xMidYMid meet"
      >
        {/* Frame */}
        <rect x={0} y={0} width={W} height={H} className="bs-map-frame" />

        {/* Graticule */}
        {meridians.map((lon) => {
          const x = lon + 180;
          const prime = lon === 0;
          return (
            <line
              key={`m${lon}`}
              x1={x}
              y1={0}
              x2={x}
              y2={H}
              className={prime ? 'bs-map-axis' : 'bs-map-grid'}
            />
          );
        })}
        {parallels.map((lat) => {
          const y = 90 - lat;
          const equator = lat === 0;
          return (
            <line
              key={`p${lat}`}
              x1={0}
              y1={y}
              x2={W}
              y2={y}
              className={equator ? 'bs-map-axis' : 'bs-map-grid'}
            />
          );
        })}

        {/* Stations */}
        {plotted.map((s) => {
          const { x, y } = project(s.lat as number, s.lon as number);
          const label = s.location || s.name;
          const flip = x > W - 70; // keep right-edge labels inside the frame
          return (
            <g key={s.slug} className="bs-map-station">
              <title>{`${s.name}${s.location ? ` — ${s.location}` : ''}`}</title>
              <circle cx={x} cy={y} r={5.5} className="bs-map-halo" />
              <circle cx={x} cy={y} r={2.4} className="bs-map-dot" />
              <text
                x={flip ? x - 5 : x + 5}
                y={y + 2.2}
                className="bs-map-label"
                textAnchor={flip ? 'end' : 'start'}
              >
                {label}
              </text>
            </g>
          );
        })}
      </svg>
      {plotted.length === 0 ? (
        <figcaption className="bs-map-caption">No stations plotted yet — add yours below.</figcaption>
      ) : null}
    </figure>
  );
}
