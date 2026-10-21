// SVG filters behind the theme `--finish` token. globals.css points the player
// stage at one of them (`filter: url(#sw-finish-…)`) when <html> carries the
// matching data-finish attribute, which lib/theme copies from the token.
//
// Rendered once in the root layout: a url() filter must live in the same
// document, and a second copy would duplicate the ids. Zero-size and absolutely
// positioned rather than display:none, which stops Firefox resolving the filter.
export default function ThemeFinishFilters() {
  return (
    <svg width="0" height="0" aria-hidden="true" focusable="false" className="absolute">
      {/* Bloom: bright strokes glow into the glass. Luminance becomes alpha, is
          blurred, and is screened back over the source, so only light ink on a
          dark ground blooms. */}
      <filter id="sw-finish-bloom" x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
        <feColorMatrix
          in="SourceGraphic"
          type="matrix"
          values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0.3 0.6 0.1 0 -0.2"
          result="lum"
        />
        <feGaussianBlur in="lum" stdDeviation="2.6" result="glow" />
        <feBlend in="glow" in2="SourceGraphic" mode="screen" />
      </filter>
      {/* Misregistration: every dark line gets an accent-coloured ghost, offset
          2 × 1.5px, multiplied under it like a second drum printing off true.
          Darkness becomes alpha, so this reads on light paper only. The ramp
          reaches zero at mid-grey (R+G+B ≈ 2.2), so the paper's own grain and
          halftone, which sit inside this filter, never pick up the ghost. */}
      <filter id="sw-finish-misregister" x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
        <feColorMatrix
          in="SourceGraphic"
          type="matrix"
          values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  -0.64 -0.64 -0.64 0 1.41"
          result="inkA"
        />
        <feFlood className="[flood-color:var(--accent)]" floodOpacity="0.85" result="drum" />
        <feComposite in="drum" in2="inkA" operator="in" result="drumInk" />
        <feOffset in="drumInk" dx="2" dy="1.5" result="ghost" />
        <feBlend in="SourceGraphic" in2="ghost" mode="multiply" />
      </filter>
    </svg>
  );
}
