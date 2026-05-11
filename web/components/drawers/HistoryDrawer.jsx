'use client';

import { relTime } from '../../lib/format';

export default function HistoryDrawer({ items }) {
  if (!items?.length) {
    return (
      <div style={{ color: 'var(--muted)', fontSize: 13, lineHeight: 1.6 }}>
        Nothing played yet.
      </div>
    );
  }
  return (
    <div>
      {items.map((t, i) => (
        <div
          key={i}
          className="flex justify-between items-baseline gap-3"
          style={{ padding: '11px 0', borderBottom: '1px solid var(--separator-soft)' }}
        >
          <div className="min-w-0">
            <div style={{ fontSize: 14, color: 'var(--ink)' }} className="truncate">{t.title}</div>
            <div style={{ fontSize: 11, color: 'var(--muted)' }} className="truncate">{t.artist}</div>
          </div>
          {t.t && (
            <span
              className="v3-tab-num shrink-0"
              style={{
                fontSize: 10,
                letterSpacing: '0.2em',
                color: 'var(--muted)',
                textTransform: 'uppercase',
              }}
            >
              {relTime(t.t)} ago
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
