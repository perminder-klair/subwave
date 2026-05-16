'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
import { Button } from '../ui/button';

const SUCCESS_HOLD_MS = 2800;
const POLL_INTERVAL_MS = 1500;
const POLL_DEADLINE_MS = 60000;

// Instant, no-LLM acknowledgement shown the moment the booth accepts the
// request — so there's zero dead time before the listener gets feedback. The
// real on-air ack from the DJ replaces it once the pick resolves.
function templatedAck(name) {
  const n = (name || '').trim();
  return n
    ? `Got it, ${n} — taking it to the booth.`
    : `Got it — taking it to the booth.`;
}

// Pull a handful of context-aware suggestion chips out of what's already
// on-air. Each chip carries an attribution so the listener understands why
// it's being offered — "from track", "from time", etc. — instead of a flat
// list of canned moods. Order: most-specific (current track) first, weakest
// (random) last. Capped at 5 so the drawer doesn't sprawl.
function buildSuggestions(nowPlaying, context) {
  const seen = new Set();
  const out = [];
  const push = (text, attribution) => {
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
  const weatherMap = {
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

export default function RequestDrawer({
  requestText, setRequestText,
  requesterName, setRequesterName,
  isSubmitting, onSubmit, onPoll, onClose,
  nowPlaying, context,
}) {
  const taRef = useRef(null);
  // `result` drives the render: { success, pending, ack, track, message }.
  // Null while idle. On accept it's a `pending` success card showing the
  // instant templated ack; polling fills in the real track + on-air ack.
  const [result, setResult] = useState(null);
  const closeTimerRef = useRef(null);
  const pollTimerRef = useRef(null);
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
  const startPolling = (requestId) => {
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

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  if (result?.success) {
    return <SuccessCard result={result} />;
  }

  return (
    <div>
      <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5, marginTop: 0 }}>
        Describe a mood, a memory, an artist. Ollama parses it, matches the library,
        and the DJ acknowledges you on-air.
      </p>

      <SuggestionChips
        nowPlaying={nowPlaying}
        context={context}
        onPick={text => { setRequestText(text); taRef.current?.focus(); }}
      />

      <Input
        type="text"
        value={requesterName}
        onChange={e => setRequesterName(e.target.value)}
        placeholder="your name (optional)"
        className="mb-2"
      />

      <Textarea
        ref={taRef}
        value={requestText}
        onChange={e => { setRequestText(e.target.value); if (result) setResult(null); }}
        onKeyDown={onKeyDown}
        placeholder='"something for late-night driving"…'
        rows={3}
        /* 16px text avoids iOS zoom-on-focus on this listener-facing field. */
        className="resize-none p-3.5 text-[16px]"
      />

      {result && !result.success && (
        <div
          style={{
            marginTop: 10,
            padding: '10px 12px',
            border: '1px solid #c0392b',
            background: 'rgba(192, 57, 43, 0.06)',
            color: '#7a2218',
            fontSize: 12,
            lineHeight: 1.5,
          }}
        >
          {result.message || 'No match — try different words.'}
        </div>
      )}

      <Button
        onClick={handleSubmit}
        disabled={isSubmitting || !requestText.trim()}
        variant="accent"
        className="mt-3 w-full px-6 py-3.5"
      >
        {isSubmitting ? 'Sending…' : 'Send to the booth'}
      </Button>
    </div>
  );
}

function SuccessCard({ result }) {
  const { ack, track, queuePosition, pending, requestText } = result;
  return (
    <div
      style={{
        padding: '8px 0',
        animation: 'sw-success-in 240ms ease-out both',
      }}
    >
      <style>{`
        @keyframes sw-success-in {
          from { opacity: 0; transform: translateY(6px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes sw-pulse { 0%,100% { opacity: 0.4; } 50% { opacity: 1; } }
      `}</style>

      <div
        style={{
          fontSize: 9,
          letterSpacing: '0.4em',
          textTransform: 'uppercase',
          color: 'var(--accent)',
          marginBottom: 14,
        }}
      >
        {pending ? '✓ Sent to the booth' : '✓ Queued'}
      </div>

      {ack && (
        <div
          style={{
            fontSize: 18,
            fontFamily: 'Georgia, "Times New Roman", serif',
            fontStyle: 'italic',
            color: 'var(--ink)',
            lineHeight: 1.3,
            borderLeft: '2px solid var(--accent)',
            paddingLeft: 14,
            marginBottom: 22,
          }}
        >
          “{ack}”
        </div>
      )}

      <div
        style={{
          padding: '16px 0',
          borderTop: '1px solid var(--soft-border)',
          borderBottom: '1px solid var(--soft-border)',
        }}
      >
        <div
          style={{
            fontSize: 9,
            letterSpacing: '0.3em',
            textTransform: 'uppercase',
            color: 'var(--muted)',
            marginBottom: 6,
          }}
        >
          {pending ? 'The DJ is digging' : 'Now in the booth'}
        </div>
        {pending ? (
          <>
            <div
              style={{
                fontSize: 16,
                fontStyle: 'italic',
                fontFamily: 'Georgia, "Times New Roman", serif',
                color: 'var(--ink)',
                lineHeight: 1.3,
                animation: 'sw-pulse 1.4s ease-in-out infinite',
              }}
            >
              finding your track…
            </div>
            {requestText && (
              <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>
                “{requestText}”
              </div>
            )}
          </>
        ) : (
          <>
            <div style={{ fontSize: 22, fontWeight: 600, lineHeight: 1.15, color: 'var(--ink)' }}>
              {track?.title}
            </div>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>
              {track?.artist}
            </div>
          </>
        )}
      </div>

      {!pending && typeof queuePosition === 'number' && queuePosition > 0 && (
        <div
          className="v3-tab-num"
          style={{
            fontSize: 11,
            color: 'var(--muted)',
            marginTop: 14,
            letterSpacing: '0.15em',
            textTransform: 'uppercase',
          }}
        >
          Position #{queuePosition} in queue
        </div>
      )}

      <div
        style={{
          marginTop: 26,
          fontSize: 10,
          letterSpacing: '0.3em',
          textTransform: 'uppercase',
          color: 'var(--muted)',
        }}
      >
        {pending ? 'You can close this — your request is locked in' : 'Closing…'}
      </div>
    </div>
  );
}

// Context-aware chip row. Each chip is a two-line button: the prompt text on
// top, a small attribution caption underneath ("more <artist>", "weather",
// "festival", "right now", "random"). Listeners see *why* a suggestion is
// being offered instead of a flat canned list.
function SuggestionChips({ nowPlaying, context, onPick }) {
  const chips = useMemo(
    () => buildSuggestions(nowPlaying, context),
    [nowPlaying?.artist, nowPlaying?.title, context?.festival?.name,
     context?.time?.vibe, context?.time?.show, context?.weather?.condition]
  );

  return (
    <div className="flex flex-wrap" style={{ gap: 6, margin: '18px 0' }}>
      {chips.map(chip => (
        <button
          key={chip.text}
          onClick={() => onPick(chip.text)}
          className="cursor-pointer v3-focus"
          style={{
            background: 'transparent',
            border: '1px solid var(--ink)',
            color: 'var(--ink)',
            padding: '6px 12px',
            fontFamily: 'inherit',
            textAlign: 'left',
            lineHeight: 1.15,
          }}
          title={`Suggested via ${chip.attribution}`}
        >
          <span style={{ display: 'block', fontSize: 11, letterSpacing: '0.08em' }}>
            {chip.text}
          </span>
          <span
            style={{
              display: 'block',
              fontSize: 8,
              letterSpacing: '0.22em',
              textTransform: 'uppercase',
              color: 'var(--muted)',
              marginTop: 3,
            }}
          >
            {chip.attribution}
          </span>
        </button>
      ))}
    </div>
  );
}
