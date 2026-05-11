'use client';

function fmtClock(ts) {
  if (!ts) return '--:--';
  const d = new Date(ts);
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

// Marketing fallback when no live history yet. The selection signals the
// taste — late-night, eclectic, no-shame Punjabi sprinkled in, a request
// or two — exactly the kind of run the LLM picker is meant to produce.
function buildExamples() {
  const now = Date.now();
  const m = (mins) => new Date(now - mins * 60000).toISOString();
  return [
    { playedAt: m(3),  track: { title: 'Roygbiv',          artist: 'Boards of Canada' } },
    { playedAt: m(8),  track: { title: 'Odessa',           artist: 'Caribou' },          requestedBy: 'aanya' },
    { playedAt: m(13), track: { title: 'It\'s My Life',    artist: 'Talk Talk' } },
    { playedAt: m(19), track: { title: 'Tunak Tunak Tun',  artist: 'Daler Mehndi' },     requestedBy: 'parm' },
    { playedAt: m(25), track: { title: 'Untitled #3',      artist: 'Sigur Rós' } },
    { playedAt: m(31), track: { title: 'Dolphin',          artist: 'Stereolab' } },
    { playedAt: m(38), track: { title: 'In the Aeroplane Over the Sea', artist: 'Neutral Milk Hotel' } },
    { playedAt: m(45), track: { title: 'Anaadi',           artist: 'Diljit Dosanjh' } },
  ];
}

export default function RecentPlays({ items = [] }) {
  const live = items.slice(0, 8);
  const recent = live.length > 0 ? live : buildExamples();
  const isExample = live.length === 0;

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div className="bs-eyebrow" style={{ flex: '1 1 auto' }}>WHAT'S BEEN PLAYED</div>
        {isExample && (
          <span style={{
            color: 'var(--muted)',
            fontSize: 10,
            letterSpacing: '0.18em',
            fontWeight: 600,
            border: '1px solid var(--separator-strong)',
            padding: '3px 7px',
            textTransform: 'uppercase',
          }}>
            example set
          </span>
        )}
      </div>

      <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)', lineHeight: 1.5, maxWidth: '60ch' }}>
        Every track that gets aired stacks up here. {isExample
          ? 'The taste below is illustrative — late-night, eclectic, with the odd request thrown in. Yours will look however the DJ picks.'
          : 'Live, most recent first.'}
      </p>

      <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {recent.map((it, i) => {
          const t = it.track || it;
          return (
            <li key={i} className="bs-row">
              <time>{fmtClock(it.playedAt || it.at || it.timestamp)}</time>
              <div>
                <span style={{ color: 'var(--ink)', fontWeight: 600 }}>{t.title || '—'}</span>
                <span style={{ color: 'var(--muted)' }}> — {t.artist || ''}</span>
                {it.requestedBy && it.requestedBy !== 'auto' && (
                  <span style={{
                    marginLeft: 8,
                    fontSize: 10,
                    letterSpacing: '0.18em',
                    color: 'var(--accent)',
                    textTransform: 'uppercase',
                  }}>
                    ← {it.requestedBy}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
