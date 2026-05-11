'use client';

import { useEffect, useRef, useState } from 'react';

const MOOD_CHIPS = [
  'late-night driving',
  'more like this',
  'something punjabi',
  'surprise me',
  'rainy day',
];

const SUCCESS_HOLD_MS = 2800;

export default function RequestDrawer({
  requestText, setRequestText,
  requesterName, setRequesterName,
  isSubmitting, onSubmit, onClose,
}) {
  const taRef = useRef(null);
  // `result` mirrors the controller response: { success, ack, track, message }.
  // Null while idle; rendered as a success card or inline miss banner.
  const [result, setResult] = useState(null);
  const closeTimerRef = useRef(null);

  useEffect(() => () => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
  }, []);

  const handleSubmit = async () => {
    const data = await onSubmit();
    if (!data) return;
    setResult(data);
    if (data.success && onClose) {
      // Hold the success card briefly so the listener sees what got queued,
      // then slide the drawer shut and reset for next time.
      closeTimerRef.current = setTimeout(() => {
        onClose();
        // Defer state reset until after the close animation so the form
        // doesn't flash back in during the slide.
        setTimeout(() => setResult(null), 300);
      }, SUCCESS_HOLD_MS);
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

      <div className="flex flex-wrap" style={{ gap: 6, margin: '18px 0' }}>
        {MOOD_CHIPS.map(m => (
          <button
            key={m}
            onClick={() => { setRequestText(m); taRef.current?.focus(); }}
            className="cursor-pointer v3-focus"
            style={{
              background: 'transparent',
              border: '1px solid var(--ink)',
              color: 'var(--ink)',
              padding: '6px 12px',
              fontSize: 11,
              letterSpacing: '0.1em',
              fontFamily: 'inherit',
            }}
          >
            {m}
          </button>
        ))}
      </div>

      <input
        type="text"
        value={requesterName}
        onChange={e => setRequesterName(e.target.value)}
        placeholder="your name (optional)"
        className="w-full v3-focus"
        style={{
          boxSizing: 'border-box',
          border: '1px solid var(--ink)',
          background: 'transparent',
          padding: 10,
          fontSize: 13,
          fontFamily: 'inherit',
          color: 'var(--ink)',
          marginBottom: 8,
        }}
      />

      <textarea
        ref={taRef}
        value={requestText}
        onChange={e => { setRequestText(e.target.value); if (result) setResult(null); }}
        onKeyDown={onKeyDown}
        placeholder='"something for late-night driving"…'
        rows={3}
        className="w-full v3-focus"
        style={{
          resize: 'none',
          boxSizing: 'border-box',
          border: '1px solid var(--ink)',
          background: 'transparent',
          padding: 14,
          fontSize: 16,
          fontFamily: 'inherit',
          color: 'var(--ink)',
          outline: 'none',
        }}
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

      <button
        onClick={handleSubmit}
        disabled={isSubmitting || !requestText.trim()}
        className="w-full v3-eyebrow v3-focus mt-3 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
        style={{
          background: 'var(--accent)',
          color: '#fff',
          border: 'none',
          padding: '14px 24px',
        }}
      >
        {isSubmitting ? 'Sending…' : 'Send to the booth'}
      </button>
    </div>
  );
}

function SuccessCard({ result }) {
  const { ack, track, queuePosition } = result;
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
        ✓ Queued
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
          Now in the booth
        </div>
        <div style={{ fontSize: 22, fontWeight: 600, lineHeight: 1.15, color: 'var(--ink)' }}>
          {track?.title}
        </div>
        <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>
          {track?.artist}
        </div>
      </div>

      {typeof queuePosition === 'number' && queuePosition > 0 && (
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
        Closing…
      </div>
    </div>
  );
}
