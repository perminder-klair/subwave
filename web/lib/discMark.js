// Shared SUB/WAVE disc mark for the favicons and PWA install icons.
//
// The sunburst disc — cream face, 20 ink spokes, a vermilion hub on the
// near-black plate — is the station's real logo (same mark as the native
// app icon, app/assets/icon.png, and the .bs-wordmark-disc-face hover state
// in globals.css, whose repeating-conic-gradient is 9deg ink / 9deg gap).
// Rendered as inline SVG so next/og (Satori) reproduces it crisply at any
// size instead of the old single rotated slash.

const BG = '#100e0c'; // dark plate (--bg)
const DISC = '#ece6dc'; // cream face (--ink, dark theme)
const SPOKE = '#141310'; // ink spokes
const HUB = '#d94b2a'; // hot vermilion hub (--accent)

// 20 pie wedges — 9deg of ink, 9deg of cream gap — as SVG arc paths on a
// 100x100 canvas centred at (50,50).
function spokePaths(r) {
  const rad = (deg) => (deg * Math.PI) / 180;
  const paths = [];
  for (let i = 0; i < 20; i++) {
    const a0 = rad(i * 18);
    const a1 = rad(i * 18 + 9);
    const x0 = (50 + r * Math.cos(a0)).toFixed(3);
    const y0 = (50 + r * Math.sin(a0)).toFixed(3);
    const x1 = (50 + r * Math.cos(a1)).toFixed(3);
    const y1 = (50 + r * Math.sin(a1)).toFixed(3);
    paths.push(`M50 50 L${x0} ${y0} A${r} ${r} 0 0 1 ${x1} ${y1} Z`);
  }
  return paths;
}

// `fill` (0-1) is how much of the canvas the disc occupies — standard icons
// fill most of it (~0.8); maskable icons shrink so the disc stays inside the
// Android launcher safe zone once the adaptive mask is applied.
//
// `opaque` fills the canvas behind the disc with the dark plate. Off by
// default so the favicon / apple-touch / standard PWA icons read as a round
// disc on transparent corners rather than a black square. Maskable icons must
// set it — Android's adaptive mask needs a full-bleed opaque background or it
// drops the icon onto a system backdrop and clips it.
export function DiscMark({ size, fill = 0.8, opaque = false }) {
  const r = 50 * fill;
  const hub = r * 0.31;
  const wedges = spokePaths(r);
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        background: opaque ? BG : 'transparent',
      }}
    >
      <svg width={size} height={size} viewBox="0 0 100 100">
        <circle cx="50" cy="50" r={r} fill={DISC} />
        {wedges.map((d, i) => (
          <path key={i} d={d} fill={SPOKE} />
        ))}
        {/* dark ring, then the vermilion hub over the converging spokes */}
        <circle cx="50" cy="50" r={hub + 1.4} fill={BG} />
        <circle cx="50" cy="50" r={hub} fill={HUB} />
      </svg>
    </div>
  );
}
