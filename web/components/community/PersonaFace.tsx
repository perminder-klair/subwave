import { hashString, pick } from './kit';

// A generative booth portrait for a community persona. The catalog carries no
// art, so each DJ gets a poster-style silhouette seeded from its slug (hair,
// backdrop, eyewear) and shaped by its own dials: warmth sets the eyes, humour
// the mouth, local colour pins a star on the lapel. Same slug, same face, on
// every request: no client JS, nothing stored.
//
// Colours are theme tokens only (ink head, page-colour features, accent
// headphones), so the portrait inverts cleanly on dark themes. Decorative: the
// name sits beside it in HTML.

interface Props {
  slug: string;
  humour?: number;
  warmth?: number;
  localColour?: number;
  className?: string;
}

const HAIR = 6;
const BACKDROP = 3;

export default function PersonaFace({ slug, humour, warmth, localColour, className }: Props) {
  const seed = hashString(slug);
  const hair = pick(seed, 1, HAIR);
  const backdrop = pick(seed, 2, BACKDROP);
  const visor = pick(seed, 3, 5) === 0;
  const tilt = (pick(seed, 4, 9) - 4) * 1.2; // −4.8° … +4.8°
  const w = warmth ?? 5;
  const h = humour ?? 5;

  return (
    <svg
      viewBox="0 0 120 120"
      className={className}
      aria-hidden="true"
      focusable="false"
      preserveAspectRatio="xMidYMid slice"
    >
      {/* No clipPath: an inline <svg> already clips to its viewBox, and an id
          would repeat when one face appears in the lineup, spotlight and grid. */}
      <g>
        <rect x="0" y="0" width="120" height="120" fill="var(--accent-soft, transparent)" />
        <Backdrop variant={backdrop} />

        <g transform={`rotate(${tilt} 60 80)`}>
          {/* Afro sits behind the head so the silhouette grows, not overlaps. */}
          {hair === 4 && <circle cx="60" cy="47" r="31" fill="var(--ink)" />}

          <path d="M14 124 C18 94 38 86 60 86 C82 86 102 94 106 124 Z" fill="var(--ink)" />
          <rect x="52" y="70" width="16" height="18" fill="var(--ink)" />
          <ellipse cx="60" cy="54" rx="22" ry="25" fill="var(--ink)" />

          <Hair variant={hair} />

          {/* Headphones: every one of them is a DJ. */}
          <path
            d="M33 54 A27 30 0 0 1 87 54"
            fill="none"
            stroke="var(--accent)"
            strokeWidth="5"
            strokeLinecap="round"
          />
          <rect x="28" y="47" width="10" height="19" rx="3" fill="var(--accent)" />
          <rect x="82" y="47" width="10" height="19" rx="3" fill="var(--accent)" />

          {visor ? (
            <rect x="43" y="50" width="34" height="8" rx="2" fill="var(--bg)" />
          ) : (
            <Eyes warmth={w} />
          )}
          <Mouth humour={h} />

          {(localColour ?? 0) >= 8 && (
            <path
              d="M82 98 l2.6 5.4 5.9 .8 -4.3 4.1 1 5.9 -5.2 -2.8 -5.2 2.8 1 -5.9 -4.3 -4.1 5.9 -.8z"
              fill="var(--accent)"
            />
          )}
        </g>
      </g>
    </svg>
  );
}

function Backdrop({ variant }: { variant: number }) {
  if (variant === 0) {
    // Sunburst: twelve wedges from behind the head.
    return (
      <g fill="var(--accent)" opacity="0.16">
        {Array.from({ length: 12 }, (_, i) => (
          <path key={i} d="M60 60 L52 -40 L68 -40 Z" transform={`rotate(${i * 30} 60 60)`} />
        ))}
      </g>
    );
  }
  if (variant === 1) {
    // Concentric rings, like a record seen from above.
    return (
      <g fill="none" stroke="var(--ink)" opacity="0.14" strokeWidth="1.2">
        {[18, 28, 38, 48, 58, 68, 78].map((r) => (
          <circle key={r} cx="60" cy="56" r={r} />
        ))}
      </g>
    );
  }
  // Halftone: a dot screen that fades toward the top-right.
  const dots = [];
  for (let y = 4; y < 120; y += 8) {
    for (let x = 4; x < 120; x += 8) {
      const r = Math.max(0.3, 2.6 - (x + (120 - y)) / 80);
      dots.push(<circle key={`${x}-${y}`} cx={x} cy={y} r={r} />);
    }
  }
  return (
    <g fill="var(--ink)" opacity="0.16">
      {dots}
    </g>
  );
}

function Hair({ variant }: { variant: number }) {
  switch (variant) {
    case 0: // flat-top
      return <rect x="38" y="24" width="44" height="16" rx="3" fill="var(--ink)" />;
    case 1: // mohawk, in the accent
      return (
        <path d="M50 34 L54 10 L58 30 L62 6 L66 30 L70 12 L72 34 Z" fill="var(--accent)" />
      );
    case 2: // top bun
      return <circle cx="60" cy="25" r="10" fill="var(--ink)" />;
    case 3: // side swoop
      return <path d="M35 50 C30 20 74 12 90 38 C74 30 52 32 35 50 Z" fill="var(--ink)" />;
    case 4: // afro, drawn behind the head above
      return null;
    default: // bald, with a shine
      return (
        <path
          d="M50 35 Q58 30 66 33"
          fill="none"
          stroke="var(--bg)"
          strokeWidth="2"
          strokeLinecap="round"
          opacity="0.7"
        />
      );
  }
}

function Eyes({ warmth }: { warmth: number }) {
  if (warmth >= 7) {
    // Smiling eyes.
    return (
      <g fill="none" stroke="var(--bg)" strokeWidth="2.6" strokeLinecap="round">
        <path d="M46 55 q4.5 -5 9 0" />
        <path d="M65 55 q4.5 -5 9 0" />
      </g>
    );
  }
  if (warmth <= 3) {
    // Unimpressed slits.
    return (
      <g stroke="var(--bg)" strokeWidth="2.6" strokeLinecap="round">
        <path d="M46 54 h9" />
        <path d="M65 54 h9" />
      </g>
    );
  }
  return (
    <g fill="var(--bg)">
      <circle cx="50.5" cy="54" r="2.8" />
      <circle cx="69.5" cy="54" r="2.8" />
    </g>
  );
}

function Mouth({ humour }: { humour: number }) {
  if (humour >= 7) return <path d="M49 65 q11 12 22 0 z" fill="var(--bg)" />;
  if (humour <= 3)
    return <path d="M52 68 h16" stroke="var(--bg)" strokeWidth="2.6" strokeLinecap="round" />;
  return (
    <path
      d="M51 66 q9 6 18 0"
      fill="none"
      stroke="var(--bg)"
      strokeWidth="2.6"
      strokeLinecap="round"
    />
  );
}
