'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, m } from 'motion/react';
import { ArrowUpRight, Radio } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { NowPlayingTrack, RequestResult, StationContext } from '@/lib/types';

const SUCCESS_HOLD_MS = 2800;
const POLL_INTERVAL_MS = 1500;
const POLL_DEADLINE_MS = 60000;

// Notebook ruled-paper background for the writing field: faint horizontal rules
// every 30px, applied via an arbitrary Tailwind `bg-[…]` utility (inline styles
// are banned project-wide). `leading-[30px]` on the textarea lands each line of
// serif text on a rule so the prompt reads like a note scrawled on a request
// card. Kept low-contrast so a sub-pixel baseline drift never reads as broken.
const RULED_PAPER =
  'bg-[repeating-linear-gradient(to_bottom,transparent_0,transparent_29px,var(--separator-soft)_29px,var(--separator-soft)_30px)]';

// Instant, no-LLM acknowledgement shown the moment the booth accepts the
// request — so there's zero dead time before the listener gets feedback. The
// real on-air ack from the DJ replaces it once the pick resolves.
function templatedAck(name: string): string {
  const n = name.trim();
  return n
    ? `Got it, ${n} — taking it to the booth.`
    : `Got it — taking it to the booth.`;
}

interface Suggestion {
  text: string;
  attribution: string;
}

// Pull a handful of context-aware suggestion chips out of what's already
// on-air. Each chip carries an attribution so the listener understands why
// it's being offered — "from track", "from time", etc. — instead of a flat
// list of canned moods. Order: most-specific (current track) first, weakest
// (random) last. Capped at 5 so the drawer doesn't sprawl.
function buildSuggestions(
  nowPlaying: NowPlayingTrack | null,
  context: StationContext | null,
): Suggestion[] {
  const seen = new Set<string>();
  const out: Suggestion[] = [];
  const push = (text: string, attribution: string) => {
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ text, attribution });
  };

  if (nowPlaying?.artist) {
    // The controller has a dedicated "more like this" code path that picks
    // another song by the currently-playing artist, so attribute it that way
    // — clearer than vague "track-derived".
    push('more like this', `more ${nowPlaying.artist}`);
  }

  const festival = context?.festival?.name;
  if (festival) {
    push(`${festival.toLowerCase()} mood`, `festival`);
  }

  const vibe = context?.time?.vibe || context?.time?.show;
  if (vibe) {
    push(`${vibe} vibes`, `right now`);
  }

  const cond = context?.weather?.condition;
  const weatherMap: Record<string, string> = {
    clear: 'sunny afternoon',
    sunny: 'sunny afternoon',
    cloudy: 'overcast mood',
    rain: 'rainy day',
    rainy: 'rainy day',
    drizzle: 'rainy day',
    snow: 'snowy night',
    snowy: 'snowy night',
    fog: 'foggy morning',
    foggy: 'foggy morning',
    thunderstorm: 'stormy night',
  };
  if (cond && cond !== 'unknown') {
    push(weatherMap[cond] || `${cond} day`, `weather`);
  }

  // Always-available fallback.
  push('surprise me', `random`);

  return out.slice(0, 5);
}

export interface RequestDrawerProps {
  requestText: string;
  setRequestText: (text: string) => void;
  requesterName: string;
  setRequesterName: (name: string) => void;
  isSubmitting: boolean;
  onSubmit: () => Promise<RequestResult | null>;
  onPoll?: (requestId: string) => Promise<RequestResult | null>;
  onClose?: () => void;
  nowPlaying: NowPlayingTrack | null;
  context: StationContext | null;
}

export default function RequestDrawer({
  requestText, setRequestText,
  requesterName, setRequesterName,
  isSubmitting, onSubmit, onPoll, onClose,
  nowPlaying, context,
}: RequestDrawerProps) {
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  // `result` drives the render: { success, pending, ack, track, message }.
  // Null while idle. On accept it's a `pending` success card showing the
  // instant templated ack; polling fills in the real track + on-air ack.
  const [result, setResult] = useState<RequestResult | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollStopRef = useRef(false);

  useEffect(() => () => {
    pollStopRef.current = true;
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
  }, []);

  // Hold the resolved card briefly, then slide the drawer shut and reset.
  const scheduleClose = () => {
    if (!onClose || closeTimerRef.current) return;
    closeTimerRef.current = setTimeout(() => {
      onClose();
      // Defer state reset until after the close animation so the form
      // doesn't flash back in during the slide.
      setTimeout(() => setResult(null), 300);
    }, SUCCESS_HOLD_MS);
  };

  // Poll the controller until the request resolves, fails, or the deadline
  // passes. While pending the templated ack card stays up; on resolve it
  // morphs into the real track + DJ ack, then auto-closes.
  const startPolling = (requestId: string) => {
    pollStopRef.current = false;
    const deadline = Date.now() + POLL_DEADLINE_MS;
    const tick = async () => {
      if (pollStopRef.current) return;
      if (Date.now() > deadline) { scheduleClose(); return; }
      const data = await onPoll?.(requestId);
      if (pollStopRef.current) return;
      if (data?.status === 'resolved') {
        setResult(prev => ({
          success: true,
          ack: data.ack || prev?.ack,
          track: data.track,
          queuePosition: data.queuePosition,
        }));
        scheduleClose();
        return;
      }
      if (data?.status === 'failed') {
        setResult({ success: false, message: data.message || 'No match — try different words.' });
        return;
      }
      if (data?.status === 'unknown') { scheduleClose(); return; }
      // pending, or a transient network null — keep polling.
      pollTimerRef.current = setTimeout(tick, POLL_INTERVAL_MS);
    };
    pollTimerRef.current = setTimeout(tick, POLL_INTERVAL_MS);
  };

  const handleSubmit = async () => {
    // Capture before the await — onSubmit clears requestText on accept.
    const askedText = requestText.trim();
    const askedName = requesterName.trim();
    const data = await onSubmit();
    if (!data) return;
    // 429 / 503 / network error — surface the miss banner, no polling.
    if (!data.success) {
      setResult(data);
      return;
    }
    // Accepted. Show the instant ack now; poll for the real pick.
    setResult({
      success: true,
      pending: true,
      ack: templatedAck(askedName),
      requestText: askedText,
    });
    if (data.requestId && onPoll) {
      startPolling(data.requestId);
    } else {
      scheduleClose();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const canSend = !isSubmitting && !!requestText.trim();

  return (
    // Outer layout animates the height delta when form ↔ success swaps.
    <m.div layout>
      <AnimatePresence mode="wait" initial={false}>
        {result?.success ? (
          <m.div
            key="success"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.12 }}
          >
            <SuccessCard result={result} />
          </m.div>
        ) : (
          <m.div
            key="form"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.12 }}
          >
            {/* The request slip — a bordered card framed like an on-air request
                ticket. Top strip = live-line indicator + ticket label; body =
                the serif "note to the booth" writing field on ruled paper. */}
            <div className="border border-ink bg-field/40 shadow-[3px_3px_0_var(--separator-strong)]">
              <div className="flex items-center justify-between border-b border-ink px-3.5 py-2">
                <span className="inline-flex items-center gap-2">
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-vermilion opacity-60" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-vermilion" />
                  </span>
                  <span className="v3-tab-num text-[9px] tracking-[0.34em] text-ink uppercase">
                    Line open
                  </span>
                </span>
                <span className="v3-tab-num inline-flex items-center gap-1.5 text-[9px] tracking-[0.34em] text-muted uppercase">
                  <Radio size={11} strokeWidth={1.75} />
                  Request slip
                </span>
              </div>

              <div className="px-3.5 pt-3 pb-3.5">
                <label className="mb-2 block text-[9px] tracking-[0.3em] text-muted uppercase">
                  Dear DJ —
                </label>
                {/* Vermilion margin rule (left) + faint horizontal rules: the
                    writing field reads as a note on a request card. The textarea
                    is borderless and transparent so only the paper shows. */}
                <div className={cn('relative border-l-2 border-l-vermilion pl-3', RULED_PAPER)}>
                  <textarea
                    ref={taRef}
                    value={requestText}
                    onChange={e => { setRequestText(e.target.value); if (result) setResult(null); }}
                    onKeyDown={onKeyDown}
                    placeholder={'play me something for\nlate-night driving…'}
                    rows={3}
                    /* 16px avoids iOS zoom-on-focus. 30px line-height matches the
                       ruled-paper stripe so text sits on the lines. */
                    className="block w-full resize-none border-0 bg-transparent p-0 [font-family:var(--font-display),Georgia,serif] text-[16px] leading-[30px] text-ink italic placeholder:text-muted/70 focus:outline-none"
                  />
                </div>

                {/* Signature line — the name field as a hand-signed dateline
                    rather than a boxed input. */}
                <div className="mt-3 flex items-baseline gap-2 border-t border-soft-border pt-3">
                  <span className="[font-family:var(--font-display),Georgia,serif] text-[15px] leading-none text-muted italic">
                    —
                  </span>
                  <input
                    type="text"
                    value={requesterName}
                    onChange={e => setRequesterName(e.target.value)}
                    placeholder="signed, your name (optional)"
                    className="v3-tab-num min-w-0 flex-1 border-0 bg-transparent p-0 text-[12px] tracking-[0.04em] text-ink placeholder:text-muted/70 focus:outline-none"
                  />
                </div>
              </div>
            </div>

            <p className="mt-3 text-[11px] leading-relaxed text-muted">
              Describe a mood, a memory, an artist. Agentic AI DJ reads your note,
              digs the library, and answers you on-air.
            </p>

            <SuggestionChips
              nowPlaying={nowPlaying}
              context={context}
              onPick={text => { setRequestText(text); taRef.current?.focus(); }}
            />

            {result && !result.success && (
              <div className="mt-3 border border-[#c0392b] bg-[rgba(192,57,43,0.06)] px-3 py-2.5 text-xs leading-normal text-[#7a2218]">
                {result.message || 'No match — try different words.'}
              </div>
            )}

            <m.button
              type="button"
              onClick={handleSubmit}
              disabled={!canSend}
              whileTap={{ scale: 0.97 }}
              className={cn(
                'v3-focus group mt-3.5 inline-flex w-full cursor-pointer items-center justify-center gap-2.5 border-0 bg-vermilion px-6 py-3.5 text-center font-[inherit] text-[13px] font-semibold tracking-[0.14em] text-bg uppercase shadow-[0_1px_0_var(--ink)] transition-opacity',
                'disabled:cursor-not-allowed disabled:opacity-50',
              )}
            >
              {isSubmitting ? 'Transmitting…' : 'Send to the booth'}
              <ArrowUpRight
                size={16}
                strokeWidth={2.25}
                className="transition-transform duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
              />
            </m.button>

            <div className="mt-2 text-center text-[9px] tracking-[0.28em] text-muted uppercase">
              <span className="v3-tab-num">Enter</span> to send ·{' '}
              <span className="v3-tab-num">Shift + Enter</span> for a new line
            </div>
          </m.div>
        )}
      </AnimatePresence>
    </m.div>
  );
}

interface SuccessCardProps {
  result: RequestResult;
}

function SuccessCard({ result }: SuccessCardProps) {
  const { ack, track, queuePosition, pending, requestText } = result;
  return (
    <div className="py-2">
      <div className="mb-[14px] flex items-center gap-2 text-[9px] tracking-[0.4em] text-vermilion uppercase">
        <span className="relative flex h-1.5 w-1.5">
          {pending && (
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-vermilion opacity-60" />
          )}
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-vermilion" />
        </span>
        {pending ? 'On the wire' : 'Queued'}
      </div>

      {ack && (
        <div className="mb-[22px] border-l-2 border-l-vermilion pl-[14px] [font-family:var(--font-display),Georgia,'Times_New_Roman',serif] text-lg leading-snug text-ink italic">
          &ldquo;{ack}&rdquo;
        </div>
      )}

      {/* layout on the inner block animates the height delta between the
          pending "finding your track…" prose and the resolved track title +
          artist — the bordered slab eases instead of snapping. */}
      <m.div layout className="border-y border-soft-border py-4">
        <div className="mb-1.5 text-[9px] tracking-[0.3em] text-muted uppercase">
          {pending ? 'The DJ is digging' : 'Now in the booth'}
        </div>
        <AnimatePresence mode="wait" initial={false}>
          <m.div
            key={pending ? 'pending' : 'resolved'}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.14 }}
          >
            {pending ? (
              <>
                <div className="sw-pulse [font-family:var(--font-display),Georgia,'Times_New_Roman',serif] text-base leading-snug text-ink italic">
                  finding your track…
                </div>
                {requestText && (
                  <div className="mt-1 text-[13px] text-muted">
                    &ldquo;{requestText}&rdquo;
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="text-[22px] leading-tight font-semibold text-ink">
                  {track?.title}
                </div>
                <div className="mt-0.5 text-[13px] text-muted">
                  {track?.artist}
                </div>
              </>
            )}
          </m.div>
        </AnimatePresence>
      </m.div>

      {!pending && typeof queuePosition === 'number' && queuePosition > 0 && (
        <div className="v3-tab-num mt-[14px] text-[11px] tracking-[0.15em] text-muted uppercase">
          Position #{queuePosition} in queue
        </div>
      )}

      <div className="mt-[26px] text-[10px] tracking-[0.3em] text-muted uppercase">
        {pending ? 'You can close this — your request is locked in' : 'Closing…'}
      </div>
    </div>
  );
}

interface SuggestionChipsProps {
  nowPlaying: NowPlayingTrack | null;
  context: StationContext | null;
  onPick: (text: string) => void;
}

// Context-aware chip row. Each chip is a two-line button: the prompt text on
// top, a small attribution caption underneath ("more <artist>", "weather",
// "festival", "right now", "random"). Listeners see *why* a suggestion is
// being offered instead of a flat canned list.
//
// Chips stagger in after the drawer's slide-in finishes (delayChildren: 0.12)
// so the row arrives as a row rather than competing with the drawer entrance.
function SuggestionChips({ nowPlaying, context, onPick }: SuggestionChipsProps) {
  // Listing only the fields buildSuggestions actually reads — depending on the
  // whole nowPlaying/context objects would recompute on every poll cycle.
  const chips = useMemo(
    () => buildSuggestions(nowPlaying, context),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nowPlaying?.artist, nowPlaying?.title, context?.festival?.name,
     context?.time?.vibe, context?.time?.show, context?.weather?.condition]
  );

  return (
    <div className="mt-3.5">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[9px] tracking-[0.3em] text-muted uppercase">
          On the wire
        </span>
        <span className="h-px flex-1 bg-soft-border" />
      </div>
      <m.div
        className="flex flex-wrap gap-1.5"
        initial="hidden"
        animate="visible"
        variants={{
          hidden:  {},
          visible: { transition: { staggerChildren: 0.04, delayChildren: 0.12 } },
        }}
      >
        {chips.map(chip => (
          <m.button
            key={chip.text}
            type="button"
            onClick={() => onPick(chip.text)}
            variants={{
              hidden:  { opacity: 0, y: 4 },
              visible: { opacity: 1, y: 0, transition: { duration: 0.18 } },
            }}
            whileTap={{ scale: 0.96 }}
            className="v3-focus group cursor-pointer border border-ink bg-transparent px-3 py-1.5 text-left font-[inherit] leading-tight text-ink transition-colors hover:bg-ink hover:text-bg"
            title={`Suggested via ${chip.attribution}`}
          >
            <span className="block text-[11px] tracking-[0.08em]">
              {chip.text}
            </span>
            <span className="mt-[3px] block text-[8px] tracking-[0.22em] text-muted uppercase transition-colors group-hover:text-bg/70">
              {chip.attribution}
            </span>
          </m.button>
        ))}
      </m.div>
    </div>
  );
}
