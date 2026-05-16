'use client';

// Library — /admin/library. The operator searches the Navidrome library and
// pushes a chosen track straight into the queue (an admin-grade version of
// the listener request flow, without the LLM matching guesswork).
import { useState } from 'react';
import { useAdminAuth } from '../../lib/adminAuth';

export default function LibraryPanel() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);  // null = not searched yet
  const [searching, setSearching] = useState(false);
  const [queuing, setQueuing] = useState(null);   // id of the row being queued
  const [feedback, setFeedback] = useState(null); // { tone, text }

  const ready = hydrated && !needsAuth;

  const runSearch = async (e) => {
    e?.preventDefault();
    const q = query.trim();
    if (!q || !ready) return;
    setSearching(true);
    setFeedback(null);
    try {
      const r = await adminFetch(`/dj/search?q=${encodeURIComponent(q)}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `search failed (${r.status})`);
      setResults(Array.isArray(j.results) ? j.results : []);
    } catch (err) {
      setFeedback({ tone: 'err', text: err.message });
      setResults([]);
    } finally {
      setSearching(false);
    }
  };

  const queueTrack = async (track) => {
    setQueuing(track.id);
    setFeedback(null);
    try {
      const r = await adminFetch('/dj/queue-track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(track),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `queue failed (${r.status})`);
      setFeedback({
        tone: 'ok',
        text: `queued “${j.track?.title || track.title}” · position ${j.queuePosition}`,
      });
    } catch (err) {
      setFeedback({ tone: 'err', text: err.message });
    } finally {
      setQueuing(null);
    }
  };

  return (
    <div className="space-y-4" style={{ fontSize: 12 }}>
      <div className="flex flex-wrap items-center gap-3 pb-3" style={{ borderBottom: '1px solid var(--ink)' }}>
        <span className="v3-caption" style={{ color: 'var(--ink)' }}>library</span>
        <span className="v3-caption" style={{ color: 'var(--muted)' }}>search · queue a track</span>
        {feedback && (
          <span style={{ marginLeft: 'auto', fontSize: 11, color: feedback.tone === 'err' ? '#c5302a' : 'var(--accent)' }}>
            {feedback.text}
          </span>
        )}
      </div>

      <Section title="Manual queue">
        <form onSubmit={runSearch} className="flex gap-2">
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Artist, title, album…"
            style={{
              boxSizing: 'border-box', flex: 1,
              border: '1px solid var(--ink)', background: 'transparent',
              padding: '8px 12px', fontSize: 13, fontFamily: 'inherit',
              color: 'var(--ink)', outline: 'none',
            }}
          />
          <button
            type="submit"
            disabled={searching || !query.trim() || !ready}
            className="v3-eyebrow v3-focus cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            style={{
              background: 'var(--accent)', color: '#fff',
              border: '1px solid var(--accent)', padding: '8px 18px', fontSize: 10,
            }}
          >
            {searching ? 'searching…' : 'search'}
          </button>
        </form>

        <div className="mt-3">
          {results === null ? (
            <Empty>search the library to queue a track</Empty>
          ) : results.length === 0 ? (
            <Empty>no tracks found</Empty>
          ) : (
            <ul className="space-y-1">
              {results.map(t => (
                <li key={t.id} className="flex items-center gap-3">
                  <span className="truncate flex-1" style={{ color: 'var(--ink)' }}>
                    {t.title} <span style={{ color: 'var(--muted)' }}>— {t.artist}</span>
                    {t.album && <span style={{ color: 'var(--muted)' }}> · {t.album}</span>}
                  </span>
                  {t.duration != null && (
                    <span className="v3-tab-num shrink-0" style={{ color: 'var(--muted)' }}>
                      {fmtDuration(t.duration)}
                    </span>
                  )}
                  <button
                    onClick={() => queueTrack(t)}
                    disabled={!!queuing}
                    className="v3-eyebrow v3-focus cursor-pointer shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
                    style={{
                      border: '1px solid var(--ink)', background: 'transparent',
                      color: 'var(--ink)', padding: '5px 12px', fontSize: 10,
                    }}
                  >
                    {queuing === t.id ? 'queuing…' : 'queue'}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Section>
    </div>
  );
}

function fmtDuration(s) {
  const sec = Math.max(0, Math.round(s));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

function Section({ title, children }) {
  return (
    <section style={{ border: '1px solid var(--ink)' }}>
      <div className="px-3 py-2" style={{ borderBottom: '1px solid var(--ink)' }}>
        <span className="v3-caption" style={{ color: 'var(--ink)' }}>{title}</span>
      </div>
      <div className="p-3">{children}</div>
    </section>
  );
}

function Empty({ children }) {
  return <div className="italic" style={{ color: 'var(--muted)' }}>{children}</div>;
}
