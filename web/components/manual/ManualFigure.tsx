interface ManualFigureProps {
  /** Path under /public — the shots live in public/screenshots/*.webp. */
  src: string;
  /** Describes the image itself, for screen readers. Distinct from the caption. */
  alt: string;
  /** The visible FIG. line under the frame. */
  caption: string;
  /** Intrinsic pixel size — reserves the box before load so nothing shifts. */
  width: number;
  height: number;
  /**
   * Shape hint for anything that isn't a landscape screen grab:
   *  - `phone` — a handset shot, shown whole at handset width.
   *  - `tall`  — a long scrolling panel, framed to its top so it stays legible
   *              instead of stretching the column into a ribbon.
   */
  shot?: 'phone' | 'tall';
}

// A screenshot inside a manual page: thin ink frame, broadsheet caption. Server
// component on purpose, so a static manual page pulls in no client chunk; the
// animated marketing variant is components/what/Figure.tsx.
export default function ManualFigure({
  src,
  alt,
  caption,
  width,
  height,
  shot,
}: ManualFigureProps) {
  return (
    <figure className="bs-manual-figure" data-shot={shot}>
      <img src={src} alt={alt} width={width} height={height} loading="lazy" decoding="async" />
      <figcaption className="bs-manual-figcaption">
        <b>FIG.</b> {caption}
      </figcaption>
    </figure>
  );
}
