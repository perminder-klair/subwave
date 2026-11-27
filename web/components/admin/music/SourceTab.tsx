'use client';

// Admin → Music source → Source (#692): where the station's music comes from.
//
// One question, asked the way people think about it: "where is your music?"
// Navidrome (direct), Jellyfin, Plex, an installed plugin or the demo library
// are cards; the router that serves all but the first is an implementation
// detail, met only under Advanced (combining libraries, routed Navidrome).
//
// Switching is a deliberate step, never a plain Save: the draft is tested
// first (the controller refuses a source that does not answer anyway, so the
// operator learns why before confirming), then a dialog says what a switch
// does to the library, then the re-link runs with its progress on this page.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { adminJson, useAdminQuery, type AdminFetch } from '../../../lib/admin-query';
import { errorMessage, notify } from '../../../lib/notify';
import { cn } from '../../../lib/cn';
import { V3Alert } from '../../ui/alert';
import { V3AlertDialog } from '../../ui/alert-dialog';
import { Button } from '../../ui/button';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../../ui/select';
import { Btn, Card, Toggle } from '../ui';
import { NowBanner, type SettingsData } from '../settings/shared';
import { settingsKeys } from '../settings/queries';
import { NavidromeRealPathCard } from '../settings/NavidromeRealPathCard';
import { useHosted } from '../HostedContext';
import type { TaggerState } from '../LibraryTaggingPanel';
import type { MusicMode, MusicPluginInfo, RouterTestResult } from '../../../lib/schemas.generated';
import { NavidromeFields, useNavidromeDraft } from './NavidromeConnection';
import { SourceFields } from './SourceFields';
import { SourcePicker } from './SourcePicker';
import { TestResultLine } from './TestResultLine';
import { MUSIC_RELINK_KEY, MUSIC_SOURCE_KEY, type MusicSaveResponse, type MusicSourceView } from './queries';
import {
  ADVANCED,
  DIRECT_NAVIDROME,
  blankSource,
  changesTrackIds,
  choiceOf,
  draftDirty,
  missingFields,
  seedableSources,
  selectablePlugins,
  selectionLabel,
  selectionPayload,
  sourceOptions,
  type DraftSource,
  type SourceChoice,
  type SourceOption,
} from './sourceDraft';

const num = (n: number) => n.toLocaleString('en-GB');

export function SourceTab({ adminFetch, view, viewError }: { adminFetch: AdminFetch; view: MusicSourceView | undefined; viewError: string | null }) {
  const { hosted, musicUploadUrl, musicLibraryUrl } = useHosted();
  const settingsQuery = useAdminQuery<SettingsData>({
    key: settingsKeys.detail(),
    adminFetch,
    request: (fetcher, signal) => adminJson<SettingsData>(fetcher, '/settings', undefined, signal),
  });

  // SUB/WAVE Cloud hosts the library and wires the connection: nothing to choose.
  if (hosted && musicUploadUrl) {
    return (
      <Card title="Music library" sub="hosted for you">
        <div className="grid gap-[18px]">
          <NowBanner label={<>Music source · Managed by SUB/WAVE Cloud</>}>
            Upload music and it&apos;s picked up within a minute. Sign in with this station&apos;s admin username and password.
          </NowBanner>
          <div className="flex flex-wrap gap-3">
            <Button asChild variant="solid">
              <a href={musicUploadUrl} target="_blank" rel="noreferrer">Upload music</a>
            </Button>
            {musicLibraryUrl && (
              <Button asChild variant="outline">
                <a href={musicLibraryUrl} target="_blank" rel="noreferrer">Browse library</a>
              </Button>
            )}
          </div>
        </div>
      </Card>
    );
  }

  const settings = settingsQuery.data;
  if (!view || !settings) {
    const err = viewError ?? (settingsQuery.isError ? errorMessage(settingsQuery.error) : null);
    return <Card title="Source"><div className="text-[13px] text-muted">{err ?? 'Loading…'}</div></Card>;
  }
  return <SourceEditor adminFetch={adminFetch} view={view} settings={settings} />;
}

interface Confirm {
  title: string;
  description: ReactNode;
  details?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  run: () => void;
}

function SourceEditor({ adminFetch, view, settings }: { adminFetch: AdminFetch; view: MusicSourceView; settings: SettingsData }) {
  const qc = useQueryClient();
  const plugins = view.router?.plugins ?? [];
  const nav = useNavidromeDraft(settings.navidrome, adminFetch);

  // Draft, seeded from the saved selection once (and again after a save);
  // a health refetch must not clobber what the operator is typing. Sources
  // wait for an answer carrying the router's manifests (seedableSources).
  const [mode, setMode] = useState<MusicMode | null>(null);
  const [merge, setMerge] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [sources, setSources] = useState<DraftSource[]>([]);
  const [sourcesSeeded, setSourcesSeeded] = useState(false);
  useEffect(() => {
    if (mode === null) {
      setMode(view.mode);
      setMerge(view.merge);
      setAdvanced(choiceOf(view) === ADVANCED);
    }
    const seed = sourcesSeeded ? null : seedableSources(view);
    if (seed) {
      setSources(seed);
      setSourcesSeeded(true);
    }
  }, [view, mode, sourcesSeeded]);

  const [phase, setPhase] = useState<'idle' | 'testing' | 'saving'>('idle');
  const [problem, setProblem] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);

  const draftMode = mode ?? view.mode;
  const savedChoice = choiceOf(view);
  const choice: SourceChoice = advanced ? ADVANCED : choiceOf({ mode: draftMode, merge, sources });
  const options = useMemo(() => {
    const base = sourceOptions(view.router ? view.router.plugins : null, view.routerError);
    // Advanced is a card only while it is on air or chosen; otherwise a link below.
    const adv: SourceOption = { id: ADVANCED, label: 'Combined', blurb: 'Several libraries merged into one station, or Navidrome through the router.' };
    return savedChoice === ADVANCED || choice === ADVANCED ? [...base, adv] : base;
  }, [view.router, view.routerError, savedChoice, choice]);

  const onAirProblem = view.mode === 'router'
    ? (!view.router ? view.routerError ?? 'router unreachable' : view.router.active.find((a) => a.health.state !== 'healthy')?.health.error ?? null)
    : null;

  const pick = (id: SourceChoice) => {
    setProblem(null);
    if (id === DIRECT_NAVIDROME) {
      setMode('navidrome');
      setAdvanced(false);
      return;
    }
    setMode('router');
    if (id === ADVANCED) {
      setAdvanced(true);
      if (!sources.length || sources.some((s) => !s.plugin)) setSources(view.sources.length ? view.sources : [blankSource(selectablePlugins(plugins)[0])]);
      return;
    }
    setAdvanced(false);
    setMerge(false);
    const saved = view.sources.find((s) => s.plugin === id);
    setSources([saved ?? blankSource(plugins.find((p) => p.name === id))]);
  };

  const navTarget = draftMode === 'navidrome';
  const targetLabel = selectionLabel({ mode: draftMode, sources }, plugins);
  const dirty = navTarget ? view.mode !== 'navidrome' || nav.dirty : draftDirty(view, 'router', merge, sources);
  const idsChange = changesTrackIds(view, draftMode, navTarget ? [] : sources, plugins, settings.navidrome?.url);
  const isSwitch = view.mode !== draftMode || choice !== savedChoice || idsChange;
  const missing = navTarget
    ? nav.missing()
    : sources.some((s) => !s.plugin)
      ? 'Choose a source'
      : (() => {
          const m = sources.flatMap((s) => missingFields(s, plugins.find((p) => p.name === s.plugin)).map((f) => f.label));
          return m.length ? `Still needed: ${m.join(', ')}` : null;
        })();

  const reload = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: MUSIC_SOURCE_KEY }),
      qc.invalidateQueries({ queryKey: settingsKeys.detail() }),
    ]);
    // Re-seed from what was saved: secrets come back blank (stored), so the
    // typed ones would otherwise read as unsaved forever.
    setMode(null);
    setSourcesSeeded(false);
  };

  const commit = async () => {
    setPhase('saving');
    setProblem(null);
    try {
      if (navTarget) {
        if (nav.dirty && !nav.allEnv) {
          const r = await nav.persist();
          if (!r.ok) return setProblem(r.error ?? 'Could not save the Navidrome connection');
        }
        if (view.mode !== 'navidrome') {
          const res = await adminJson<MusicSaveResponse>(adminFetch, '/settings/music-source', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: 'navidrome' }),
          });
          if (!res.ok) return setProblem(res.error || 'The station could not switch to Navidrome');
          notify.ok(res.reconcile ? 'Playing from Navidrome — re-linking your library' : 'Playing from Navidrome');
        } else {
          notify.ok('Navidrome connection saved');
        }
      } else {
        const res = await adminJson<MusicSaveResponse>(adminFetch, '/settings/music-source', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(selectionPayload('router', merge, sources)),
        });
        if (!res.ok) return setProblem(res.error || 'The router could not use this source');
        notify.ok(
          res.reconcile === 'started' ? `Playing from ${targetLabel} — re-linking your library`
            : res.reconcile === 'pending' ? `Playing from ${targetLabel} — your library is re-linked after the running tagger finishes`
              : `Playing from ${targetLabel}`,
        );
      }
      await reload();
      await qc.invalidateQueries({ queryKey: MUSIC_RELINK_KEY });
    } catch (err) {
      setProblem(errorMessage(err));
    } finally {
      setPhase('idle');
    }
  };

  const consequences = (songs: number | null): Confirm => ({
    title: `Switch the station to ${targetLabel}?`,
    description: idsChange
      ? `The station starts playing from ${targetLabel} right away${songs !== null ? ` (${num(songs)} songs)` : ''}. Every track gets a new id, so SUB/WAVE re-links your library to it.`
      : `The station starts playing from ${targetLabel} right away. Track ids stay the same, so nothing needs re-linking.`,
    details: idsChange ? (
      <ul className="mt-3 grid list-disc gap-1.5 pl-5 text-[12.5px] leading-[1.5] text-muted">
        <li>Mood tags, analysis, likes and the blocklist move across by artist, title, album and length, in the background. Progress shows on this page.</li>
        <li>Tracks {targetLabel} doesn&apos;t have are kept out of picks, not deleted. Remove them from Library when you&apos;re sure; switching back brings them back.</li>
        <li>Show playlist pins and playlist recipes point at the old server&apos;s playlists and need re-picking.</li>
      </ul>
    ) : undefined,
    confirmLabel: `Switch to ${targetLabel}`,
    run: () => void commit(),
  });

  const start = async () => {
    setProblem(null);
    if (missing) return setProblem(missing);
    setPhase('testing');
    try {
      if (navTarget) {
        const t = await nav.test();
        if (!t.ok) {
          if (!isSwitch) {
            // Editing the live connection: Navidrome may simply not be up yet.
            setConfirm({
              title: 'Navidrome is not answering',
              description: `${t.error || 'No answer'}. Save the connection anyway? The station keeps trying it.`,
              confirmLabel: 'Save anyway',
              danger: true,
              run: () => void commit(),
            });
            return;
          }
          return setProblem(`Navidrome is not answering: ${t.error || 'no answer'}. The station stays on ${selectionLabel(view, plugins)}.`);
        }
        return isSwitch ? setConfirm(consequences(null)) : void commit();
      }
      let songs: number | null = 0;
      for (const s of sources) {
        const label = selectionLabel({ mode: 'router', sources: [s] }, plugins);
        let r: RouterTestResult;
        try {
          r = await adminJson<RouterTestResult>(adminFetch, '/settings/music-source/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ plugin: s.plugin, config: s.config }),
          });
        } catch (err) {
          r = { ok: false, state: 'error', error: errorMessage(err) };
        }
        if (!r.ok) {
          return setProblem(`${label} is not answering: ${r.error || r.state}. The station stays on ${selectionLabel(view, plugins)}.`);
        }
        songs = songs !== null && r.stats ? songs + r.stats.songs : null;
      }
      return isSwitch ? setConfirm(consequences(songs)) : void commit();
    } finally {
      setPhase((p) => (p === 'testing' ? 'idle' : p));
    }
  };

  return (
    <div className="grid gap-4">
      <RelinkCard adminFetch={adminFetch} label={selectionLabel(view, plugins)} />

      {view.router?.configError && view.mode === 'router' && (
        <V3Alert tone="error" title="the router refused the saved selection">
          {view.router.configError} — it kept serving the previous one. Fix the source below and save again.
        </V3Alert>
      )}
      {!view.router && view.mode === 'router' && (
        <V3Alert tone="error" title="music router unreachable">
          <p>{view.routerError}</p>
          <p className="mt-2">
            The router ships with SUB/WAVE as the <code>router</code> service. Start it with{' '}
            <code>docker compose up -d router</code> (or <code>subwave start</code>), then reload this page.
          </p>
        </V3Alert>
      )}

      <Card title="Where is your music?" sub="pick the library the DJ plays from">
        <div className="grid gap-3">
          <SourcePicker options={options} value={choice} onChange={pick} onAir={savedChoice} onAirProblem={onAirProblem} />
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-[12px] text-muted">
            {choice !== ADVANCED && savedChoice !== ADVANCED && view.router ? (
              <button type="button" className="cursor-pointer underline underline-offset-2 hover:text-ink" onClick={() => pick(ADVANCED)}>
                Combine several libraries (advanced)
              </button>
            ) : <span />}
            <AddSourceHint adminFetch={adminFetch} onRescanned={reload} routerUp={!!view.router} />
          </div>
        </div>
      </Card>

      {navTarget ? (
        <>
          <Card title="Navidrome" sub="url · credentials">
            <NavidromeFields draft={nav} />
          </Card>
          <details className="card group">
            <summary className="cursor-pointer px-4 py-3 font-mono text-[11px] font-bold tracking-[0.12em] uppercase">
              Advanced · real file paths
            </summary>
            <div className="border-t border-[color-mix(in_oklab,var(--ink)_20%,transparent)] p-3">
              <NavidromeRealPathCard adminFetch={adminFetch} />
            </div>
          </details>
        </>
      ) : choice === ADVANCED ? (
        <AdvancedSources plugins={plugins} merge={merge} setMerge={setMerge} sources={sources} setSources={setSources} adminFetch={adminFetch} />
      ) : sources[0] ? (
        <PluginSourceCard plugins={plugins} source={sources[0]} onChange={(s) => setSources([s])} adminFetch={adminFetch} />
      ) : null}

      {(dirty || problem) && (
        <ActionBar
          note={problem ?? (isSwitch
            ? `The station plays from ${selectionLabel(view, plugins)} until you switch. Switching tests the connection first.`
            : 'Changes apply immediately — no restart.')}
          problem={!!problem}
          label={phase === 'testing' ? 'Testing…' : phase === 'saving' ? 'Switching…' : isSwitch ? `Switch to ${targetLabel}…` : 'Save changes'}
          busy={phase !== 'idle'}
          disabled={!dirty}
          onClick={() => void start()}
        />
      )}

      {confirm && (
        <V3AlertDialog
          open
          onOpenChange={(open) => { if (!open) setConfirm(null); }}
          title={confirm.title}
          description={confirm.description}
          details={confirm.details}
          confirmLabel={confirm.confirmLabel}
          danger={confirm.danger}
          onConfirm={() => { const run = confirm.run; setConfirm(null); run(); }}
        />
      )}
    </div>
  );
}

function ActionBar({ note, problem, label, busy, disabled, onClick }: { note: string; problem: boolean; label: string; busy: boolean; disabled: boolean; onClick: () => void }) {
  return (
    <div className="sticky bottom-3 z-10 flex flex-wrap items-center gap-3 border border-ink bg-bg px-4 py-3 shadow-[0_6px_24px_color-mix(in_oklab,var(--ink)_18%,transparent)]">
      <span role={problem ? 'alert' : undefined} className={cn('min-w-0 flex-1 text-[12.5px] leading-[1.5]', problem ? 'text-[var(--danger)]' : 'text-muted')}>
        {note}
      </span>
      <Btn tone="accent" onClick={onClick} disabled={busy || disabled} className="w-full sm:w-auto">{label}</Btn>
    </div>
  );
}

// ── one router source ──

function PluginSourceCard({ plugins, source, onChange, adminFetch }: { plugins: MusicPluginInfo[]; source: DraftSource; onChange: (s: DraftSource) => void; adminFetch: AdminFetch }) {
  const plugin = plugins.find((p) => p.name === source.plugin);
  if (!plugin) return null;
  return (
    <Card title={plugin.name === 'mock' ? 'Demo library' : plugin.label} sub={plugin.builtin ? 'built in' : `installed plugin · ${plugin.version}`}>
      <div className="grid gap-[18px]">
        {plugin.homepage && (
          <div className="field-hint">
            <a href={plugin.homepage} target="_blank" rel="noopener noreferrer" className="underline">{plugin.homepage}</a>
          </div>
        )}
        <SourceFields plugin={plugin} source={source} idPrefix="src0" onChange={(config) => onChange({ ...source, config })} />
        <TestButton adminFetch={adminFetch} source={source} />
      </div>
    </Card>
  );
}

function TestButton({ adminFetch, source }: { adminFetch: AdminFetch; source: DraftSource }) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<RouterTestResult | null>(null);
  useEffect(() => setResult(null), [source.plugin]);
  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      setResult(await adminJson<RouterTestResult>(adminFetch, '/settings/music-source/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plugin: source.plugin, config: source.config }),
      }));
    } catch (err) {
      setResult({ ok: false, state: 'error', error: errorMessage(err) });
    } finally {
      setTesting(false);
    }
  };
  return (
    <div className="field">
      <div><Btn sm onClick={test} disabled={testing}>{testing ? 'Testing…' : 'Test connection'}</Btn></div>
      {result && (
        <TestResultLine
          ok={result.ok}
          text={result.ok
            ? `Connected${result.stats ? ` — ${num(result.stats.songs)} songs, ${num(result.stats.albums)} albums, ${num(result.stats.artists)} artists` : ''}`
            : result.error || result.state}
        />
      )}
    </div>
  );
}

// ── Advanced: several sources merged, or Navidrome through the router ──

function AdvancedSources({ plugins, merge, setMerge, sources, setSources, adminFetch }: {
  plugins: MusicPluginInfo[];
  merge: boolean;
  setMerge: (v: boolean) => void;
  sources: DraftSource[];
  setSources: (s: DraftSource[]) => void;
  adminFetch: AdminFetch;
}) {
  const choices = selectablePlugins(plugins);
  const update = (i: number, next: DraftSource) => setSources(sources.map((s, j) => (j === i ? next : s)));
  return (
    <>
      <Card title="Combine libraries" sub="experimental">
        <div className="grid gap-3">
          <div className="flex items-center gap-3">
            <Toggle
              on={merge}
              ariaLabel="Merge several sources"
              onClick={() => {
                const next = !merge;
                setMerge(next);
                if (!next && sources.length > 1) setSources(sources.slice(0, 1));
              }}
            />
            <span className="text-[13px]">Serve more than one library as one station</span>
          </div>
          <div className="field-hint">
            Lists from every source are interleaved; each track still streams from the server it lives on. Nothing is
            de-duplicated, so an album two sources hold appears twice. Every source must answer for the station to switch.
          </div>
        </div>
      </Card>
      {sources.map((source, i) => {
        const plugin = plugins.find((p) => p.name === source.plugin);
        return (
          <Card
            key={i}
            title={merge ? `Source ${i + 1}` : 'Source'}
            sub={plugin?.description || 'pick a source'}
            right={merge && sources.length > 1 ? <Btn sm onClick={() => setSources(sources.filter((_, j) => j !== i))}>Remove</Btn> : undefined}
          >
            <div className="grid gap-[18px]">
              <Select value={source.plugin} onValueChange={(name: string) => update(i, blankSource(plugins.find((p) => p.name === name)))}>
                <SelectTrigger className="w-[320px] max-w-full" aria-label="Music source plugin">
                  <SelectValue placeholder="Choose a source…" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {choices.map((p) => (
                      <SelectItem key={p.name} value={p.name} disabled={sources.some((s, j) => j !== i && s.plugin === p.name)}>
                        {p.name === 'mock' ? 'Demo library' : p.label}{p.builtin ? '' : ' — installed plugin'}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              {plugin && <SourceFields plugin={plugin} source={source} idPrefix={`src${i}`} onChange={(config) => update(i, { ...source, config })} />}
              {plugin && <TestButton adminFetch={adminFetch} source={source} />}
            </div>
          </Card>
        );
      })}
      {merge && (
        <div>
          <Btn
            sm
            disabled={sources.length >= choices.length}
            onClick={() => {
              const next = choices.find((p) => !sources.some((s) => s.plugin === p.name));
              if (next) setSources([...sources, blankSource(next)]);
            }}
          >
            Add another source
          </Btn>
        </div>
      )}
    </>
  );
}

// ── installing a plugin ──

function AddSourceHint({ adminFetch, onRescanned, routerUp }: { adminFetch: AdminFetch; onRescanned: () => Promise<void>; routerUp: boolean }) {
  const [open, setOpen] = useState(false);
  const [rescanning, setRescanning] = useState(false);
  const rescan = async () => {
    setRescanning(true);
    try {
      await adminJson(adminFetch, '/settings/music-source/rescan', { method: 'POST' });
      notify.ok('Plugins rescanned');
      await onRescanned();
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setRescanning(false);
    }
  };
  return (
    <div className="grid w-full gap-2 sm:w-auto">
      <button type="button" aria-expanded={open} className="cursor-pointer self-end text-left underline underline-offset-2 hover:text-ink sm:text-right" onClick={() => setOpen(!open)}>
        Don&apos;t see your server?
      </button>
      {open && (
        <div className="max-w-[560px] border border-ink bg-[var(--ink-softer)] p-3 text-[12px] leading-[1.55] text-ink">
          Other servers come as source plugins. With the CLI, <code>subwave source add &lt;folder or link&gt;</code> installs one
          and rescans. By hand, copy a plugin folder into <code>state/router/plugins/</code> as root
          (<code>sudo cp -r</code>: the folder is root&apos;s, so plugin code cannot rewrite a plugin), then Rescan.
          Plugins are code that runs in the router — install only ones you have read and trust.{' '}
          <Link href="/plugins" className="underline">Find a plugin</Link>
          {' · '}
          <Link href="/manual/music-sources" className="underline">Installing and writing one</Link>
          <div className="mt-2">
            <Btn sm onClick={rescan} disabled={rescanning || !routerUp}>{rescanning ? 'Rescanning…' : 'Rescan plugins'}</Btn>
          </div>
        </div>
      )}
    </div>
  );
}

// ── the re-link after a switch ──

function RelinkCard({ adminFetch, label }: { adminFetch: AdminFetch; label: string }) {
  const q = useAdminQuery<{ tagger: TaggerState }>({
    key: MUSIC_RELINK_KEY,
    adminFetch,
    staleTime: 0,
    refetchInterval: (query) => {
      const t = query.state.data?.tagger;
      return t?.switchPending || t?.running ? 3_000 : 30_000;
    },
    request: (fetcher, signal) => adminJson<{ tagger: TaggerState }>(fetcher, '/library/tagger', undefined, signal),
  });
  const t = q.data?.tagger;
  if (!t) return null;
  const held = t.heldRows ?? 0;
  if (t.switchPending) {
    const p = t.running ? t.progress : null;
    const pct = p?.total ? Math.min(100, Math.round(((p.done ?? 0) / p.total) * 100)) : null;
    return (
      <div role="status" className="card grid gap-2 border-l-[3px] border-l-[var(--accent)] px-4 py-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <strong className="font-mono text-[11px] tracking-[0.12em] uppercase">Re-linking your library to {label}</strong>
          <span className="font-mono text-[11px] text-muted">
            {p ? `${p.label}${p.total ? ` · ${num(p.done ?? 0)} / ${num(p.total)}` : '…'}` : t.running ? 'waiting for the run going now' : t.switchAwaitingScan ? `waiting for ${label} to finish scanning` : 'starting in a moment'}
          </span>
        </div>
        {/* No value while the phase has no total: an indeterminate bar. */}
        <progress
          aria-hidden
          max={100}
          value={pct ?? undefined}
          className={cn(
            'h-1.5 w-full appearance-none overflow-hidden border-0 bg-[color-mix(in_oklab,var(--ink)_12%,transparent)]',
            '[&::-moz-progress-bar]:bg-[var(--accent)] [&::-webkit-progress-bar]:bg-transparent [&::-webkit-progress-value]:bg-[var(--accent)]',
            pct === null && 'animate-pulse',
          )}
        />
        <p className="m-0 text-[12px] leading-[1.5] text-muted">
          {t.switchAwaitingScan && !t.running
            ? `${label} is still reading its library, so only part of it could be matched. The rest is matched once its scan finishes.`
            : `The station already plays from ${label}. Tags, analysis, likes and the blocklist follow each track as it is matched.`}
        </p>
      </div>
    );
  }
  if (held > 0) {
    return (
      <div role="status" className="card flex flex-wrap items-center gap-3 border-l-[3px] border-l-[var(--warn,var(--accent))] px-4 py-3">
        <p className="m-0 min-w-0 flex-1 text-[12.5px] leading-[1.5]">
          <b>{num(held)} library track{held === 1 ? ' is' : 's are'} not on {label}.</b> They&apos;re kept out of picks with
          their tags, in case you switch back. Remove them from Library when you&apos;re sure.
        </p>
        <Link href="/admin/library" className="font-mono text-[11px] font-bold tracking-[0.1em] uppercase underline underline-offset-2">
          Review in Library →
        </Link>
      </div>
    );
  }
  return null;
}
