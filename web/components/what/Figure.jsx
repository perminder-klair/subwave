'use client';

// Screenshot slot for the /what feature story. While `src` is empty it renders
// a labelled placeholder box; pass `src` later and the same component swaps in
// the real image — no layout change. Inline styles only, no globals.css edits.
export default function Figure({ src, alt, caption, label, ratio = '16 / 10' }) {
  return (
    <figure style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
      {src ? (
        <img
          src={src}
          alt={alt || caption || label || ''}
          style={{
            display: 'block',
            width: '100%',
            border: '1px solid var(--ink)',
            aspectRatio: ratio,
            objectFit: 'cover',
          }}
        />
      ) : (
        <div
          role="img"
          aria-label={alt || `Placeholder: ${label}`}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            textAlign: 'center',
            padding: 16,
            aspectRatio: ratio,
            border: '1px dashed var(--separator-strong)',
            background: 'var(--overlay)',
          }}
        >
          <span
            style={{
              fontSize: 11,
              letterSpacing: '0.24em',
              textTransform: 'uppercase',
              fontWeight: 700,
              color: 'var(--muted)',
            }}
          >
            {label || 'Screenshot'}
          </span>
        </div>
      )}
      {caption && (
        <figcaption
          style={{
            fontSize: 10,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            color: 'var(--muted)',
            fontWeight: 500,
          }}
        >
          <span style={{ color: 'var(--accent)', fontWeight: 700 }}>FIG.&nbsp;</span>
          {caption}
        </figcaption>
      )}
    </figure>
  );
}
