'use client';

// CIPHER-3 — the player as a rotor cipher machine. The key is the power
// switch, rotor I is the volume, and the lampboard spells the song one letter
// per beat (or the DJ's words as they air). Typing on the machine's keys, or
// the real keyboard, writes a request: each letter steps the rotors and lights
// its enciphered bulb, and SEND hands the plain text to the booth.
// Desktop and phone are two trees switched by CSS rather than a JS media
// query, so SSR paints the right one first. Each machine is drawn at a fixed
// size and scaled to its box.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import styles from './Cipher.module.css';
import { BlockKey, KeyRows, Lampboard, Panel, PowerKey, Rotor, Screws, TapeChars, type KeyHandlers } from './CipherParts';
import {
  MSG_MAX,
  VOL_STOPS,
  beatMs,
  chr,
  groups,
  keyToChar,
  lampSequence,
  mod26,
  stopToVol,
  typingMs,
  volGlyph,
  volToStop,
} from './cipher';
import { useCipherMachine, type Ambient, type Spelling } from './useCipherMachine';
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

const DESK = { w: 1360, h: 800, max: 1.1 };
const MOB = { w: 366, h: 516, compactH: 390, max: 1.6 };

/** Scale a fixed-size drawing to fit its parent, centred. The element stays
 *  hidden (CSS) until the first fit lands. */
function useFitBox(
  ref: RefObject<HTMLDivElement | null>,
  { w, h, max, compactH }: { w: number; h: number; max: number; compactH?: number },
) {
  useLayoutEffect(() => {
    const el = ref.current;
    const box = el?.parentElement;
    if (!el || !box) return;
    const fit = () => {
      const bw = box.clientWidth;
      const bh = box.clientHeight;
      // The other layout's tree is display:none; it fits when it shows.
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
  }, [ref, w, h, max, compactH]);
}

function isTextEntry(el: Element): boolean {
  return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || (el instanceof HTMLElement && el.isContentEditable);
}

export default function CipherSkin({ contained }: SkinProps) {
  const { nowPlaying, context, dj, activeShow, listeners, session, trackStartedAt } = usePlayerFeed();
  const { tunedIn, status, volume, muted, offline, signal } = usePlayerAudio();
  const { toggleMute, setVolume } = usePlayerActions();
  const { showOverlay, tuneInFromOverlay, handleTune } = useTuneInGate();

  const elapsed = useElapsed(trackStartedAt);
  const ratio = progressRatio(elapsed, nowPlaying?.duration);
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
  const { msg } = machine;
  const { middle, right } = msg.rotors;

  const composing = !offline && msg.plain.length > 0;
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
    const text = msg.plain.trim();
    if (!live || !text || slip.sending) return;
    setSent(groups(msg.cipher));
    machine.clear();
    void slip.send(text);
  };
  const setVol = (x: number) => setVolume(stopToVol(Math.min(VOL_STOPS, Math.max(0, x))));
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
    phase, vol, down: machine.down, plain: msg.plain,
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
      const d = latest.current.down;
      if (d && (e.key === ' ' ? d === 'SPACE' : keyToChar(e.key) === d)) latest.current.release();
    };
    // A key held while the window loses focus never sees its keyup.
    const onBlur = () => { if (latest.current.down) latest.current.release(); };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  useDynamicStyle(rootRef, { '--pf': ratio ?? 0 });
  const deskFit = useRef<HTMLDivElement | null>(null);
  const mobFit = useRef<HTMLDivElement | null>(null);
  useFitBox(deskFit, DESK);
  useFitBox(mobFit, MOB);

  // ── Words ──────────────────────────────────────────────────────────
  const gate = showOverlay && !offline;
  const powered = isPowered(phase);
  const keyText = `rotors ${volGlyph(vol)} · ${chr(middle)} · ${chr(right)}`;
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
    ? `${msg.plain.length} / ${MSG_MAX}`
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
  const volLabel = muted ? 'muted' : `vol ${volGlyph(vol)} / ${VOL_STOPS}`;
  const sub = [nowPlaying?.album, nowPlaying?.year].filter(Boolean).join(' · ');
  const nowLine = [nowPlaying?.title, nowPlaying?.artist].filter(Boolean).join(' — ');
  const sentLine = slip.sending ? `On the wire to ${djName}…` : (slip.ack ?? `${djName} has your note.`);

  const tape: Omit<TapeProps, 'variant'> = {
    mode, eyebrow, eyebrowR, keyText,
    song: {
      title: title || 'Scanning the dial…', artist, artistAt, sub, nowLine,
      elapsed, duration: nowPlaying?.duration, ratio,
    },
    spelling: machine.spelling,
    talk: { text: talkText, typed: machine.talkN },
    compose: { plain: msg.plain, cipher: groups(msg.cipher) },
    sent: { line: sentLine, cipher: sent ?? '', outcome: slip.sending ? null : slip.outcome },
  };

  const rotorI = (
    <Rotor name="I · vol" label="Volume" value={vol} max={VOL_STOPS} accent onChange={setVol} />
  );
  const rotorII = (
    <Rotor name="II" label="Rotor II" value={middle} onChange={v => machine.setRotors({ middle: mod26(v), right })} />
  );
  const rotorIII = (
    <Rotor name="III" label="Rotor III" value={right} onChange={v => machine.setRotors({ middle, right: mod26(v) })} />
  );
  const likeFace = like.available ? `${like.count}` : '—';
  const canLike = like.available && !like.liked && !like.pending;
  const hasMsg = composing && msg.plain.trim().length > 0;

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
      <div className="absolute inset-0 hidden flex-col lg:flex">
        <div className="flex flex-none items-center justify-between gap-6 border-b border-ink px-8 py-3.5">
          <div className="flex min-w-0 items-baseline gap-3.5">
            <span className="truncate font-display text-[22px] font-extrabold tracking-[0.02em]">{stationName.toUpperCase()}</span>
            <span className="font-mono text-[10px] tracking-[0.24em] whitespace-nowrap text-muted uppercase">cipher-3 · rotor machine</span>
          </div>
          <div className="flex min-w-0 shrink items-center gap-3">
            <div className="flex min-w-0 items-center gap-3 font-mono text-[11px] tracking-[0.16em] uppercase">
              {showName && <span className="max-w-[18vw] truncate">▸ {showName}</span>}
              <span className="whitespace-nowrap text-vermilion">with {djName}</span>
              {contextLine(context) && (
                <span className="max-w-[22vw] truncate border-l border-soft-border pl-3 text-muted">{contextLine(context)}</span>
              )}
            </div>
            <ThemeSwitcher />
          </div>
        </div>

        <div className={cn('relative min-h-0 flex-1', styles.gridDesk)}>
          <span className="absolute top-4 left-6 font-mono text-[9px] tracking-[0.24em] whitespace-nowrap text-muted uppercase">
            sheet 03 · cipher-3 · top deck 1:1
          </span>
          <span className="absolute top-4 right-6 font-mono text-[9px] tracking-[0.24em] whitespace-nowrap text-muted uppercase">
            type to write a request · drag rotor I for volume
          </span>
          <div className="absolute inset-x-6 top-[38px] bottom-4">
            <div ref={deskFit} className={cn(styles.fit, styles.desk, 'w-[1360px]')}>
              <div
                className={cn(
                  styles.ln,
                  styles.isoL,
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
                  <Panel label="Tape" className="min-w-0 flex-1 px-[26px] pt-[22px] pb-[18px]">
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

                <Panel label="Lampboard" className="flex flex-col items-center justify-center">
                  <Lampboard lit={machine.lit} />
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
                      <span className="font-sans text-[28px] leading-none">♥</span>
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
                    <span className="font-mono text-[13px] leading-none font-bold tracking-[0.16em]">⌫ DEL</span>
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
                    <KeyRows down={machine.down} keys={keyHandlers} />
                  </div>
                  <SpaceBar
                    down={machine.down === 'SPACE'}
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
                        <span className="font-sans text-[24px] leading-none">↗</span>
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
                  <span className="font-mono text-[9px] tracking-[0.2em] whitespace-nowrap text-muted uppercase">enter ↵</span>
                </Panel>
              </div>
              <div className={cn(styles.plinth, 'h-3 w-[1360px]')} />
            </div>
          </div>
          {gateButton}
        </div>

        <div className="flex flex-none items-center gap-4 border-t border-ink bg-field px-6 py-3 font-mono text-[10px] tracking-[0.16em] uppercase">
          {statusDot}
          {listenerTag && <span className="border-l border-soft-border pl-4">{listenerTag}</span>}
          {live && signal.latencyMs != null && (
            <span className="whitespace-nowrap text-muted">sig {signal.latencyMs} ms · {signal.quality}</span>
          )}
          <span className="border-l border-soft-border pl-4 whitespace-nowrap text-muted">{keyText}</span>
          <span className="ml-auto whitespace-nowrap text-muted">{volLabel}</span>
        </div>
      </div>

      {/* ── Phone and tablet ────────────────────────────────────── */}
      <div className="absolute inset-0 flex flex-col lg:hidden">
        <div className="flex flex-none flex-col gap-1 border-b border-ink px-4 pt-3 pb-2.5 landscape:py-1">
          <div className="flex items-center justify-between gap-3">
            <span className="truncate font-display text-[19px] font-extrabold tracking-[0.02em]">{stationName.toUpperCase()}</span>
            <ThemeSwitcher />
          </div>
          <span className="truncate font-mono text-[10px] tracking-[0.16em] text-muted uppercase landscape:hidden">
            {showName && <>▸ {showName} · </>}
            <span className="text-vermilion">with {djName}</span>
          </span>
        </div>

        {/* Upright, the tape sits over the machine. A phone turned sideways
            puts it beside the machine instead, where stacking would shrink
            the keys to nothing. */}
        <div className="relative flex min-h-0 flex-1 flex-col landscape:flex-row">
          <div className="flex h-[160px] flex-none flex-col gap-1.5 overflow-hidden border-b border-ink px-4 pt-2 pb-3 landscape:h-auto landscape:w-[40%] landscape:border-r landscape:border-b-0">
            <div className="flex items-center gap-2">
              <span className={cn('min-w-0 flex-1 truncate font-mono text-[10px] font-bold tracking-[0.2em] uppercase', offline ? 'text-muted' : 'text-vermilion')}>
                {eyebrow}
              </span>
              <BlockKey
                aria-label="Mute"
                aria-pressed={muted}
                lit={muted}
                onClick={toggleMute}
                className="h-10 w-[60px] flex-none [--drop:0px]"
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
                className="h-10 w-[60px] flex-none [--drop:0px]"
              >
                <span className="font-mono text-[11px] leading-none font-bold tracking-[0.08em]">♥ {likeFace}</span>
              </BlockKey>
            </div>
            <Tape {...tape} variant="strip" />
          </div>

          <div className={cn('relative min-h-0 flex-1', styles.gridMob)}>
            <div className="absolute inset-x-3 inset-y-2.5 landscape:inset-y-1.5">
              <div ref={mobFit} className={cn(styles.fit, styles.mob, 'w-[366px]')}>
                <div className={cn(styles.ln, styles.isoL, styles.mobBody, 'flex w-[366px] flex-col gap-3.5 px-2.5 pt-3.5 pb-2.5')}>
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

                  <Panel label="Lamps" className={cn(styles.lampBay, 'flex h-[112px] flex-none flex-col items-center justify-center')}>
                    <Lampboard lit={machine.lit} />
                  </Panel>

                  <Panel label="Keys · type a request" className={cn(styles.wellBay, 'flex min-h-0 flex-1 flex-col items-center justify-center')}>
                    <div className="flex flex-col">
                      <KeyRows down={machine.down} keys={keyHandlers} />
                    </div>
                    <div className="mt-1.5 flex w-[333px] gap-1.5">
                      <BlockKey
                        aria-label="Delete last letter"
                        caps
                        dead={!composing}
                        disabled={!composing}
                        onClick={machine.del}
                        className="h-[42px] w-[52px] flex-none [--drop:4px]"
                      >
                        <span className="font-mono text-[11px] leading-none font-bold">⌫</span>
                      </BlockKey>
                      <BlockKey
                        aria-label="Clear message"
                        caps
                        dead={!composing}
                        disabled={!composing}
                        onClick={machine.clear}
                        className="h-[42px] w-[52px] flex-none [--drop:4px]"
                      >
                        <span className="font-mono text-[9px] leading-none font-bold tracking-[0.12em]">CLR</span>
                      </BlockKey>
                      <SpaceBar
                        down={machine.down === 'SPACE'}
                        keys={keyHandlers}
                        className="h-[42px] min-w-0 flex-1 [--drop:4px]"
                        label="text-[9px] tracking-[0.28em]"
                      />
                      <BlockKey
                        aria-label={`Send request to ${djName}`}
                        caps
                        lit={hasMsg}
                        dead={!hasMsg}
                        disabled={!hasMsg}
                        onClick={send}
                        className="h-[42px] w-[88px] flex-none [--drop:4px]"
                      >
                        <span className="font-mono text-[11px] leading-none font-bold tracking-[0.14em]">{hasMsg ? 'SEND ↗' : 'SEND'}</span>
                      </BlockKey>
                    </div>
                  </Panel>
                </div>
              </div>
            </div>
          </div>
          {gateButton}
        </div>

        {/* A phone on its side under 360px tall gives the status bar's
            height to the machine; the tape's eyebrow still says the state. */}
        <div className="flex flex-none items-center gap-3.5 border-t border-ink bg-field px-4 py-3 font-mono text-[10px] tracking-[0.16em] uppercase landscape:py-2 [@media(orientation:landscape)_and_(max-height:359px)]:hidden">
          {statusDot}
          {listenerTag}
          <span className="ml-auto whitespace-nowrap text-muted">{volLabel}</span>
        </div>
      </div>
    </div>
  );
}

/** The space bar: a block key that types like a letter key. */
function SpaceBar({
  down,
  keys,
  className,
  label,
}: {
  down: boolean;
  keys: KeyHandlers;
  className: string;
  label: string;
}) {
  return (
    <BlockKey
      aria-label="Space"
      tabIndex={-1}
      data-cipher-key=""
      caps
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
  elapsed: number;
  duration: number | undefined;
  ratio: number | null;
}

interface TapeProps {
  variant: 'desk' | 'strip';
  mode: TapeMode;
  eyebrow: string;
  eyebrowR: string;
  /** The rotor readout, e.g. "rotors 18 · K · Q". */
  keyText: string;
  song: TapeSong;
  spelling: Spelling;
  /** The DJ's line, and how many of its characters have typed out. */
  talk: { text: string; typed: number };
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
  // Sideways, the tape is a tall column with lines to spare.
  if (len <= 18) return 'text-[30px] line-clamp-1 landscape:line-clamp-3';
  return 'text-[22px] line-clamp-2 landscape:line-clamp-4';
}

/** The paper tape: what the machine is receiving, typing or sending. */
function Tape({ variant, mode, eyebrow, eyebrowR, keyText, song, spelling, talk, compose, sent }: TapeProps) {
  const desk = variant === 'desk';
  const caret = <span className={styles.caret} aria-hidden="true" />;
  const talkChars = Array.from(talk.text);
  const typed = talkChars.slice(0, talk.typed).join('');
  const done = talk.typed >= talkChars.length;

  const progress = (
    <div className={cn('mt-auto flex items-center font-mono tabular-nums', desk ? 'gap-3 text-[12px]' : 'gap-2.5 text-[11px]')}>
      <span className={cn(styles.txt, 'font-bold')}>{fmtTime(song.elapsed)}</span>
      <div className={cn('relative flex-1', desk ? 'h-3.5' : 'h-3')}>
        <div className={cn('absolute inset-x-0 border-t border-dashed border-muted', desk ? 'top-[7px]' : 'top-1.5')} />
        {song.ratio != null && (
          <>
            <div className={cn('absolute left-0 h-0.5 bg-vermilion', desk ? 'top-1.5' : 'top-[5px]', styles.progFill)} />
            <div className={cn('absolute top-0 h-full w-0.5 bg-vermilion', styles.progHead)} />
          </>
        )}
      </div>
      <span className="text-muted">{song.duration ? fmtTime(song.duration) : 'live'}</span>
    </div>
  );

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
          <div className={cn(styles.txt, 'font-display leading-[1.05] font-bold tracking-[-0.01em]', titleFit(Array.from(song.title).length, variant))}>
            <span className="sr-only">{song.title}</span>
            <span aria-hidden="true">
              <TapeChars text={song.title} base={0} spelling={spelling} />
            </span>
          </div>
          {(song.artist || song.sub) && (
            <div className={cn('truncate font-mono tracking-[0.14em]', desk ? 'text-[14px]' : 'text-[11px]')}>
              {song.artist && (
                <span className={styles.txt}>
                  <span className="sr-only">{song.artist}</span>
                  <span aria-hidden="true">
                    <TapeChars text={song.artist} base={song.artistAt} spelling={spelling} />
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
          {progress}
        </>
      )}

      {mode === 'talk' && (
        <>
          <div className="flex min-h-0 flex-1 flex-col justify-end overflow-hidden">
            <p className={cn('font-display leading-[1.35] text-pretty italic', desk ? 'text-[22px]' : 'text-[15px] leading-[1.4]')}>
              <span className="sr-only">{talk.text}</span>
              <span aria-hidden="true">“{typed}{done ? '”' : caret}</span>
            </p>
          </div>
          <span className={cn('flex-none truncate font-mono tracking-[0.14em] text-muted uppercase', desk ? 'text-[11px]' : 'text-[10px]')}>
            ▸ {song.nowLine}
          </span>
        </>
      )}

      {mode === 'compose' && (
        <>
          <div
            className={cn(
              'min-h-0 overflow-hidden font-mono font-bold break-words whitespace-pre-wrap',
              desk ? 'text-[28px] leading-[1.2] tracking-[0.06em]' : 'text-[18px] leading-tight tracking-[0.05em]',
            )}
          >
            {compose.plain}{caret}
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
          <div className={cn('line-clamp-2 font-display leading-[1.15] font-semibold italic', desk ? 'text-[30px]' : 'text-[20px]')}>
            {sent.line}
          </div>
          <div className={cn('font-mono break-words text-vermilion', desk ? 'text-[14px] tracking-[0.12em]' : 'text-[11px] tracking-[0.1em]')}>
            {sent.cipher}
          </div>
          {desk && (
            <div className="mt-auto font-mono text-[10px] tracking-[0.16em] text-muted uppercase">
              {sent.outcome === 'refused' || sent.outcome === 'failed'
                ? SENT_FOOT[sent.outcome]
                : `sent enciphered · ${keyText}`}
            </div>
          )}
        </>
      )}

      {mode === 'offline' && (
        <>
          <div className={cn('font-display leading-[1.05] font-bold text-muted', desk ? 'text-[54px]' : 'text-[30px]')}>— off air —</div>
          <span className={cn('leading-normal text-pretty text-muted', desk ? 'text-[15px]' : 'text-[14px]')}>{OFFLINE_COPY}</span>
        </>
      )}
    </div>
  );
}
