'use client';

import { IsoBox } from '../iso/IsoBox';
import { hatchStrip } from '../iso/geometry';
import iso from '../iso/Iso.module.css';
import { cn } from '@/lib/cn';
import styles from './AdminLoading.module.css';

// This script is part of the server HTML: it must work when client chunks never load.
const BOOT_GUARD = `(() => {
  const root = document.getElementById('admin-starting');
  setTimeout(() => {
    if (!root || !root.isConnected) return;
    const loading = root.querySelector('[data-admin-loading]');
    const error = root.querySelector('[data-admin-load-error]');
    if (loading) loading.hidden = true;
    if (error) error.hidden = false;
  }, 15000);
})()`;

export function AdminLoading({ href }: { href: string }) {
  return (
    <div id="admin-starting" className="admin-root paper flex min-h-screen items-center justify-center p-7">
      <div data-admin-loading suppressHydrationWarning className="grid justify-items-center gap-3">
        <LoadingConsole />
        <span className="caption">loading…</span>
      </div>
      <div data-admin-load-error hidden suppressHydrationWarning className="grid max-w-md gap-3">
        <p role="alert" className="text-destructive">The admin console could not start.</p>
        <p>Startup did not finish. Check your connection and reload this page.</p>
        <a href={href} className="underline">Reload page</a>
      </div>
      <noscript>This console needs JavaScript. Enable it and reload this page.</noscript>
      <script dangerouslySetInnerHTML={{ __html: BOOT_GUARD }} />
    </div>
  );
}

/** The control desk, drawn while the console starts: a fader desk with its
 *  monitor, inking in and out. Plain SVG and CSS, so it draws from the server
 *  HTML before (or without) any client chunk. */
function LoadingConsole() {
  return (
    <svg viewBox="-100 -96 200 150" className={cn(iso.sheet, 'block w-[180px] overflow-visible')} aria-hidden="true">
      <g className={cn(iso.pen, iso.penOff, styles.pen)}>
        <path d={hatchStrip(70, 88, -26, 30, 6)} strokeWidth={0.5} opacity={0.6} className={iso.solid} />
        <IsoBox
          x={-70}
          y={-30}
          z={0}
          w={140}
          d={60}
          h={22}
          top={
            <>
              {[0, 1, 2, 3, 4].map(i => (
                <g key={i}>
                  <line x1={60 + i * 14} y1="14" x2={60 + i * 14} y2="50" strokeWidth={1.4} className={iso.solid} />
                  <rect x={56 + i * 14} y={[30, 20, 36, 24, 32][i]} width="8" height="6" className={i === 2 ? cn(iso.fAcc, iso.ns) : iso.fBg} />
                </g>
              ))}
              {[16, 34].map(cy => (
                <circle key={cy} cx="26" cy={cy} r="6" className={iso.fW} />
              ))}
            </>
          }
        />
        <IsoBox
          x={-46}
          y={-30}
          z={22}
          w={92}
          d={8}
          h={46}
          left={
            <>
              <rect x="6" y="6" width="80" height="30" className={cn(iso.fInk, iso.ns)} />
              <text x="12" y="19" fontSize={7} fontWeight={700} letterSpacing="0.14em" className={cn(iso.txBg, iso.mono)}>
                SUB/WAVE
              </text>
              <rect x="12" y="24" width="5" height="7" className={cn(iso.fAcc, iso.ns, styles.cursor)} />
            </>
          }
        />
      </g>
    </svg>
  );
}
