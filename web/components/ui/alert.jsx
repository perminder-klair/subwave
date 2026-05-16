'use client';

/* V3 Alert — sharp, bordered inline callout for page-level messages (controller
   errors, notices). `tone` is "error" (vermilion) or "info" (ink). Replaces the
   ad-hoc bordered <div>s that each admin panel used to hand-roll. */
export function V3Alert({ tone = 'info', title, children }) {
  const color = tone === 'error' ? '#c5302a' : 'var(--ink)';
  return (
    <div role="alert" style={{ border: `1px solid ${color}`, color }}>
      {title && (
        <div
          className="v3-eyebrow px-3 py-1.5"
          style={{ fontSize: 10, borderBottom: `1px solid ${color}` }}
        >
          {title}
        </div>
      )}
      <div style={{ padding: '8px 12px', fontSize: 13, lineHeight: 1.5 }}>
        {children}
      </div>
    </div>
  );
}
