import type { ReactNode } from 'react';
import { boxFaces, silhouette, type Block } from './geometry';
import styles from './Iso.module.css';

interface IsoBoxProps extends Block {
  /** Drawn on the top face, in its own w × d plane. */
  top?: ReactNode;
  /** Drawn on the front-left face, in its own w × h plane. */
  left?: ReactNode;
  /** Drawn on the front-right face, in its own d × h plane. */
  right?: ReactNode;
  /** Fill for the top face, when it isn't paper. */
  topFill?: string;
  /** Trace the heavier silhouette pen around the box (default on). */
  outline?: boolean;
}

/** One box: its three visible faces, each a flat plane its children are laid
 *  out on, plus the silhouette. Inherits the pen from the enclosing group, so
 *  it draws inside a `.pen` layer from `Iso.module.css`. */
export function IsoBox({ x, y, z, w, d, h, top, left, right, topFill, outline = true }: IsoBoxProps) {
  const f = boxFaces({ x, y, z, w, d, h });
  return (
    <>
      <g transform={f.T}>
        <rect width={w} height={d} className={topFill ?? styles.fT} />
        {top}
      </g>
      <g transform={f.L}>
        <rect width={w} height={h} className={styles.fL} />
        {left}
      </g>
      <g transform={f.R}>
        <rect width={d} height={h} className={styles.fR} />
        {right}
      </g>
      {outline && <path d={silhouette({ x, y, z, w, d, h })} strokeWidth={1.5} className={styles.solid} />}
    </>
  );
}

/** The wobble that makes the ink layer look hand-drawn. One per drawing; the
 *  id must be unique on the page. */
export function InkFilter({ id, scale = 1.8 }: { id: string; scale?: number }) {
  return (
    <filter id={id} x="-10%" y="-10%" width="120%" height="120%">
      <feTurbulence type="fractalNoise" baseFrequency="0.03" numOctaves={2} seed={2} result="n" />
      <feDisplacementMap in="SourceGraphic" in2="n" scale={scale} xChannelSelector="R" yChannelSelector="G" />
    </filter>
  );
}
