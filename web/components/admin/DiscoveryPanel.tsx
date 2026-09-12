'use client';

import { useEffect, useMemo, useState } from 'react';
import { useAdminAuth } from '../../lib/adminAuth';
import { Btn, Card, Eyebrow } from './ui';
import { Textarea } from '../ui/textarea';

type ToolInfo = { name: string; available: boolean; description: string | null };
type Catalog = { current: { id?: string; title?: string; artist?: string; genre?: string } | null; tools: ToolInfo[] };
type Track = { id: string; title: string; artist: string };
type ComparisonRow = { round: number; source: string; tracks: Track[] };
type ShowCriteria = {
  name: string;
  topic: string;
  strict: boolean;
  moods: string[];
  genres: string[];
  energies: string[];
  eras: Array<{ fromYear?: number | null; toYear?: number | null }>;
  vocals: string | null;
  playlistStrict: boolean;
  playlistCount: number;
};
type RouteOutcome = { selected: Track | null; elapsedMs: number; llmCalls: number; tokens: number | null; fallback: string };
type Comparison = {
  current: Track | null;
  showCriteria: ShowCriteria | null;
  agentic: ComparisonRow[];
  shortlist: ComparisonRow[];
  outcomes: { agentic: RouteOutcome; shortlist: RouteOutcome };
};

const DEFAULTS: Record<string, (current: Catalog['current']) => Record<string, unknown>> = {
  similarSongs: (current) => ({ songId: current?.id || '' }),
  tracksLikeThis: (current) => ({ songId: current?.id || '' }),
  tracksThatSoundLikeThis: (current) => ({ songId: current?.id || '' }),
  searchLibrary: (current) => ({ query: current?.artist || current?.title || '' }),
  topSongsByArtist: (current) => ({ artist: current?.artist || '' }),
  recentByArtist: (current) => ({ artist: current?.artist || '' }),
  songsByGenre: (current) => ({ genre: current?.genre || '' }),
  tracksByMood: () => ({ mood: 'night', energy: null }),
  tracksByEnergy: () => ({ energy: 'medium' }),
  searchByLyrics: () => ({ query: '' }),
  searchBySound: () => ({ query: '' }),
};

function trackLabel(track: Track | null) {
  return track ? `${track.artist || 'Unknown artist'} — ${track.title || 'Unknown track'}` : 'None';
}

function erasLabel(eras: ShowCriteria['eras']) {
  return eras.length ? eras.map(({ fromYear, toYear }) => `${fromYear ?? '…'}–${toYear ?? '…'}`).join(', ') : 'Any';
}

function listLabel(values: string[] | null | undefined) {
  return values?.length ? values.join(', ') : 'Any';
}

function formatDuration(elapsedMs: number) {
  return `${(elapsedMs / 1000).toFixed(elapsedMs >= 10_000 ? 1 : 2)} s`;
}

function criteriaSummary(criteria: ShowCriteria | null) {
  if (!criteria) return 'No active show — no show-specific criteria.';
  const parts = [
    `${criteria.name || 'Unnamed show'} (${criteria.strict ? 'strict' : 'advisory'} filters)`,
    `moods: ${listLabel(criteria.moods)}`,
    `genres: ${listLabel(criteria.genres)}`,
    `energy: ${listLabel(criteria.energies)}`,
    `eras: ${erasLabel(criteria.eras)}`,
  ];
  if (criteria.topic) parts.splice(1, 0, `topic: ${criteria.topic}`);
  if (criteria.vocals) parts.push(`vocals: ${criteria.vocals}`);
  if (criteria.playlistStrict || criteria.playlistCount) parts.push(`playlist: ${criteria.playlistStrict ? 'strict, ' : ''}${criteria.playlistCount} configured`);
  return parts.join(' · ');
}

function markdownEscape(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
}

function comparisonMarkdown(comparison: Comparison) {
  const route = (title: string, rows: ComparisonRow[], outcome: RouteOutcome) => [
    `### ${title}`,
    '',
    `- Selected track: ${trackLabel(outcome.selected)}`,
    `- Latency: ${formatDuration(outcome.elapsedMs)}`,
    `- Recorded LLM calls: ${outcome.llmCalls}`,
    `- Tokens: ${outcome.tokens?.toLocaleString() ?? 'Not recorded'}`,
    `- Fallback outcome: ${outcome.fallback}`,
    '',
    '| Round | Tool / source | Returned tracks |',
    '| --- | --- | --- |',
    ...rows.map((row) => `| ${row.round} | ${markdownEscape(row.source)} | ${row.tracks.length ? row.tracks.map((track) => markdownEscape(trackLabel(track))).join('<br>') : '—'} |`),
    '',
  ];
  const criteria = comparison.showCriteria;
  return [
    '## Paired discovery comparison',
    '',
    `- Current track: ${trackLabel(comparison.current)}`,
    '',
    '### Active show criteria',
    '',
    `- Show: ${criteria?.name || 'No active show'}`,
    `- Topic: ${criteria?.topic || 'None'}`,
    `- Filter mode: ${criteria ? (criteria.strict ? 'Strict' : 'Advisory') : 'N/A'}`,
    `- Moods: ${listLabel(criteria?.moods)}`,
    `- Genres: ${listLabel(criteria?.genres)}`,
    `- Energy: ${listLabel(criteria?.energies)}`,
    `- Eras: ${erasLabel(criteria?.eras ?? [])}`,
    `- Vocals: ${criteria?.vocals || 'Any'}`,
    `- Playlist: ${criteria ? `${criteria.playlistStrict ? 'Strict, ' : ''}${criteria.playlistCount} configured` : 'None'}`,
    '',
    ...route('Agentic Picker', comparison.agentic, comparison.outcomes.agentic),
    ...route('Track Shortlist', comparison.shortlist, comparison.outcomes.shortlist),
  ].join('\n');
}

export default function DiscoveryPanel() {
  const { adminFetch, hydrated, needsAuth } = useAdminAuth();
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [selected, setSelected] = useState<ToolInfo | null>(null);
  const [args, setArgs] = useState('{}');
  const [result, setResult] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [copied, setCopied] = useState(false);

  const ready = hydrated && !needsAuth;
  useEffect(() => {
    if (!ready) return;
    void (async () => {
      try {
        const r = await adminFetch('/debug/discovery');
        const body = await r.json();
        if (!r.ok) throw new Error(body?.error || `request failed (${r.status})`);
        setCatalog(body);
      } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    })();
  }, [adminFetch, ready]);

  const title = useMemo(() => catalog?.current
    ? `${catalog.current.title || 'Unknown track'} — ${catalog.current.artist || 'Unknown artist'}`
    : 'No live track', [catalog]);

  const choose = (tool: ToolInfo) => {
    setSelected(tool);
    setArgs(JSON.stringify(DEFAULTS[tool.name]?.(catalog?.current ?? null) ?? {}, null, 2));
    setResult(null);
    setError(null);
  };

  const run = async () => {
    if (!selected) return;
    let body: unknown;
    try { body = JSON.parse(args); } catch { setError('Tool input must be valid JSON.'); return; }
    setRunning(true); setError(null);
    try {
      const r = await adminFetch(`/debug/discovery/tool/${encodeURIComponent(selected.name)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const payload = await r.json();
      if (!r.ok) throw new Error(payload?.error || `request failed (${r.status})`);
      setResult(payload);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setRunning(false); }
  };

  const compare = async () => {
    setRunning(true); setError(null);
    try {
      const r = await adminFetch('/debug/discovery/compare', { method: 'POST' });
      const body = await r.json();
      if (!r.ok) throw new Error(body?.error || `request failed (${r.status})`);
      setComparison(body);
      setCopied(false);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setRunning(false); }
  };

  const copyComparison = async () => {
    if (!comparison) return;
    try {
      await navigator.clipboard.writeText(comparisonMarkdown(comparison));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not copy the Markdown report.'); }
  };

  return <div className="grid gap-4">
    <section className="card">
      <div className="border-b border-ink p-4">
        <Eyebrow className="text-vermilion">discovery bench</Eyebrow>
        <div className="mt-1.5 text-[22px] font-extrabold tracking-[-0.02em]">Run the DJ’s library tools, one at a time.</div>
        <p className="mt-1 text-[11px] leading-[1.6] text-muted">Individual tool checks are read-only. The comparison uses the live scope, records an Agentic Picker call and a shortlist editorial call, and never queues music.</p>
      </div>
      <div className="p-3 text-[12px]"><span className="text-muted">Current scope:</span> {title}</div>
      <div className="border-t border-ink p-3"><Btn sm onClick={compare} disabled={running}>{running ? 'Comparing…' : 'Compare 3 rounds vs 3 passes'}</Btn></div>
    </section>
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Card title="Discovery tools" sub="available tools mirror this pick’s current scope">
        <div className="grid gap-2">
          {catalog?.tools.map(tool => <div key={tool.name} className="flex items-center gap-3 border-b border-separator-soft pb-2 last:border-0">
            <div className="min-w-0 flex-1"><div className="font-mono text-[13px] font-bold">{tool.name}</div><div className="mt-0.5 text-[10px] leading-[1.45] text-muted">{tool.description || 'Unavailable for this scope.'}</div></div>
            <Btn sm onClick={() => choose(tool)} disabled={!tool.available}>Run</Btn>
          </div>)}
          {!catalog && <span className="field-hint">Loading live picker scope…</span>}
        </div>
      </Card>
      <Card title={selected ? `Response — ${selected.name}` : 'Response'} sub="the tool’s direct result">
        {selected && <><label className="caption mb-1 block">Arguments (JSON)</label><Textarea value={args} onChange={e => setArgs(e.target.value)} rows={7} className="font-mono text-[11px]" />
          <div className="mt-2"><Btn sm onClick={run} disabled={running}>{running ? 'Running…' : 'Run tool'}</Btn></div></>}
        {error && <p className="mt-3 text-[12px] text-[var(--danger)]">{error}</p>}
        {result !== null && <pre className="term mt-3 max-h-[520px] overflow-auto text-[11px]">{JSON.stringify(result, null, 2)}</pre>}
        {!selected && <p className="field-hint italic">Choose an available tool to inspect its live response.</p>}
      </Card>
    </div>
    {comparison && <Card title="Paired discovery comparison" sub="same live scope · two recorded picker calls · no tracks queued">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] leading-[1.5] text-muted">{criteriaSummary(comparison.showCriteria)}</p>
        <Btn sm onClick={copyComparison}>{copied ? 'Markdown copied' : 'Copy Markdown'}</Btn>
      </div>
      <div className="mb-3 grid gap-2 text-[11px] md:grid-cols-2">
        {([['Agentic Picker', comparison.outcomes.agentic], ['Track Shortlist', comparison.outcomes.shortlist]] as const).map(([route, outcome]) => <div key={route} className="border border-separator-soft p-2.5">
          <div className="font-bold">{route}</div>
          <div className="mt-1 text-muted">Selected: {trackLabel(outcome.selected)}</div>
          <div className="text-muted">{formatDuration(outcome.elapsedMs)} · {outcome.llmCalls} LLM call{outcome.llmCalls === 1 ? '' : 's'} · {outcome.tokens?.toLocaleString() ?? 'tokens not recorded'} tokens</div>
          <div className="mt-1 text-muted">Fallback: {outcome.fallback}</div>
        </div>)}
      </div>
      <div className="overflow-auto"><table className="w-full text-left text-[12px]"><thead><tr className="border-b border-separator-strong text-muted"><th className="p-2">Route</th><th className="p-2">Round</th><th className="p-2">Tool / source</th><th className="p-2">Returned tracks</th></tr></thead><tbody>
        {[...comparison.agentic.map(row => ({ ...row, route: 'Agentic Picker' })), ...comparison.shortlist.map(row => ({ ...row, route: 'Track Shortlist' }))].map((row, index) => <tr key={`${row.route}-${index}`} className="border-b border-separator-soft align-top"><td className="p-2 font-bold">{row.route}</td><td className="p-2">{row.round}</td><td className="p-2 font-mono">{row.source}</td><td className="p-2">{row.tracks.length ? row.tracks.map(track => <div key={track.id}>{track.artist} — {track.title}</div>) : '—'}</td></tr>)}
      </tbody></table></div>
    </Card>}
  </div>;
}
