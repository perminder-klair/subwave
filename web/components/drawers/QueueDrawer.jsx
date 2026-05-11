'use client';

export default function QueueDrawer({ items }) {
  if (!items?.length) {
    return (
      <div style={{ color: 'var(--muted)', fontSize: 13, lineHeight: 1.6 }}>
        Empty queue. The DJ is on autopilot — request a track to jump the line.
      </div>
    );
  }
  return (
    <div>
      {items.map((t, i) => (
        <div
          key={i}
          className="flex gap-[14px] items-baseline"
          style={{ padding: '14px 0', borderBottom: '1px solid var(--separator-strong)' }}
        >
          <span
            className="v3-tab-num"
            style={{ fontSize: 28, fontWeight: 200, color: 'var(--muted)', width: 36 }}
          >
            {String(i + 1).padStart(2, '0')}
          </span>
          <div className="flex-1 min-w-0">
            <div style={{ fontSize: 18, fontWeight: 600, lineHeight: 1.2 }}>{t.title}</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{t.artist}</div>
            {t.requestedBy && (
              <div
                style={{
                  fontSize: 9,
                  letterSpacing: '0.3em',
                  textTransform: 'uppercase',
                  color: 'var(--accent)',
                  marginTop: 4,
                }}
              >
                ↳ requested by {t.requestedBy}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
