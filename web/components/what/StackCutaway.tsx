import { IsoBox, InkFilter } from '../iso/IsoBox';
import { arrow, boxFaces, project, round2, type Pt } from '../iso/geometry';
import iso from '../iso/Iso.module.css';
import { cn } from '@/lib/cn';
import styles from './StackCutaway.module.css';

// FIG. 6 for "Under the Hood": the station as one open box, lid off. Icecast's
// mast stands at the back, the controller and Liquidsoap face each other
// across the shared state/ tray, and the DJ brain sits up front as a chip.
// The flow reads left to right through the files, then up the mast.
//
// The drawing is keyed by numbered balloons, and every word a reader needs
// lives in the HTML key beside it, so it stays readable on a phone. The
// drawing's own lettering (panel legends, the wall stencils, the two ink notes)
// only repeats what the key already says. The ink pens in as the figure
// scrolls into view (where the browser has view timelines), and the mast
// broadcasts, unless lite mode or reduced motion stills it.

/** Interior items, world units. The open box is 260 square. */
const W = 260;
const WALL = 22;
const FLOOR = 10;

const TOWER = { x: 24, y: 24, w: 64, d: 64, h: 92 };
const CTRL = { x: 24, y: 166, w: 72, d: 70, h: 58 };
const MIX = { x: 166, y: 24, w: 70, d: 72, h: 50 };
const CHIP = { x: 172, y: 172, w: 58, d: 58, h: 12 };
const TRAY = { x: 108, y: 108, w: 46, d: 46, h: 7 };

const mastFoot = project(56, 56, FLOOR + TOWER.h);
const mastTip = project(56, 56, FLOOR + TOWER.h + 64);
const dipole = `M${project(42, 56, FLOOR + TOWER.h + 46).join(' ')}L${project(70, 56, FLOOR + TOWER.h + 46).join(' ')}`;

/** Radio waves off the mast tip: three rings each side. */
const wave = (side: 1 | -1, ring: number) => {
  const [cx, cy] = mastTip;
  const r = 16 + ring * 14;
  const a0 = side === 1 ? -0.7 : Math.PI - 0.7;
  const a1 = a0 + 1.4;
  return `M${round2(cx + Math.cos(a0) * r)} ${round2(cy + Math.sin(a0) * r)}A${r} ${r} 0 0 1 ${round2(cx + Math.cos(a1) * r)} ${round2(cy + Math.sin(a1) * r)}`;
};

/** The floor's own plane: world x/y map straight onto it. */
const FLOOR_TOP = boxFaces({ x: 0, y: 0, z: 0, w: W, d: W, h: FLOOR }).T;
const CABLE = 'M168 200C140 198 128 224 96 212';

/** The top face a fresh file lands on, just above the stack in the tray. */
const DROP = boxFaces({ x: 121, y: 116, z: FLOOR + TRAY.h + 4, w: 30, d: 36, h: 0 }).T;

/** Chip pins: five a side, standing on the floor. */
const PIN_OFFSETS = [9, 19, 29, 39, 49];

const ARROWS = {
  toTray: arrow(-62, 74, -34, 62, -16, 96),
  toMix: arrow(18, 96, 36, 60, 58, 66),
  toMast: arrow(116, 22, 98, -18, 62, -10),
};

interface Balloon { id: string; at: Pt; to: Pt }

const BALLOONS: Balloon[] = [
  { id: '1', at: [-196, 6], to: project(48, 200, FLOOR + CTRL.h) },
  { id: '2', at: [34, 270], to: project(214, 214, FLOOR + CHIP.h) },
  { id: '3', at: [-200, 226], to: project(124, 140, FLOOR + TRAY.h + 3) },
  { id: '4', at: [200, 14], to: project(228, 32, FLOOR + MIX.h) },
  { id: '5', at: [-120, -96], to: project(36, 70, FLOOR + TOWER.h) },
];

export const STACK_KEY = [
  { id: '1', name: 'Controller', note: 'Node.js. Decides what plays and what gets said, and writes it down: next.txt, say.txt.' },
  { id: '2', name: 'DJ brain', note: 'The LLM. Picks the tracks, writes the links.' },
  { id: '3', name: 'state/', note: 'One shared folder. The pieces pass plain files, nothing else.' },
  { id: '4', name: 'Liquidsoap', note: 'The mixer. Crossfades, ducks the voice, rotates jingles.' },
  { id: '5', name: 'Icecast', note: 'One stream out, the same for every listener: MP3 always, Opus and FLAC when switched on.' },
] as const;

export default function StackCutaway({ className }: { className?: string }) {
  return (
    <div className={cn(iso.sheet, styles.root, className)}>
      <svg
        viewBox="-236 -176 472 462"
        className="block h-auto w-full overflow-visible"
        role="img"
        aria-label="Cutaway drawing of one open box holding the controller, the DJ brain, a shared state folder, Liquidsoap and Icecast. Arrows run from the brain to the controller, through the folder of files to Liquidsoap, and up to Icecast's antenna."
      >
        <defs>
          <InkFilter id="stack-cutaway-wob" />
        </defs>

        <g className={cn(iso.pen, styles.pen)}>
          {/* The box: floor, back walls, then what sits inside, then the front walls. */}
          <IsoBox x={0} y={0} z={0} w={W} d={W} h={FLOOR} />
          <IsoBox x={0} y={0} z={FLOOR} w={W} d={6} h={WALL} />
          <IsoBox x={0} y={6} z={FLOOR} w={6} d={W - 12} h={WALL} />

          {/* 5 · Icecast, with its mast */}
          <IsoBox
            {...TOWER}
            z={FLOOR}
            left={
              <>
                <rect x="6" y="8" width="52" height="14" className={cn(iso.fInk, iso.ns)} />
                <text x="32" y="18" fontSize={7} fontWeight={700} letterSpacing="0.16em" textAnchor="middle" className={cn(iso.txAcc, iso.mono)}>
                  ON AIR
                </text>
                {['MP3', 'OPUS', 'FLAC'].map((m, i) => (
                  <g key={m}>
                    <circle cx="10" cy={38 + i * 12} r="2.4" strokeWidth={0.6} className={i === 0 ? cn(iso.fAcc, iso.ns) : iso.fBg} />
                    <text x="16" y={40 + i * 12} fontSize={6} fontWeight={700} letterSpacing="0.14em" className={cn(iso.tx, iso.mono)}>
                      {m}
                    </text>
                  </g>
                ))}
                <path d="M8 74H56M8 80H56M8 86H56" strokeWidth={0.4} opacity={0.6} />
              </>
            }
            right={<path d="M10 12H54M10 18H54M10 24H54M10 30H54" strokeWidth={0.5} opacity={0.6} />}
          />
          <line x1={mastFoot[0]} y1={mastFoot[1]} x2={mastTip[0]} y2={mastTip[1]} strokeWidth={1.5} className={iso.solid} />
          <path d={dipole} strokeWidth={1.2} className={iso.solid} />
          <circle cx={mastTip[0]} cy={mastTip[1]} r="3" className={cn(iso.fAcc, iso.ns)} />

          {/* 4 · Liquidsoap: a desk of faders */}
          <IsoBox
            {...MIX}
            z={FLOOR}
            top={
              <>
                {[18, 36, 54].map((y, i) => (
                  <g key={y}>
                    <line x1="10" y1={y} x2="60" y2={y} strokeWidth={1.6} className={iso.solid} />
                    <rect
                      x={[18, 40, 28][i]}
                      y={y - 5}
                      width="8"
                      height="10"
                      className={i === 1 ? cn(iso.fAcc, iso.ns) : iso.fBg}
                    />
                  </g>
                ))}
              </>
            }
            left={
              <>
                <text x="8" y="14" fontSize={6} fontWeight={700} letterSpacing="0.16em" className={cn(iso.tx, iso.mono)}>MIX</text>
                <g className={styles.meter}>
                  {[0, 1, 2, 3, 4, 5].map(i => (
                    <rect key={i} x={30 + i * 6} y="8" width="3.5" height="30" className={cn(iso.fW, iso.ns)} />
                  ))}
                </g>
              </>
            }
          />

          {/* 1 · Controller: a terminal */}
          <IsoBox
            {...CTRL}
            z={FLOOR}
            left={
              <>
                <rect x="6" y="6" width="60" height="26" className={cn(iso.fInk, iso.ns)} />
                <text x="10" y="16" fontSize={6.5} fontWeight={700} className={cn(iso.txBg, iso.mono)}>&gt; next.txt</text>
                <text x="10" y="26" fontSize={6.5} fontWeight={700} className={cn(iso.txBg, iso.mono)}>&gt; say.txt</text>
                <circle cx="10" cy="40" r="2.4" className={cn(iso.fAcc, iso.ns, styles.blink)} />
                <text x="16" y="42" fontSize={6} fontWeight={700} letterSpacing="0.16em" className={cn(iso.tx, iso.mono)}>NODE</text>
              </>
            }
            right={<path d="M10 10H60M10 16H60M10 22H60M10 28H60" strokeWidth={0.5} opacity={0.6} />}
          />

          {/* 3 · state/: a tray of plain files */}
          <IsoBox {...TRAY} z={FLOOR} />
          <IsoBox x={112} y={113} z={FLOOR + TRAY.h} w={30} d={36} h={1} outline={false} />
          <IsoBox x={115} y={110} z={FLOOR + TRAY.h + 1} w={30} d={36} h={1} outline={false} />
          <IsoBox
            x={118}
            y={113}
            z={FLOOR + TRAY.h + 2}
            w={30}
            d={36}
            h={1}
            outline={false}
            top={<path d="M5 8H25M5 13H25M5 18H25M5 23H18" strokeWidth={0.5} />}
          />
          {/* A fresh file dropping in from the controller's side. */}
          <g transform={DROP}>
            <g className={styles.drop}>
              <rect width="30" height="36" className={iso.fBg} />
              <path d="M5 8H25M5 13H20" strokeWidth={0.5} />
            </g>
          </g>

          {/* The brain's ribbon cable, lying on the floor into the controller. */}
          <g transform={FLOOR_TOP}>
            <path d={CABLE} strokeWidth={4} className={iso.solid} />
            <path d={CABLE} strokeWidth={2.2} className={cn(iso.sBg, iso.solid)} />
          </g>

          {/* 2 · DJ brain: a chip on the floor */}
          {PIN_OFFSETS.map(o => (
            <IsoBox key={`b${o}`} x={CHIP.x + o} y={CHIP.y - 6} z={FLOOR} w={4} d={6} h={3} outline={false} />
          ))}
          {PIN_OFFSETS.map(o => (
            <IsoBox key={`l${o}`} x={CHIP.x - 6} y={CHIP.y + o} z={FLOOR} w={6} d={4} h={3} outline={false} />
          ))}
          <IsoBox
            {...CHIP}
            z={FLOOR}
            topFill={iso.fInk}
            top={
              <>
                <rect x="9" y="9" width="40" height="40" strokeWidth={0.6} className={cn(iso.sBg, iso.fNone, iso.solid)} />
                <circle cx="15" cy="15" r="2.2" className={cn(iso.fAcc, iso.ns)} />
                <text x="29" y="33" fontSize={10} fontWeight={700} letterSpacing="0.12em" textAnchor="middle" className={cn(iso.txBg, iso.mono)}>
                  LLM
                </text>
              </>
            }
          />
          {PIN_OFFSETS.map(o => (
            <IsoBox key={`f${o}`} x={CHIP.x + o} y={CHIP.y + CHIP.d} z={FLOOR} w={4} d={6} h={3} outline={false} />
          ))}
          {PIN_OFFSETS.map(o => (
            <IsoBox key={`r${o}`} x={CHIP.x + CHIP.w} y={CHIP.y + o} z={FLOOR} w={6} d={4} h={3} outline={false} />
          ))}

          {/* Front walls last: they hide the feet of everything inside. */}
          <IsoBox
            x={W - 6}
            y={6}
            z={FLOOR}
            w={6}
            d={W - 12}
            h={WALL}
            right={
              <text x="36" y="14.5" fontSize={6} fontWeight={700} letterSpacing="0.2em" className={cn(iso.txMuted, iso.mono)}>
                STREAM · MP3 · OPUS · FLAC
              </text>
            }
          />
          <IsoBox
            x={0}
            y={W - 6}
            z={FLOOR}
            w={W}
            d={6}
            h={WALL}
            left={
              <text x="12" y="14.5" fontSize={6} fontWeight={700} letterSpacing="0.2em" className={cn(iso.txMuted, iso.mono)}>
                SUB/WAVE · ONE BOX · NO CLOUD
              </text>
            }
          />

          {/* Key balloons */}
          {BALLOONS.map(b => (
            <g key={b.id}>
              <line x1={b.at[0]} y1={b.at[1]} x2={b.to[0]} y2={b.to[1]} strokeWidth={0.6} className={iso.solid} />
              <circle cx={b.to[0]} cy={b.to[1]} r="1.8" className={cn(iso.fInk, iso.ns)} />
              <circle cx={b.at[0]} cy={b.at[1]} r="14" strokeWidth={1.2} className={cn(iso.fBg, iso.solid)} />
              <text x={b.at[0]} y={b.at[1] + 5.5} fontSize={15} fontWeight={700} textAnchor="middle" className={cn(iso.tx, iso.mono)}>
                {b.id}
              </text>
            </g>
          ))}
        </g>

        {/* The inked layer: the flow, and the broadcast. */}
        <g filter="url(#stack-cutaway-wob)" className={iso.ink} strokeWidth={1.6} aria-hidden="true">
          {Object.entries(ARROWS).map(([k, d]) => (
            <path key={k} d={d} pathLength={1} className={styles.stroke} />
          ))}
          {([1, -1] as const).flatMap(side =>
            [0, 1, 2].map(ring => (
              <path key={`${side}:${ring}`} d={wave(side, ring)} className={cn(styles.wave, styles[`w${ring}`])} />
            )),
          )}
          <text x="58" y="-112" fontSize={20} fontWeight={600} className={cn(iso.txAcc, iso.display)}>
            one stream out
          </text>
          <text x="-180" y="232" fontSize={18} fontWeight={600} className={cn(iso.txAcc, iso.display)}>
            just files
          </text>
        </g>
      </svg>
    </div>
  );
}
