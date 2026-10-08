import { IsoBox, InkFilter } from '../iso/IsoBox';
import { arrow, boxFaces, hatchStrip, loop, project } from '../iso/geometry';
import iso from '../iso/Iso.module.css';
import { cn } from '@/lib/cn';
import styles from './DeadAirFigure.module.css';

// The 404's drawing: a receiver left in construction lines (nothing is on),
// its readout crossed out and its plug lying on the floor. The needle still
// drifts along the dial looking for something, unless lite mode or reduced
// motion stills it. A still drawing in every other respect, and server-rendered.

const RX = { x: 0, y: 0, w: 200, d: 120, h: 70 };

/** The floor's own plane: world x/y map straight onto it. */
const FLOOR = boxFaces({ x: -200, y: -200, z: 0, w: 600, d: 600, h: 0 }).T;
/** The power cord on the floor, in floor coordinates offset by +200. */
const CORD = 'M400 260C440 260 432 318 472 330';

let DIAL_TICKS = '';
for (let i = 0; i <= 13; i++) DIAL_TICKS += `M${16 + i * 8} 7V${i % 4 === 0 ? 15 : 11}`;

/** The readout's corners (it sits at x 14–96, z 26–40 on the front face). */
const lcdA = project(14, 120, 40);
const lcdB = project(96, 120, 26);
const lcdC = project(14, 120, 26);
const lcdD = project(96, 120, 40);
const plug = project(283, 136, 5);

export default function DeadAirFigure({ className }: { className?: string }) {
  return (
    <div className={cn(iso.sheet, className)}>
      <svg
        viewBox="-130 -100 440 370"
        className="block h-auto w-full overflow-visible"
        role="img"
        aria-label="A radio receiver drawn in faint construction lines, its display crossed out and its plug lying unplugged on the floor."
      >
        <defs>
          <InkFilter id="dead-air-wob" />
        </defs>

        <g className={cn(iso.pen, iso.penOff)}>
          <path d={hatchStrip(200, 226, 6, 120, 7)} strokeWidth={0.5} opacity={0.6} className={iso.solid} />

          <IsoBox
            {...RX}
            z={0}
            top={<path d="M14 16H186M14 24H186M14 32H186" strokeWidth={0.4} opacity={0.6} />}
            left={
              <>
                {/* Dial, with the needle hunting along it */}
                <rect x="12" y="6" width="112" height="20" className={iso.fBg} />
                <path d={DIAL_TICKS} strokeWidth={0.6} />
                <text x="16" y="23" fontSize={5} fontWeight={500} className={cn(iso.txMuted, iso.mono)}>88</text>
                <text x="120" y="23" fontSize={5} fontWeight={500} textAnchor="end" className={cn(iso.txMuted, iso.mono)}>108</text>
                <g className={styles.needle}>
                  <line x1="18" y1="7" x2="18" y2="25" strokeWidth={1.4} className={cn(iso.sAcc, iso.solid)} />
                </g>

                {/* Readout */}
                <rect x="14" y="30" width="82" height="14" className={cn(iso.fInk, iso.ns)} />
                <text x="18" y="39.6" fontSize={6.5} fontWeight={700} letterSpacing="0.12em" className={cn(iso.txBg, iso.mono)}>
                  NO SIGNAL
                </text>

                {/* Power, unlit */}
                <circle cx="140" cy="20" r="8" className={iso.fW} />
                <path d="M137.17 17.17A4 4 0 1 0 142.83 17.17M140 15V20" strokeWidth={1.4} />
                <text x="140" y="36" fontSize={4.5} fontWeight={700} letterSpacing="0.14em" textAnchor="middle" className={cn(iso.txMuted, iso.mono)}>
                  POWER
                </text>

                {/* Volume, all the way down */}
                <circle cx="176" cy="28" r="16" className={iso.fW} />
                <circle cx="176" cy="28" r="9" className={iso.fBg} />
                <line x1="176" y1="28" x2="167" y2="37" strokeWidth={1.8} />
                <text x="176" y="58" fontSize={4.5} fontWeight={700} letterSpacing="0.14em" textAnchor="middle" className={cn(iso.txMuted, iso.mono)}>
                  VOLUME
                </text>

                <text x="12" y="62" fontSize={5} fontWeight={500} letterSpacing="0.18em" className={cn(iso.txMuted, iso.mono)}>
                  SUB/WAVE · RECEIVER
                </text>
              </>
            }
            right={
              <>
                <circle cx="60" cy="50" r="4" className={iso.fW} />
                <line x1="60" y1="50" x2="60" y2="70" strokeWidth={2.4} className={iso.solid} />
              </>
            }
          />

          {/* The cord, and the plug at its end */}
          <g transform={FLOOR}>
            <path d={CORD} strokeWidth={2.4} className={iso.solid} />
          </g>
          <IsoBox x={272} y={126} z={0} w={18} d={14} h={10} />
          <IsoBox x={290} y={129} z={4} w={9} d={2} h={1.6} outline={false} />
          <IsoBox x={290} y={135} z={4} w={9} d={2} h={1.6} outline={false} />
        </g>

        {/* The inked layer: what's wrong, said plainly. */}
        <g filter="url(#dead-air-wob)" className={iso.ink} strokeWidth={1.6} aria-hidden="true">
          <path d={`M${lcdA.join(' ')}L${lcdB.join(' ')}M${lcdC.join(' ')}L${lcdD.join(' ')}`} />
          <path d={loop(plug[0], plug[1], 30, 20)} />
          <path d={arrow(196, 240, 184, 226, 167, 214)} />
          <text x="176" y="260" fontSize={22} fontWeight={600} className={cn(iso.txAcc, iso.display)}>
            unplugged
          </text>
        </g>
      </svg>
    </div>
  );
}
