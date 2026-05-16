'use client';

/* Shared newsprint primitives for the redesigned admin panels.
   Every panel renders inside AdminShell's `.admin-root` wrapper, so the
   unprefixed class names (.card / .btn / .tag …) resolve to the admin-scoped
   rules in globals.css. */

export function Eyebrow({ children, color, style }) {
  return (
    <span className="eyebrow" style={{ color: color || 'var(--muted)', ...style }}>
      {children}
    </span>
  );
}

export function Card({ title, sub, right, children, bodyStyle, headStyle, bodyClass, style }) {
  return (
    <section className="card" style={style}>
      {(title || right) && (
        <div className="card-head" style={headStyle}>
          {title && <span className="title">{title}</span>}
          {sub && <span className="sub">{sub}</span>}
          {right && <span className="right">{right}</span>}
        </div>
      )}
      <div className={`card-body ${bodyClass || ''}`} style={bodyStyle}>{children}</div>
    </section>
  );
}

export function Pill({ children, tone, dot, style, onClick, title }) {
  return (
    <span
      className={`tag ${tone || ''} ${dot ? 'dot' : ''}`}
      style={{ ...(onClick ? { cursor: 'pointer' } : null), ...style }}
      onClick={onClick}
      title={title}
    >
      {children}
    </span>
  );
}

export function Btn({ children, tone, sm, lg, style, onClick, disabled, type, title }) {
  const cls = `btn ${tone ? 'btn-' + tone : ''} ${sm ? 'btn-sm' : ''} ${lg ? 'btn-lg' : ''}`;
  return (
    <button className={cls} style={style} onClick={onClick} disabled={disabled} type={type || 'button'} title={title}>
      {children}
    </button>
  );
}

/* Segmented control. `options` is [{ id, label }]; `onChange(id)` fires on click. */
export function Seg({ value, options, accent, onChange }) {
  return (
    <div className={`seg ${accent ? 'accent' : ''}`}>
      {options.map(o => (
        <button
          key={o.id}
          className={o.id === value ? 'active' : ''}
          onClick={onChange ? () => onChange(o.id) : undefined}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ on, onClick, disabled }) {
  return (
    <button
      className={`toggle ${on ? 'on' : ''}`}
      aria-pressed={!!on}
      onClick={onClick}
      disabled={disabled}
    />
  );
}

export function Metric({ n, l, accent }) {
  return (
    <div className={`metric ${accent ? 'accent' : ''}`}>
      <div className="n mono-num">{n}</div>
      <div className="l">{l}</div>
    </div>
  );
}

/* Stable seeded pseudo-random waveform bars. */
export function Wave({ bars = 60, seed = 1, h = 60, tone = '', maxHeight }) {
  const out = [];
  let x = seed * 9301 + 49297;
  for (let i = 0; i < bars; i++) {
    x = (x * 9301 + 49297) % 233280;
    out.push(Math.round(8 + (x / 233280) * (h - 8)));
  }
  return (
    <div className={`wave ${tone}`} style={{ height: h, maxHeight: maxHeight || h }}>
      {out.map((b, i) => <span key={i} style={{ height: b }} />)}
    </div>
  );
}
