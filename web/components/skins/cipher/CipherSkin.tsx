'use client';

// CIPHER-3 — the player as a rotor cipher machine. The key is the power
// switch, rotor I is the volume, and the lampboard spells the song one letter
// per beat (or the DJ's words as they air). Typing on the machine's keys, or
// the real keyboard, writes a request: each letter steps the rotors and lights
// its enciphered bulb, and SEND hands the plain text to the booth.
// It is built in Unit SW-9's hardware — a brushed plate, dark top-lit keys, a
// weighted knob, display glass — with every depth on it receding down one 30°
// axis (Cipher.module.css says how). Desktop and phone are two trees: the
// server renders both and CSS shows the right one, so first paint is right
// without a JS media query; once hydrated only the visible tree stays mounted
// (useDeskLayout), as the hidden one doubled the work of every render, the
// clock's included. Each machine is drawn at a fixed size and scaled to its box.
// Nothing here ticks: the ambient clock's state is read by the parts that show
// it (useCipherMachine), and the track clock by TapeProgress.

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { ArrowUpRight, CornerDownLeft, Delete, Heart, Play } from 'lucide-react';
import styles from './Cipher.module.css';
import {
  BlockKey,
  KeyRows,
  Lampboard,
  MachineRotor,
  Panel,
  PowerKey,
  Rotor,
  RotorReadout,
  Screws,
  TapeChars,
  TapeTyped,
  type KeyHandlers,
} from './CipherParts';
import {
  MSG_MAX,
  VOL_STOPS,
  beatMs,
  groups,
  keyToChar,
  lampSequence,
  stopToVol,
  typingMs,
  volToStop,
} from './cipher';
import type { MachineStore } from './machineStore';
import { useCipherMachine, useMachine, type Ambient } from './useCipherMachine';
import {
  usePlayerActions,
  usePlayerAudio,
  usePlayerFeed,
} from '@/components/player/PlayerCore';
import { useTuneInGate } from '@/components/player/useTuneInGate';
import ThemeSwitcher from '@/components/ThemeSwitcher';
import { useDynamicStyle } from '@/hooks/useDynamicStyle';
import { useElapsed } from '@/hooks/useElapsed';
import { cn } from '@/lib/cn';
import { fmtTime } from '@/lib/format';
import {
  contextLine,
  isPowered,
  lastVoiceLine,
  listenPhase,
  listenerCountOf,
  progressRatio,
  speechMs,
  stationIdentity,
  trackMeta,
  tuningStatus,
} from '../shared';
import { CAP_CENTRE, CAP_CENTRE_16 } from '../capCentre';
import { useDjOnAir, useRequestSlip, useSkinCalm, useTrackLike, type RequestOutcome } from '../sharedHooks';
import type { SkinProps } from '../types';

type TapeMode = 'offline' | 'compose' | 'sent' | 'talk' | 'music';

const OFFLINE_COPY = 'Nothing is on the stream right now. Power is disabled until the station comes back.';
// How the note on the wire ended: the eyebrow, and the tape's footnote.
const SENT_EYEBROW: Record<RequestOutcome, string> = {
  sent: 'sent · enciphered',
  refused: 'returned',
  failed: 'line down · not sent',
};
const SENT_FOOT: Record<'refused' | 'failed', string> = {
  refused: 'returned by the booth · ask for another',
  failed: 'not delivered · type it again',
};
// A sent note stays on the tape this long after the booth's last word on it.
const SENT_HOLD_MS = 9000;
// Below this scale a phone's keys drop under a fingertip, so the machine
// gives up its lampboard instead.
const COMPACT_BELOW = 0.7;

// Each box is the plate plus the chassis's depth, which shows down the 30°
// axis to its right and below it.
interface FitSize { w: number; h: number; max: number; compactH?: number }
const DESK: FitSize = { w: 1376, h: 800, max: 1.1 };
const MOB: FitSize = { w: 375, h: 522, compactH: 396, max: 1.6 };

/** A fixed-size drawing scaled to fit its parent, centred. It stays hidden
 *  (CSS) until the first fit lands. A component rather than a hook on a ref,
 *  so a tree that mounts later (a phone turned past lg) fits when it does. */
function Fit({ size, className, children }: { size: FitSize; className: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const box = el?.parentElement;
    if (!el || !box) return;
    const { w, h, max, compactH } = size;
    const fit = () => {
      const bw = box.clientWidth;
      const bh = box.clientHeight;
      // Until hydration both trees mount and the other one is display:none;
      // it fits when it shows.
      if (!bw || !bh) return;
      const compact = compactH != null && Math.min(max, bw / w, bh / h) < COMPACT_BELOW;
      el.toggleAttribute('data-compact', compact);
      const H = compact && compactH != null ? compactH : h;
      const s = Math.min(max, bw / w, bh / H);
      el.style.transform = `translate(${((bw - w * s) / 2).toFixed(1)}px,${((bh - H * s) / 2).toFixed(1)}px) scale(${s.toFixed(4)})`;
      el.setAttribute('data-fit', '');
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(box);
    return () => ro.disconnect();
  }, [size]);
  return <div ref={ref} className={cn(styles.fit, className)}>{children}</div>;
}

/** Tailwind's lg, where the desk machine takes over from the phone's. */
const DESKTOP = '(min-width: 64rem)';
function watchDesk(onChange: () => void) {
  const mq = window.matchMedia(DESKTOP);
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}
/** Which machine shows: null on the server and through hydration, so both
 *  trees render and CSS picks; after that, the client's answer. */
function useDeskLayout(): boolean | null {
  return useSyncExternalStore(watchDesk, () => window.matchMedia(DESKTOP).matches, () => null);
}

function isTextEntry(el: Element): boolean {
  return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || (el instanceof HTMLElement && el.isContentEditable);
}

export default function CipherSkin({ contained }: SkinProps) {
  const { nowPlaying, context, dj, activeShow, listeners, session, trackStartedAt } = usePlayerFeed();
  const { tunedIn, status, volume, muted, offline, signal } = usePlayerAudio();
  const { toggleMute, setVolume } = usePlayerActions();
  const { showOverlay, tuneInFromOverlay, handleTune } = useTuneInGate();

  const listenerCount = listenerCountOf(listeners);
  const { stationName, djName, showName } = stationIdentity(dj, activeShow, context);
  const meta = trackMeta(nowPlaying);
  const voice = lastVoiceLine(session.messages);
  const onMic = useDjOnAir();
  const like = useTrackLike();

  const calm = useSkinCalm();

  const phase = listenPhase({ offline, tunedIn, status });
  const live = phase === 'live';
  const talking = live && onMic && !!voice && !muted;

  const slip = useRequestSlip({
    sent: `${djName} has your note.`,
    refused: 'The booth sent this one back.',
    failed: 'The line is down — the note never left. Try again in a moment.',
  });
  // The cipher groups of the note on the wire, while the tape shows it.
  const [sent, setSent] = useState<string | null>(null);

  const title = nowPlaying?.title ?? '';
  const artist = (nowPlaying?.artist ?? '').toUpperCase();
  const { seq, artistAt } = useMemo(() => lampSequence(title, artist), [title, artist]);
  const talkText = talking && voice ? voice.text : '';
  const vol = volToStop(volume);

  const ambient: Ambient = phase === 'connecting'
    ? 'connecting'
    : live && !muted && sent == null
      ? (talking ? 'talk' : 'music')
      : 'off';
  const machine = useCipherMachine({
    ambient,
    calm,
    vol,
    seq,
    beat: beatMs(nowPlaying?.bpm),
    anchor: trackStartedAt,
    talk: talkText,
    talkMs: typingMs(Array.from(talkText).length, speechMs(talkText)),
  });
  const { store, plain } = machine;

  const composing = !offline && plain.length > 0;
  const mode: TapeMode = offline
    ? 'offline'
    : composing
      ? 'compose'
      : sent != null && live
        ? 'sent'
        : talking
          ? 'talk'
          : 'music';

  // Let a sent note go once the booth has had its say and a beat has passed;
  // an upgraded answer (the resolved pick) restarts the wait.
  const { sending: slipSending, ack: slipAck, reset: resetSlip } = slip;
  useEffect(() => {
    if (sent == null || slipSending) return;
    const id = window.setTimeout(() => {
      setSent(null);
      resetSlip();
    }, SENT_HOLD_MS);
    return () => window.clearTimeout(id);
  }, [sent, slipSending, slipAck, resetSlip]);

  const pressKey = (ch: string, hold?: boolean) => {
    if (!live) return;
    if (sent != null && ch !== ' ') {
      setSent(null);
      slip.reset();
    }
    machine.press(ch, hold);
  };
  const send = () => {
    const text = plain.trim();
    if (!live || !text || slip.sending) return;
    setSent(groups(machine.cipher));
    machine.clear();
    void slip.send(text);
  };
  // Stable, so the memoised rotor I re-renders only when the volume moves.
  const setVol = useCallback(
    (x: number) => setVolume(stopToVol(Math.min(VOL_STOPS, Math.max(0, x)))),
    [setVolume],
  );
  const onPower = () => {
    if (offline) return;
    // Turning the key off clears the tape, as pulling the plug would.
    if (tunedIn) machine.clear();
    handleTune();
  };

  // Event handlers outlive renders (window listeners, memoised keys), so they
  // read the latest closures from here.
  const forHandlers = {
    pressKey, send, release: machine.release, del: machine.del, clear: machine.clear, setVol, onPower,
    phase, vol, store, plain,
  };
  const latest = useRef(forHandlers);
  useEffect(() => {
    latest.current = forHandlers;
  });
  const keyHandlers = useMemo<KeyHandlers>(() => ({
    hold: c => latest.current.pressKey(c, true),
    tap: c => latest.current.pressKey(c),
    release: () => latest.current.release(),
  }), []);

  // The real keyboard types on the machine. Capture phase, so a typed S or T
  // reaches the tape before the shell's skin/theme shortcuts can act on it.
  // In a showcase frame it only listens once the visitor has clicked or tapped
  // inside it, so the host page keeps its keys (Space still scrolls).
  const rootRef = useRef<HTMLDivElement | null>(null);
  const engaged = useRef(!contained);
  useEffect(() => {
    if (!contained) return;
    const onPointer = (e: PointerEvent) => {
      engaged.current = e.target instanceof Node && !!rootRef.current?.contains(e.target);
    };
    document.addEventListener('pointerdown', onPointer, true);
    return () => document.removeEventListener('pointerdown', onPointer, true);
  }, [contained]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!engaged.current || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target instanceof Element ? e.target : null;
      if (t && (isTextEntry(t) || t.closest('[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]'))) return;
      // Space, Enter and arrows belong to a focused control (MUTE, a rotor,
      // the theme button); only the drawn letter keys hand them back.
      const onControl = !!t?.closest('button,a[href],[role="slider"],[role="button"]') && !t?.closest('[data-cipher-key]');
      const L = latest.current;
      const k = e.key;
      if (L.phase === 'standby') {
        if (!onControl && (k === 'Enter' || k === ' ')) {
          e.preventDefault();
          L.onPower();
        }
        return;
      }
      const ch = keyToChar(k);
      // Tuned in, the letter keys belong to the machine even while the stream
      // is still locking, so S and T never fall through to the shell's skin
      // and theme shortcuts. They only type once it is live.
      if (L.phase === 'connecting') {
        if (ch) e.preventDefault();
        return;
      }
      if (L.phase !== 'live') return;
      if (ch || (k === ' ' && !onControl)) {
        e.preventDefault();
        if (!e.repeat) L.pressKey(ch ?? ' ', true);
      } else if (k === 'Backspace') {
        e.preventDefault();
        L.del();
      } else if (k === 'Enter' && !onControl) {
        e.preventDefault();
        L.send();
      } else if (k === 'Escape' && L.plain) {
        e.preventDefault();
        L.clear();
      } else if ((k === 'ArrowUp' || k === 'ArrowDown') && !onControl) {
        e.preventDefault();
        L.setVol(L.vol + (k === 'ArrowUp' ? 1 : -1));
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const d = latest.current.store.get().down;
      if (d && (e.key === ' ' ? d === 'SPACE' : keyToChar(e.key) === d)) latest.current.release();
    };
    // A key held while the window loses focus never sees its keyup.
    const onBlur = () => { if (latest.current.store.get().down) latest.current.release(); };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  const desk = useDeskLayout();

  // ── Words ──────────────────────────────────────────────────────────
  const gate = showOverlay && !offline;
  const powered = isPowered(phase);
  const keyText = <RotorReadout store={store} vol={vol} />;
  const eyebrow = offline
    ? 'off air'
    : phase === 'standby'
      ? 'standby · turn the key to tune in'
      : phase === 'connecting'
        ? 'tuning in…'
        : mode === 'compose'
          ? `outgoing · to ${djName}`
          : mode === 'sent'
            ? (slip.sending || !slip.outcome ? 'sending · enciphered' : SENT_EYEBROW[slip.outcome])
            : mode === 'talk'
              ? `${djName} · on air`
              : muted
                ? 'receiving · muted'
                : `receiving · ${showName || 'on air'}`;
  const eyebrowR = mode === 'compose'
    ? `${plain.length} / ${MSG_MAX}`
    : phase === 'connecting'
      ? 'rotors searching'
      : mode === 'talk'
        ? 'live mic'
        : mode === 'offline' || mode === 'sent'
          ? ''
          : meta.facts.slice(0, 2).join(' · ');
  const statusText = tuningStatus(phase, muted);
  const powerLabel = offline ? 'locked · off air' : phase === 'connecting' ? 'on · searching' : live ? 'on · locked' : 'off';
  const powerShort = offline ? 'locked' : phase === 'connecting' ? 'search' : live ? 'on' : 'off';
  const sub = [nowPlaying?.album, nowPlaying?.year].filter(Boolean).join(' · ');
  const nowLine = [nowPlaying?.title, nowPlaying?.artist].filter(Boolean).join(' — ');
  const sentLine = slip.sending ? `On the wire to ${djName}…` : (slip.ack ?? `${djName} has your note.`);

  const tape: Omit<TapeProps, 'variant'> = {
    mode, eyebrow, eyebrowR, keyText, store,
    song: {
      title: title || 'Scanning the dial…', artist, artistAt, sub, nowLine,
      startedAt: trackStartedAt, duration: nowPlaying?.duration,
    },
    talk: talkText,
    compose: { plain, cipher: groups(machine.cipher) },
    sent: { line: sentLine, cipher: sent ?? '', outcome: slip.sending ? null : slip.outcome },
  };

  const rotorI = (
    <Rotor name="I · vol" label="Volume" value={vol} max={VOL_STOPS} accent onChange={setVol} />
  );
  const rotorII = <MachineRotor store={store} which="middle" name="II" label="Rotor II" onTurn={machine.turn} />;
  const rotorIII = <MachineRotor store={store} which="right" name="III" label="Rotor III" onTurn={machine.turn} />;
  const likeFace = like.available ? `${like.count}` : '—';
  const canLike = like.available && !like.liked && !like.pending;
  const hasMsg = composing && plain.trim().length > 0;

  const statusDot = (
    <span className={cn('flex items-center gap-2 font-bold whitespace-nowrap', powered ? 'text-vermilion' : 'text-muted')}>
      <span className={cn('size-2 rounded-full', powered ? 'bg-vermilion' : 'border border-muted')} />
      {statusText}
    </span>
  );
  const listenerTag = listenerCount != null && (
    <span className="flex items-center gap-1.5 text-muted">
      <svg viewBox="0 0 24 24" className="size-3.5 fill-none stroke-current" strokeWidth={2} aria-hidden="true">
        <path d="M4 14v-2a8 8 0 0 1 16 0v2" strokeLinecap="round" />
        <rect x="2.5" y="13" width="4" height="7.5" rx="1.5" />
        <rect x="17.5" y="13" width="4" height="7.5" rx="1.5" />
      </svg>
      {listenerCount}
      <span className="sr-only">listening</span>
    </span>
  );
  const gateButton = gate && (
    <button
      type="button"
      aria-label="Tune in"
      onClick={tuneInFromOverlay}
      className="absolute inset-0 z-10 cursor-pointer border-0 bg-transparent p-0"
    />
  );

  return (
    <div
      ref={rootRef}
      className={cn(styles.root, !powered && styles.dim, 'absolute inset-0 overflow-hidden bg-bg font-sans text-ink select-none')}
    >
      <p className="sr-only">
        Type on your keyboard to write a request to {djName}. Enter sends it, Escape clears it.
      </p>
      <p className="sr-only" aria-live="polite">{mode === 'sent' ? sentLine : ''}</p>

      {/* ── Desktop ─────────────────────────────────────────────── */}
      {desk !== false && (
        <div className="absolute inset-0 hidden flex-col lg:flex">
          <div className="flex flex-none items-center justify-between gap-6 border-b border-ink px-8 py-1.5">
            <div className="flex min-w-0 items-baseline gap-3.5">
              <span className="flex-none font-display text-[22px] font-extrabold tracking-[0.02em]">{stationName.toUpperCase()}</span>
              <span className="min-w-0 truncate font-mono text-[10px] tracking-[0.24em] text-muted uppercase">
                cipher-3 · type a request · rotor I sets volume
              </span>
            </div>
            {/* One baseline for the run; the icons sit on its cap centre. */}
            <div className="flex min-w-0 shrink items-baseline gap-3 font-mono text-[11px]">
              <div className="flex min-w-0 items-baseline gap-3 tracking-[0.16em] uppercase">
                {showName && (
                  <span className="flex min-w-0 items-baseline gap-1.5">
                    <Play className={cn('size-2.5 flex-none fill-current', CAP_CENTRE)} />
                    <span className="max-w-[18vw] truncate">{showName}</span>
                  </span>
                )}
                <span className="whitespace-nowrap text-vermilion">with {djName}</span>
                {contextLine(context) && (
                  <span className="max-w-[22vw] truncate border-l border-soft-border pl-3 text-muted">{contextLine(context)}</span>
                )}
              </div>
              <ThemeSwitcher className={CAP_CENTRE_16} />
            </div>
          </div>

          <div className={cn('relative min-h-0 flex-1', styles.gridDesk)}>
            <div className="absolute inset-x-6 inset-y-4">
              <Fit size={DESK} className={cn(styles.desk, 'w-[1360px]')}>
                <div
                  className={cn(
                    styles.chassis,
                    'relative grid h-[788px] w-[1360px] grid-cols-[164px_minmax(0,1fr)_164px] grid-rows-[200px_214px_minmax(0,1fr)] gap-3.5 p-5',
                  )}
                >
                  <Screws />

                  <Panel label="Power" className="flex flex-col items-center justify-center gap-1.5">
                    <PowerKey
                      on={tunedIn}
                      gate={phase === 'standby'}
                      disabled={offline}
                      label="Power"
                      onPress={onPower}
                    />
                    <span
                      className={cn(
                        'font-mono text-[10px] font-bold tracking-[0.18em] uppercase',
                        gate ? 'text-vermilion' : 'text-muted',
                      )}
                    >
                      {gate ? 'turn to tune in' : powerLabel}
                    </span>
                  </Panel>

                  <div className="col-span-2 flex min-w-0 gap-3.5">
                    <Panel label="Rotors · I sets volume" className="flex w-[440px] flex-none items-center justify-around px-2.5 pt-2">
                      {rotorI}
                      {rotorII}
                      {rotorIII}
                    </Panel>
                    <Panel label="Tape" className={cn(styles.glassBay, 'min-w-0 flex-1 px-[26px] pt-[22px] pb-[18px]')}>
                      <span className={cn(styles.sprockets, 'absolute inset-x-3.5 top-2 h-1')} aria-hidden="true" />
                      <span className={cn(styles.sprockets, 'absolute inset-x-3.5 bottom-1.5 h-1')} aria-hidden="true" />
                      <Tape {...tape} variant="desk" />
                    </Panel>
                  </div>

                  <Panel label="Mute" className="flex flex-col items-center justify-center">
                    <BlockKey
                      aria-label="Mute"
                      aria-pressed={muted}
                      latched={muted}
                      lit={muted}
                      onClick={toggleMute}
                      className="h-[92px] w-[112px] [--drop:8px]"
                    >
                      <span className="flex flex-col items-center gap-[7px] font-mono">
                        <span className="text-[18px] leading-none font-bold tracking-[0.14em]">{muted ? 'MUTED' : 'MUTE'}</span>
                        <span className={cn('text-[10px] leading-none tracking-[0.14em] uppercase', !muted && 'text-muted')}>
                          {muted ? 'tap for sound' : 'sound on'}
                        </span>
                      </span>
                    </BlockKey>
                  </Panel>

                  <Panel label="Lampboard" className={cn(styles.glassBay, 'flex flex-col items-center justify-center')}>
                    <Lampboard store={store} />
                  </Panel>

                  <Panel label="Like" className="flex flex-col items-center justify-center">
                    <BlockKey
                      aria-label={like.liked ? 'Liked' : 'Like this track'}
                      aria-pressed={like.liked}
                      latched={like.liked}
                      lit={like.liked}
                      dead={!like.available}
                      disabled={!canLike}
                      onClick={() => void like.like()}
                      className="h-[92px] w-[112px] [--drop:8px]"
                    >
                      <span className="flex flex-col items-center gap-1.5">
                        <Heart className={cn('size-7', like.liked && 'fill-current')} />
                        <span className="font-mono text-[13px] leading-none font-bold tracking-[0.14em]">{likeFace}</span>
                      </span>
                    </BlockKey>
                  </Panel>

                  <Panel label="Edit" className="flex flex-col items-center justify-center gap-4">
                    <BlockKey
                      aria-label="Delete last letter"
                      dead={!composing}
                      disabled={!composing}
                      onClick={machine.del}
                      className="h-[63px] w-[112px] [--drop:7px]"
                    >
                      <span className="flex items-center gap-2 font-mono text-[13px] leading-none font-bold tracking-[0.16em]">
                        <Delete className="size-4" />
                        DEL
                      </span>
                    </BlockKey>
                    <BlockKey
                      aria-label="Clear message"
                      dead={!composing}
                      disabled={!composing}
                      onClick={machine.clear}
                      className="h-[63px] w-[112px] [--drop:7px]"
                    >
                      <span className="font-mono text-[13px] leading-none font-bold tracking-[0.16em]">CLEAR</span>
                    </BlockKey>
                    <span className="font-mono text-[9px] tracking-[0.2em] whitespace-nowrap text-muted uppercase">backspace · esc</span>
                  </Panel>

                  <Panel label="Keyboard · type a request" className={cn(styles.wellBay, 'flex flex-col items-center justify-center gap-2')}>
                    <div className="flex flex-col">
                      <KeyRows store={store} keys={keyHandlers} />
                    </div>
                    <SpaceBar
                      store={store}
                      keys={keyHandlers}
                      className="mt-1 h-[42px] w-[416px] [--drop:6px]"
                      label="text-[11px] tracking-[0.32em]"
                    />
                  </Panel>

                  <Panel label="Send" className="flex flex-col items-center justify-center gap-3.5">
                    <BlockKey
                      aria-label={`Send request to ${djName}`}
                      lit={hasMsg}
                      dead={!hasMsg}
                      disabled={!hasMsg}
                      onClick={send}
                      className="h-[136px] w-[120px] [--drop:8px]"
                    >
                      {hasMsg ? (
                        <span className="flex flex-col items-center gap-2.5">
                          <span className="font-mono text-[20px] leading-none font-bold tracking-[0.16em]">SEND</span>
                          <ArrowUpRight className="size-6" />
                          <span className="max-w-[104px] truncate font-mono text-[10px] leading-none font-semibold tracking-[0.16em] uppercase">
                            to {djName}
                          </span>
                        </span>
                      ) : (
                        <span className="flex flex-col items-center gap-2.5 text-center">
                          <span className="font-mono text-[20px] leading-none font-bold tracking-[0.16em]">SEND</span>
                          <span className="font-mono text-[10px] leading-normal tracking-[0.14em] uppercase">type a<br />request first</span>
                        </span>
                      )}
                    </BlockKey>
                    <span className="flex items-center gap-1.5 font-mono text-[9px] tracking-[0.2em] whitespace-nowrap text-muted uppercase">
                      enter
                      <CornerDownLeft className="size-3" />
                    </span>
                  </Panel>
                </div>
              </Fit>
            </div>
            {gateButton}
          </div>

          <div className="flex flex-none items-center gap-4 border-t border-ink bg-field px-6 py-3 font-mono text-[10px] tracking-[0.16em] uppercase">
            {statusDot}
            {listenerTag && <span className="border-l border-soft-border pl-4">{listenerTag}</span>}
            {live && signal.latencyMs != null && (
              <span className="whitespace-nowrap text-muted">sig {signal.latencyMs} ms · {signal.quality}</span>
            )}
            <span className="ml-auto whitespace-nowrap text-muted">{keyText}</span>
          </div>
        </div>
      )}

      {/* ── Phone and tablet ────────────────────────────────────── */}
      {desk !== true && (
        <div className="absolute inset-0 flex flex-col lg:hidden">
          <div className="flex flex-none items-center gap-3 border-b border-ink py-1 pr-2 pl-4">
            <span className="max-w-[60%] flex-none truncate font-display text-[18px] font-extrabold tracking-[0.02em]">
              {stationName.toUpperCase()}
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-[10px] tracking-[0.16em] text-muted uppercase">
              {showName && <><Play className="inline size-2 fill-current align-[calc(0.5cap-4px)]" /> {showName} · </>}
              <span className="text-vermilion">with {djName}</span>
            </span>
            <ThemeSwitcher />
          </div>

          {/* Upright, the tape sits over the machine. A phone turned sideways
              puts it beside the machine instead, where stacking would shrink
              the keys to nothing. */}
          <div className="relative flex min-h-0 flex-1 flex-col landscape:flex-row">
            <div className="flex h-[124px] flex-none flex-col gap-1.5 overflow-hidden border-b border-ink px-4 pt-1.5 pb-2 landscape:h-auto landscape:w-[40%] landscape:border-r landscape:border-b-0">
              <div className="flex items-center gap-2">
                <span className={cn('min-w-0 flex-1 truncate font-mono text-[10px] font-bold tracking-[0.2em] uppercase', offline ? 'text-muted' : 'text-vermilion')}>
                  {eyebrow}
                </span>
                <BlockKey
                  aria-label="Mute"
                  aria-pressed={muted}
                  lit={muted}
                  onClick={toggleMute}
                  className="h-9 w-[60px] flex-none [--drop:0px]"
                >
                  <span className="font-mono text-[10px] leading-none font-bold tracking-[0.12em]">{muted ? 'MUTED' : 'MUTE'}</span>
                </BlockKey>
                <BlockKey
                  aria-label={like.liked ? 'Liked' : 'Like this track'}
                  aria-pressed={like.liked}
                  lit={like.liked}
                  dead={!like.available}
                  disabled={!canLike}
                  onClick={() => void like.like()}
                  className="h-9 w-[60px] flex-none [--drop:0px]"
                >
                  <span className="flex items-center gap-1.5 font-mono text-[11px] leading-none font-bold tracking-[0.08em]">
                    <Heart className={cn('size-3.5', like.liked && 'fill-current')} />
                    {likeFace}
                  </span>
                </BlockKey>
              </div>
              <Tape {...tape} variant="strip" />
            </div>

            <div className={cn('relative min-h-0 flex-1', styles.gridMob)}>
              <div className="absolute inset-x-3 inset-y-2.5 landscape:inset-y-1.5">
                <Fit size={MOB} className={cn(styles.mob, 'w-[366px]')}>
                  <div className={cn(styles.chassis, styles.mobBody, 'flex w-[366px] flex-col gap-3.5 px-2.5 pt-3.5 pb-2.5')}>
                    <div className="flex h-[150px] flex-none gap-1.5">
                      <Panel label="Power" className="flex w-[70px] flex-none flex-col items-center justify-center gap-2">
                        <PowerKey
                          compact
                          on={tunedIn}
                          gate={phase === 'standby'}
                          disabled={offline}
                          label="Power"
                          onPress={onPower}
                        />
                        <span
                          className={cn(
                            'text-center font-mono text-[8px] leading-[1.3] font-bold tracking-[0.14em] uppercase',
                            gate ? 'text-vermilion' : 'text-muted',
                          )}
                        >
                          {gate ? <>turn to<br />tune in</> : powerShort}
                        </span>
                      </Panel>
                      <Panel label="Rotors · I = vol" className="flex min-w-0 flex-1 items-center justify-around pt-1.5">
                        {rotorI}
                        {rotorII}
                        {rotorIII}
                      </Panel>
                    </div>

                    <Panel label="Lamps" className={cn(styles.lampBay, styles.glassBay, 'flex h-[112px] flex-none flex-col items-center justify-center')}>
                      <Lampboard store={store} />
                    </Panel>

                    <Panel label="Keys · type a request" className={cn(styles.wellBay, 'flex min-h-0 flex-1 flex-col items-center justify-center')}>
                      <div className="flex flex-col">
                        <KeyRows store={store} keys={keyHandlers} />
                      </div>
                      <div className="mt-1.5 flex w-[333px] gap-1.5">
                        <BlockKey
                          aria-label="Delete last letter"
                          dead={!composing}
                          disabled={!composing}
                          onClick={machine.del}
                          className="h-[42px] w-[52px] flex-none [--drop:4px]"
                        >
                          <Delete className="size-4" />
                        </BlockKey>
                        <BlockKey
                          aria-label="Clear message"
                          dead={!composing}
                          disabled={!composing}
                          onClick={machine.clear}
                          className="h-[42px] w-[52px] flex-none [--drop:4px]"
                        >
                          <span className="font-mono text-[9px] leading-none font-bold tracking-[0.12em]">CLR</span>
                        </BlockKey>
                        <SpaceBar
                          store={store}
                          keys={keyHandlers}
                          className="h-[42px] min-w-0 flex-1 [--drop:4px]"
                          label="text-[9px] tracking-[0.28em]"
                        />
                        <BlockKey
                          aria-label={`Send request to ${djName}`}
                          lit={hasMsg}
                          dead={!hasMsg}
                          disabled={!hasMsg}
                          onClick={send}
                          className="h-[42px] w-[88px] flex-none [--drop:4px]"
                        >
                          <span className="flex items-center gap-1 font-mono text-[11px] leading-none font-bold tracking-[0.14em]">
                            SEND
                            {hasMsg && <ArrowUpRight className="size-3.5" />}
                          </span>
                        </BlockKey>
                      </div>
                    </Panel>
                  </div>
                </Fit>
              </div>
            </div>
            {gateButton}
          </div>

          {/* A phone on its side under 360px tall gives the status bar's
              height to the machine; the tape's eyebrow still says the state. */}
          <div className="flex flex-none items-center gap-3.5 border-t border-ink bg-field px-4 py-2 font-mono text-[10px] tracking-[0.16em] uppercase [@media(orientation:landscape)_and_(max-height:359px)]:hidden">
            {statusDot}
            {listenerTag}
            <span className="ml-auto whitespace-nowrap text-muted">{keyText}</span>
          </div>
        </div>
      )}
    </div>
  );
}

/** The space bar: a block key that types like a letter key. */
function SpaceBar({
  store,
  keys,
  className,
  label,
}: {
  store: MachineStore;
  keys: KeyHandlers;
  className: string;
  label: string;
}) {
  const down = useMachine(store, s => s.down === 'SPACE');
  return (
    <BlockKey
      aria-label="Space"
      tabIndex={-1}
      data-cipher-key=""
      down={down}
      onPointerDown={e => {
        if (e.button > 0) return;
        e.currentTarget.setPointerCapture?.(e.pointerId);
        keys.hold(' ');
      }}
      onPointerUp={keys.release}
      onPointerCancel={keys.release}
      onLostPointerCapture={keys.release}
      onClick={e => { if (e.detail === 0) keys.tap(' '); }}
      className={cn('touch-manipulation', className)}
    >
      <span className={cn('font-mono leading-none font-bold', label)}>SPACE</span>
    </BlockKey>
  );
}

/** The song as the tape prints it while it plays. */
interface TapeSong {
  title: string;
  /** Upper-cased, as the lampboard spells it. */
  artist: string;
  /** Where the artist starts in the lampboard sequence. */
  artistAt: number;
  /** Album · year. */
  sub: string;
  /** "Title — Artist", under the DJ's words. */
  nowLine: string;
  /** When it started (epoch ms), for the tape's clock. */
  startedAt: number | null;
  duration: number | undefined;
}

interface TapeProps {
  variant: 'desk' | 'strip';
  mode: TapeMode;
  eyebrow: string;
  eyebrowR: string;
  /** The rotor readout, e.g. "rotors 18 · K · Q". */
  keyText: ReactNode;
  /** Where the spelling and the typing are read. */
  store: MachineStore;
  song: TapeSong;
  /** The DJ's line, typed out as it airs. */
  talk: string;
  /** The listener's message: plain text, and its cipher in groups. */
  compose: { plain: string; cipher: string };
  /** The note on the wire: the booth's line, its cipher groups, and how it
   *  ended (null while it is still sending). */
  sent: { line: string; cipher: string; outcome: RequestOutcome | null };
}

/** Title sizes that keep a long name inside the tape: [size, lines]. */
function titleFit(len: number, variant: TapeProps['variant']): string {
  if (variant === 'desk') {
    if (len <= 18) return 'text-[54px] line-clamp-1';
    if (len <= 26) return 'text-[42px] line-clamp-1';
    return 'text-[32px] line-clamp-2';
  }
  // Upright, the strip is one line high; sideways, the tape is a tall
  // column with lines to spare.
  if (len <= 18) return 'text-[24px] line-clamp-1 landscape:line-clamp-3';
  return 'text-[19px] line-clamp-1 landscape:line-clamp-4';
}

/** The tape's clock and progress line: the one part that ticks every second,
 *  so it owns the tick (useElapsed says why) and carries --pf on itself. Set
 *  on the skin's root, --pf restyled all ~1,000 nodes of the machine a second. */
const TapeProgress = memo(function TapeProgress({
  startedAt,
  duration,
  desk,
}: {
  startedAt: number | null;
  duration: number | undefined;
  desk: boolean;
}) {
  const elapsed = useElapsed(startedAt);
  const ratio = progressRatio(elapsed, duration);
  const ref = useRef<HTMLDivElement | null>(null);
  useDynamicStyle(ref, { '--pf': ratio ?? 0 });
  return (
    <div ref={ref} className={cn('mt-auto flex items-center font-mono tabular-nums', desk ? 'gap-3 text-[12px]' : 'gap-2.5 text-[11px]')}>
      <span className={cn(styles.txt, 'font-bold')}>{fmtTime(elapsed)}</span>
      <div className={cn('relative flex-1', desk ? 'h-3.5' : 'h-3')}>
        <div className={cn('absolute inset-x-0 border-t border-dashed border-muted', desk ? 'top-[7px]' : 'top-1.5')} />
        {ratio != null && (
          <>
            <div className={cn('absolute left-0 h-0.5 bg-vermilion', desk ? 'top-1.5' : 'top-[5px]', styles.progFill)} />
            <div className={cn('absolute top-0 h-full w-0.5 bg-vermilion', styles.progHead)} />
          </>
        )}
      </div>
      <span className="text-muted">{duration ? fmtTime(duration) : 'live'}</span>
    </div>
  );
});

/** The paper tape: what the machine is receiving, typing or sending. */
function Tape({ variant, mode, eyebrow, eyebrowR, keyText, store, song, talk, compose, sent }: TapeProps) {
  const desk = variant === 'desk';
  const caret = <span className={styles.caret} aria-hidden="true" />;

  return (
    <div className={cn('flex min-h-0 flex-col', desk ? 'h-full gap-2' : 'flex-1 gap-1.5')}>
      {desk && (
        <div className="flex items-baseline justify-between gap-4">
          <span className={cn('truncate font-mono text-[10px] font-bold tracking-[0.22em] uppercase', mode === 'offline' ? 'text-muted' : 'text-vermilion')}>
            {eyebrow}
          </span>
          <span className="font-mono text-[9px] tracking-[0.22em] whitespace-nowrap text-muted uppercase">{eyebrowR}</span>
        </div>
      )}

      {mode === 'music' && (
        <>
          <div className={cn(styles.txt, styles.tapeTitle, 'font-display leading-[1.05] font-bold tracking-[-0.01em]', titleFit(Array.from(song.title).length, variant))}>
            <span className="sr-only">{song.title}</span>
            <span aria-hidden="true">
              <TapeChars store={store} text={song.title} base={0} />
            </span>
          </div>
          {(song.artist || song.sub) && (
            <div className={cn('truncate font-mono tracking-[0.14em]', desk ? 'text-[14px]' : 'text-[11px]')}>
              {song.artist && (
                <span className={styles.txt}>
                  <span className="sr-only">{song.artist}</span>
                  <span aria-hidden="true">
                    <TapeChars store={store} text={song.artist} base={song.artistAt} />
                  </span>
                </span>
              )}
              {song.sub && (
                <span className={cn('tracking-[0.12em] text-muted uppercase', desk ? 'pl-2.5 text-[11px]' : 'pl-2')}>
                  {song.artist ? '· ' : ''}{song.sub}
                </span>
              )}
            </div>
          )}
          <TapeProgress startedAt={song.startedAt} duration={song.duration} desk={desk} />
        </>
      )}

      {mode === 'talk' && (
        <>
          <div className="flex min-h-0 flex-1 flex-col justify-end overflow-hidden">
            <p className={cn('font-display leading-[1.35] text-pretty italic', desk ? 'text-[22px]' : 'text-[15px] leading-[1.4]')}>
              <span className="sr-only">{talk}</span>
              <TapeTyped store={store} text={talk} />
            </p>
          </div>
          <span className={cn('flex-none truncate font-mono tracking-[0.14em] text-muted uppercase', desk ? 'text-[11px]' : 'text-[10px]')}>
            <Play className="inline size-2 fill-current" /> {song.nowLine}
          </span>
        </>
      )}

      {mode === 'compose' && (
        <>
          {/* The strip is short, so it keeps the newest line (and the caret)
              in view as the note wraps. */}
          <div className={cn('min-h-0 overflow-hidden', !desk && 'flex flex-1 flex-col justify-end')}>
            <div
              className={cn(
                'font-mono font-bold break-words whitespace-pre-wrap',
                desk ? 'text-[28px] leading-[1.2] tracking-[0.06em]' : 'text-[16px] leading-tight tracking-[0.05em]',
              )}
            >
              {compose.plain}{caret}
            </div>
          </div>
          <div className="flex min-w-0 items-baseline gap-3">
            {desk && <span className="flex-none font-mono text-[9px] font-bold tracking-[0.22em] text-muted uppercase">Cipher</span>}
            <span className={cn('truncate font-mono text-vermilion', desk ? 'text-[14px] tracking-[0.12em]' : 'text-[11px] tracking-[0.1em]')}>
              <span className="sr-only">Enciphered: </span>{compose.cipher}
            </span>
          </div>
          <div className={cn('mt-auto flex justify-between gap-4 font-mono tracking-[0.16em] text-muted uppercase', desk ? 'text-[10px]' : 'text-[9px]')}>
            <span>{desk ? keyText : eyebrowR}</span>
            <span>{desk ? 'enter send · esc clear' : keyText}</span>
          </div>
        </>
      )}

      {mode === 'sent' && (
        <>
          <div className={cn('line-clamp-2 font-display leading-[1.15] font-semibold italic', desk ? 'text-[30px]' : 'text-[16px]')}>
            {sent.line}
          </div>
          <div className={cn('font-mono text-vermilion', desk ? 'text-[14px] tracking-[0.12em] break-words' : 'truncate text-[11px] tracking-[0.1em]')}>
            {sent.cipher}
          </div>
          {desk && (
            <div className="mt-auto font-mono text-[10px] tracking-[0.16em] text-muted uppercase">
              {sent.outcome === 'refused' || sent.outcome === 'failed'
                ? SENT_FOOT[sent.outcome]
                : <>sent enciphered · {keyText}</>}
            </div>
          )}
        </>
      )}

      {mode === 'offline' && (
        <>
          <div className={cn('font-display leading-[1.05] font-bold text-muted', desk ? 'text-[54px]' : 'text-[22px]')}>— off air —</div>
          <span className={cn('text-pretty text-muted', desk ? 'text-[15px] leading-normal' : 'line-clamp-2 text-[12px] leading-snug')}>{OFFLINE_COPY}</span>
        </>
      )}
    </div>
  );
}
