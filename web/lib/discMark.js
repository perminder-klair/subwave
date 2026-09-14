// Shared SUB/WAVE disc mark for the favicons and PWA install icons. Kept in
// lockstep with app/assets/icon.png and the .bs-wordmark-disc-face hover state
// in globals.css. Inline SVG so next/og (Satori) reproduces it at any size.

const BG = '#100e0c'; // dark plate (--bg)
const DISC = '#ece6dc'; // cream face (--ink, dark theme)
const SPOKE = '#141310'; // ink spokes
const HUB = '#d94b2a'; // hot vermilion hub (--accent)

// 20 wedges (9deg ink, 9deg cream gap) as SVG arc paths on a 100x100 canvas
// centred at (50,50).
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

// `fill` (0-1) is how much of the canvas the disc occupies; maskable icons
// shrink so the disc stays inside the Android launcher safe zone.
// `opaque` fills the canvas behind the disc. Maskable icons MUST set it or
// Android's adaptive mask drops the icon onto a system backdrop and clips it.
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
        <circle cx="50" cy="50" r={hub + 1.4} fill={BG} />
        <circle cx="50" cy="50" r={hub} fill={HUB} />
      </svg>
    </div>
  );
}
