'use client';

// Library — /admin/library. The operator searches the Navidrome library and
// pushes a chosen track straight into the queue (an admin-grade version of
// the listener request flow, without the LLM matching guesswork). A "Recently
// added" section surfaces the most recently added music for one-click queuing,
// and the mood tagger runs the resumable library tagger that classifies tracks.
import { useCallback, useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import { useAdminAuth } from '../../lib/adminAuth';
import { Input } from '../ui/input';
import { InputGroup, InputGroupAddon, InputGroupInput } from '../ui/input-group';
import { Field, FieldLabel } from '../ui/field';
import { Card, Btn, Pill, Eyebrow, Seg, Metric } from './ui';

export default function LibraryPanel() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);  // null = not searched yet
  const [searching, setSearching] = useState(false);
  const [queuing, setQueuing] = useState(null);   // id of the row being queued
  const [feedback, setFeedback] = useState(null); // { tone, text }
  const [recent, setRecent] = useState(null);     // null = not loaded yet
  const [loadingRecent, setLoadingRecent] = useState(false);
  const [tagState, setTagState] = useState(null); // { libraryStats, tagger }
  const [taggerLimit, setTaggerLimit] = useState('50');
  const [taggerBusy, setTaggerBusy] = useState(false);

  const ready = hydrated && !needsAuth;

  const loadRecent = useCallback(async () => {
    if (!ready) return;
    setLoadingRecent(true);
    try {
      const r = await adminFetch('/dj/recent?limit=25');
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `latest tracks failed (${r.status})`);
      setRecent(Array.isArray(j.results) ? j.results : []);
    } catch (err) {
      setFeedback({ tone: 'err', text: err.message });
      setRecent([]);
    } finally {
      setLoadingRecent(false);
    }
  }, [adminFetch, ready]);

  useEffect(() => { loadRecent(); }, [loadRecent]);

  // Library stats + tagger progress live on /settings — poll so an in-flight
  // tagging run reports live progress without a manual refresh.
  const loadTagState = useCallback(async () => {
    if (!ready) return;
    try {
      const r = await adminFetch('/settings');
      if (!r.ok) return;
      const j = await r.json();
      setTagState({ libraryStats: j.libraryStats, tagger: j.tagger });
    } catch { /* transient — next poll retries */ }
  }, [adminFetch, ready]);

  useEffect(() => {
    if (!ready) return;
    loadTagState();
    const id = setInterval(loadTagState, 3000);
    return () => clearInterval(id);
  }, [ready, loadTagState]);

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

  const startTagger = async () => {
    setTaggerBusy(true);
    setFeedback(null);
    try {
      const limit = parseInt(taggerLimit, 10);
      const r = await adminFetch('/tag-library', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `tagger start failed (${r.status})`);
      await loadTagState();
    } catch (err) {
      setFeedback({ tone: 'err', text: err.message });
    } finally {
      setTaggerBusy(false);
    }
  };

  const libraryStats = tagState?.libraryStats;
  const tagger = tagState?.tagger;

  const taggedTotal = libraryStats?.total ?? 0;
  const moodEntries = Object.entries(libraryStats?.byMood || {}).sort((a, b) => b[1] - a[1]);
  const resultCount = results === null ? null : results.length;

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {/* ── HERO SEARCH ─────────────────────────────────────────────────── */}
      <section className="card">
        <div style={{ padding: 16, display: 'grid', gridTemplateColumns: '1fr auto', gap: 16, alignItems: 'center', borderBottom: '1px solid var(--ink)' }}>
          <div>
            <Eyebrow color="var(--accent)">library · search · queue</Eyebrow>
            <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em', marginTop: 6 }}>
              Find a track. Queue it instantly.
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
              Search Navidrome by artist, title, or album — no LLM matching.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <Metric n={taggedTotal.toLocaleString('en-GB')} l="tracks tagged" />
            <span style={{ width: 1, height: 32, background: 'var(--separator-strong)' }} />
            <Metric n={moodEntries.length} l="moods" accent />
          </div>
        </div>

        <div style={{ padding: 16 }}>
          <form onSubmit={runSearch} style={{ display: 'flex', gap: 8 }}>
            <InputGroup className="flex-1">
              <InputGroupAddon>
                <Search />
              </InputGroupAddon>
              <InputGroupInput
                placeholder="floating points, kingdoms in colour, 2018…"
                value={query}
                onChange={e => setQuery(e.target.value)}
              />
            </InputGroup>
            <Btn lg tone="accent" type="submit" disabled={searching || !query.trim() || !ready}>
              {searching ? 'Searching…' : 'Search'}
            </Btn>
            <Btn lg type="button" onClick={() => { setQuery(''); setResults(null); }} disabled={searching}>
              Clear
            </Btn>
          </form>
          <div style={{ display: 'flex', gap: 14, marginTop: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="caption">filter</span>
            <Seg
              value="any"
              onChange={(id) => setQuery(id === 'any' ? query : id)}
              options={[
                { id: 'any', label: 'Any' },
                { id: 'ambient', label: 'Ambient' },
                { id: 'slow', label: 'Slow' },
                { id: 'driving', label: 'Driving' },
                { id: 'jazz', label: 'Jazz' },
                { id: 'deep', label: 'Deep' },
              ]}
            />
            <span className="caption" style={{ marginLeft: 12 }}>energy</span>
            <Seg
              value="any"
              options={[
                { id: 'any', label: 'Any' },
                { id: 'low', label: 'Low' },
                { id: 'mid', label: 'Mid' },
                { id: 'high', label: 'High' },
              ]}
            />
            <span style={{ marginLeft: 'auto', fontSize: 11, color: feedback ? (feedback.tone === 'err' ? 'var(--danger)' : 'var(--accent)') : 'var(--muted)' }}>
              {feedback
                ? feedback.text
                : resultCount === null
                  ? 'search the library to queue a track'
                  : `${resultCount} result${resultCount === 1 ? '' : 's'} · sorted by relevance`}
            </span>
          </div>
        </div>
      </section>

      {/* ── 2-COL ─────────────────────────────────────────────────────── */}
      <div className="stack-mobile" style={{ display: 'grid', gridTemplateColumns: '1fr 240px', gap: 16, alignItems: 'flex-start' }}>
        {/* RESULTS */}
        <div style={{ display: 'grid', gap: 16 }}>
          <Card
            title="Results"
            sub={query.trim() ? `for ‘${query.trim()}’` : 'manual queue'}
            bodyStyle={{ padding: '4px 14px' }}
          >
            {results === null ? (
              <Empty>search the library to queue a track</Empty>
            ) : results.length === 0 ? (
              <Empty>{searching ? 'searching…' : 'no tracks found'}</Empty>
            ) : (
              <TrackTable tracks={results} queuing={queuing} onQueue={queueTrack} />
            )}
          </Card>

          <Card
            title="Recently added"
            sub="latest tracks"
            right={
              <Btn sm onClick={loadRecent} disabled={loadingRecent || !ready}>
                {loadingRecent ? 'Loading…' : 'Refresh'}
              </Btn>
            }
          >
            {recent === null ? (
              <Empty>{loadingRecent ? 'loading latest tracks…' : 'recently added tracks appear here'}</Empty>
            ) : recent.length === 0 ? (
              <Empty>no recently added tracks</Empty>
            ) : (
              <div style={{ display: 'grid', gap: 8 }}>
                {recent.map(r => (
                  <div key={r.id} style={{
                    display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 12,
                    alignItems: 'center', padding: '6px 0',
                    borderBottom: '1px dashed var(--separator-strong)',
                  }}>
                    <div style={{ fontSize: 13, minWidth: 0 }}>
                      <span style={{ color: 'var(--ink)' }}>{r.title}</span>
                      <span style={{ color: 'var(--muted)' }}> — {r.artist}</span>
                      {r.album && <span style={{ color: 'var(--muted)' }}> · {r.album}</span>}
                    </div>
                    {r.duration != null && (
                      <span className="mono-num" style={{ fontSize: 10, color: 'var(--muted)' }}>{fmtDuration(r.duration)}</span>
                    )}
                    <Btn sm onClick={() => queueTrack(r)} disabled={!!queuing}>
                      {queuing === r.id ? 'Queuing…' : 'Queue'}
                    </Btn>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>

        {/* SIDEBAR */}
        <aside style={{ display: 'grid', gap: 16 }}>
          <Card title="Browse" bodyStyle={{ padding: 0 }}>
            <div style={{ padding: '4px 0' }}>
              {[
                { l: 'Search results', n: resultCount == null ? '—' : resultCount, a: true },
                { l: 'Recently added', n: recent == null ? '—' : recent.length },
                { l: 'Tracks tagged', n: taggedTotal.toLocaleString('en-GB') },
                { l: 'Moods classified', n: moodEntries.length },
              ].map(x => (
                <div key={x.l} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '8px 14px', fontSize: 12,
                  background: x.a ? 'var(--ink-soft)' : 'transparent',
                  borderLeft: x.a ? '2px solid var(--accent)' : '2px solid transparent',
                }}>
                  <span style={{ fontWeight: x.a ? 700 : 500 }}>{x.l}</span>
                  <span className="mono-num" style={{ fontSize: 10, color: 'var(--muted)' }}>{x.n}</span>
                </div>
              ))}
            </div>
          </Card>

          <Card title="By mood">
            {moodEntries.length === 0 ? (
              <div style={{ fontSize: 11, color: 'var(--muted)', fontStyle: 'italic' }}>
                run the tagger to classify your library
              </div>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {moodEntries.map(([m, n], i) => (
                  <Pill key={m} tone={i === 0 ? 'ink' : ''} onClick={() => setQuery(m)} title={`search “${m}”`}>
                    {m}
                    <span className="mono-num" style={{ marginLeft: 4, color: i === 0 ? 'var(--ink)' : 'var(--muted)' }}>{n}</span>
                  </Pill>
                ))}
              </div>
            )}
          </Card>

          <Card title="Mood tagger">
            <div style={{ fontSize: 12, color: 'var(--ink)', fontWeight: 700 }}>
              {taggedTotal} tracks tagged
            </div>
            {libraryStats?.updatedAt && (
              <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>
                last update {new Date(libraryStats.updatedAt).toLocaleString('en-GB')}
              </div>
            )}
            <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.5, marginTop: 6 }}>
              Walks Navidrome album-by-album, classifies each track via Ollama. Resumable —
              tagged tracks are skipped.
            </div>

            <Field className="mt-3">
              <FieldLabel htmlFor="tagger-limit">limit</FieldLabel>
              <Input
                id="tagger-limit"
                type="number"
                className="mono-num"
                value={taggerLimit}
                onChange={e => setTaggerLimit(e.target.value)}
                disabled={tagger?.running}
              />
            </Field>
            <Btn
              tone="accent"
              onClick={startTagger}
              disabled={taggerBusy || tagger?.running || !ready}
              style={{ marginTop: 10, width: '100%', justifyContent: 'center' }}
            >
              {tagger?.running ? 'Running…' : 'Start tagging'}
            </Btn>
            {tagger?.running && tagger.startedAt && (
              <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 8 }}>
                pid {tagger.pid} · started {new Date(tagger.startedAt).toLocaleTimeString('en-GB')}
              </div>
            )}

            {tagger?.lastLog?.length > 0 && (
              <details style={{ marginTop: 12, border: '1px solid var(--separator-strong)' }}>
                <summary className="caption" style={{ padding: '8px 10px', cursor: 'pointer' }}>
                  tagger log ({tagger.lastLog.length} lines)
                </summary>
                <pre className="term" style={{ maxHeight: 240, margin: 0, borderTop: '1px solid var(--separator-strong)' }}>
                  {tagger.lastLog.join('\n')}
                </pre>
              </details>
            )}
          </Card>
        </aside>
      </div>
    </div>
  );
}

function TrackTable({ tracks, queuing, onQueue }) {
  const cols = '24px 1fr 150px 56px 70px';
  return (
    <div>
      <div style={{
        display: 'grid', gridTemplateColumns: cols, gap: 12, padding: '8px 6px',
        borderBottom: '1px solid var(--ink)',
        fontSize: 9, letterSpacing: '0.22em', textTransform: 'uppercase', fontWeight: 700, color: 'var(--muted)',
      }}>
        <span>#</span>
        <span>title</span>
        <span>album</span>
        <span style={{ textAlign: 'right' }}>dur</span>
        <span />
      </div>
      {tracks.map((t, i) => (
        <div key={t.id} style={{
          display: 'grid', gridTemplateColumns: cols, gap: 12, padding: '9px 6px',
          alignItems: 'center', fontSize: 12,
          borderBottom: '1px dashed var(--separator-strong)',
        }}>
          <span className="mono-num" style={{ fontSize: 10, color: 'var(--muted)' }}>{String(i + 1).padStart(2, '0')}</span>
          <div style={{ minWidth: 0 }}>
            <div style={{ color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</div>
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>{t.artist}</div>
          </div>
          <span style={{ color: 'var(--muted)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.album || '—'}</span>
          <span className="mono-num" style={{ fontSize: 11, color: 'var(--muted)', textAlign: 'right' }}>
            {t.duration != null ? fmtDuration(t.duration) : '—'}
          </span>
          <Btn sm onClick={() => onQueue(t)} disabled={!!queuing}>
            {queuing === t.id ? 'Queuing…' : 'Queue'}
          </Btn>
        </div>
      ))}
    </div>
  );
}

function fmtDuration(s) {
  const sec = Math.max(0, Math.round(s));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

function Empty({ children }) {
  return <div style={{ fontStyle: 'italic', color: 'var(--muted)', fontSize: 12, padding: '10px 0' }}>{children}</div>;
}
