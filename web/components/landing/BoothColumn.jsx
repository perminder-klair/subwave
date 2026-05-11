'use client';

function fmtClock(ts) {
  if (!ts) return '--:--';
  const d = new Date(ts);
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

const KIND_LABEL = {
  said: 'SAID',
  weather: 'WX',
  'station-id': 'IDENT',
  request: 'REQ',
  miss: 'MISS',
  scheduler: 'OPS',
  error: 'ERR',
};

// Marketing fallback — believable, varied entries the DJ would actually
// log. Used only when live djLog is empty. Times are computed at render
// so the booth always feels recent.
function buildExamples() {
  const now = Date.now();
  const m = (mins) => new Date(now - mins * 60000).toISOString();
  return [
    { kind: 'said',       at: m(2),  message: 'Drizzle holding off for another hour, apparently. We\'ll take it. That was Stereolab.' },
    { kind: 'request',    at: m(6),  message: 'aanya: "something for the kitchen on a Sunday"' },
    { kind: 'said',       at: m(9),  message: 'Listener wants kitchen-on-a-Sunday energy. We can do that. Caribou next.' },
    { kind: 'weather',    at: m(18), message: 'Light cloud, 11°C, wind from the southwest. Same as an hour ago. The DJ noticed.' },
    { kind: 'station-id', at: m(27), message: 'You\'re tuned to SUB/WAVE.' },
    { kind: 'said',       at: m(34), message: 'Talk Talk into Boards of Canada is not legal in this country but we\'re doing it anyway.' },
    { kind: 'scheduler',  at: m(45), message: 'auto-playlist refreshed · mood: evening-warm-cloudy' },
    { kind: 'miss',       at: m(58), message: 'jay: "play that one disco song" — couldn\'t find a match. Sorry.' },
  ];
}

export default function BoothColumn({ items = [] }) {
  const live = items.slice(0, 6);
  const recent = live.length > 0 ? live : buildExamples();
  const isExample = live.length === 0;

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div className="bs-eyebrow" style={{ flex: '1 1 auto' }}>FROM THE BOOTH</div>
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
            example feed
          </span>
        )}
      </div>

      <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)', lineHeight: 1.5, maxWidth: '60ch' }}>
        Everything the DJ says, asks, plays, or skips lands in the booth
        log. {isExample
          ? 'Below is what a busy hour looks like — yours will fill in as the station broadcasts.'
          : 'Live, from the past hour.'}
      </p>

      <div>
        {recent.map((it, i) => (
          <div key={i} className="bs-row">
            <time>{fmtClock(it.timestamp || it.at)}</time>
            <div>
              <span
                style={{
                  fontSize: 10,
                  letterSpacing: '0.18em',
                  color: 'var(--accent)',
                  fontWeight: 700,
                  marginRight: 8,
                }}
              >
                {KIND_LABEL[it.kind] || (it.kind || '').toUpperCase().slice(0, 5) || '—'}
              </span>
              <span style={{ color: 'var(--ink)' }}>{it.message || it.text || ''}</span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
