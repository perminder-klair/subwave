'use client';

import { useMemo, useState } from 'react';

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'dj', label: 'DJ' },
  { id: 'system', label: 'System' },
];

// Voice = anything the DJ actually speaks on-air.
const VOICE_KINDS = new Set(['dj-speak', 'station-id', 'link', 'hourly-check', 'weather']);
const DJ_KINDS = new Set([...VOICE_KINDS, 'ai-pick', 'request', 'playing', 'queued', 'miss']);

function shortTime(t) {
  try {
    return new Date(t).toLocaleTimeString('en-GB', { hour12: false });
  } catch {
    return String(t || '');
  }
}

function kindColor(kind) {
  if (VOICE_KINDS.has(kind)) return 'var(--accent)';
  switch (kind) {
    case 'playing': return 'var(--ink)';
    case 'request': return 'var(--accent)';
    case 'ai-pick':
    case 'queued':  return 'var(--muted)';
    case 'error':
    case 'miss':    return '#c0392b';
    case 'scheduler': return 'var(--muted)';
    default: return 'var(--muted)';
  }
}

export default function BoothDrawer({ items }) {
  const [filter, setFilter] = useState('all');

  const filtered = useMemo(() => {
    if (!items?.length) return [];
    if (filter === 'all') return items;
    return items.filter((e) => {
      const isDj = DJ_KINDS.has(e.kind);
      return filter === 'dj' ? isDj : !isDj;
    });
  }, [items, filter]);

  return (
    <div>
      <div
        className="flex gap-1"
        style={{ padding: '2px 0 14px', borderBottom: '1px solid var(--soft-border)' }}
      >
        {FILTERS.map((f) => {
          const active = filter === f.id;
          return (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              className="sw-focus"
              style={{
                fontSize: 10,
                letterSpacing: '0.25em',
                textTransform: 'uppercase',
                padding: '4px 10px',
                border: `1px solid ${active ? 'var(--ink)' : 'var(--soft-border)'}`,
                background: active ? 'var(--ink)' : 'transparent',
                color: active ? 'var(--bg)' : 'var(--muted)',
                cursor: 'pointer',
                transition: 'all 120ms ease',
              }}
            >
              {f.label}
            </button>
          );
        })}
      </div>

      {filtered.length === 0 && (
        <div
          style={{
            color: 'var(--muted)',
            fontSize: 13,
            lineHeight: 1.6,
            padding: '18px 0',
            fontStyle: 'italic',
          }}
        >
          {items?.length ? 'Nothing in this view.' : 'Booth is quiet. Awaiting transmission…'}
        </div>
      )}

      {filtered.map((e) => {
        const isVoice = VOICE_KINDS.has(e.kind);
        const color = kindColor(e.kind);
        return (
          <div
            key={e.id}
            style={{
              padding: '12px 0',
              borderBottom: '1px solid var(--soft-border)',
              borderLeft: isVoice ? `2px solid var(--accent)` : 'none',
              paddingLeft: isVoice ? 12 : 0,
              marginLeft: isVoice ? -12 : 0,
            }}
          >
            <div className="flex items-baseline gap-2" style={{ marginBottom: 4 }}>
              <span
                className="v3-tab-num"
                style={{ fontSize: 10, color: 'var(--muted)', minWidth: 56 }}
              >
                {shortTime(e.t)}
              </span>
              <span
                style={{
                  fontSize: 9,
                  letterSpacing: '0.3em',
                  textTransform: 'uppercase',
                  color,
                  fontWeight: 600,
                }}
              >
                {e.kind}
              </span>
            </div>
            <div
              style={{
                fontSize: isVoice ? 14 : 13,
                color: isVoice ? 'var(--ink)' : 'var(--ink)',
                fontStyle: isVoice ? 'italic' : 'normal',
                fontFamily: isVoice ? 'Georgia, "Times New Roman", serif' : undefined,
                lineHeight: 1.45,
                wordBreak: 'break-word',
              }}
            >
              {isVoice ? `“${e.message}”` : e.message}
            </div>
            <MetaLine kind={e.kind} meta={e.meta} />
          </div>
        );
      })}
    </div>
  );
}

function MetaLine({ kind, meta }) {
  if (!meta) return null;
  const bits = [];
  if (meta.requestedBy) bits.push(`req by ${meta.requestedBy}`);
  if (meta.source && kind === 'playing') bits.push(`source: ${meta.source}`);
  if (typeof meta.queueDepth === 'number' && kind === 'queued') {
    bits.push(`depth ${meta.queueDepth}`);
  }
  const reason = meta.reason;
  if (!bits.length && !reason) return null;
  return (
    <div style={{ marginTop: 4 }}>
      {bits.length > 0 && (
        <div
          style={{
            fontSize: 9,
            letterSpacing: '0.25em',
            textTransform: 'uppercase',
            color: 'var(--muted)',
          }}
        >
          {bits.join(' · ')}
        </div>
      )}
      {reason && (
        <div
          style={{
            fontSize: 11,
            color: 'var(--muted)',
            lineHeight: 1.4,
            marginTop: 2,
            fontStyle: 'italic',
          }}
        >
          ↳ {reason}
        </div>
      )}
    </div>
  );
}
