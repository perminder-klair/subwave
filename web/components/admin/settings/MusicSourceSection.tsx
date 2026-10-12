'use client';

// Admin → Settings → Music source (#692). Two ways to get music:
//   - Navidrome, connected directly (the default; the existing form below), or
//   - the SUB/WAVE music router, which serves Jellyfin, Plex, Navidrome, the
//     demo library or any installed plugin through the same Subsonic API.
//
// The router owns the plugin inventory and health; this section edits the
// station's selection (saved to setup-config.json by the controller) and
// renders each plugin's settings from its manifest.

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { adminJson, useAdminQuery, type AdminFetch } from '../../../lib/admin-query';
import { errorMessage, notify } from '../../../lib/notify';
import { cn } from '../../../lib/cn';
import { V3Alert } from '../../ui/alert';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../../ui/select';
import { Btn, Card, MetaChip, Pill, Seg, Toggle } from '../ui';
import { SaveBar, SectionHeader, type SettingsData } from './shared';
import { NavidromeSection } from './NavidromeSection';
import { SourceFields } from '../music/SourceFields';
import {
  blankSource,
  changesTrackIds,
  draftDirty,
  missingFields,
  seedableSources,
  selectablePlugins,
  selectionPayload,
  type DraftSource,
  type SavedSelectionView,
} from '../music/sourceDraft';
import type { MusicCapabilities, MusicMode, MusicPluginInfo, RouterStatus, RouterTestResult } from '../../../lib/schemas.generated';

export interface MusicSourceView extends SavedSelectionView {
  routerUrl: string;
  router: RouterStatus | null;
  routerError: string | null;
}

interface SaveResponse {
  ok: boolean;
  error?: string;
  switched?: boolean;
  reconcile?: 'started' | 'pending' | null;
}

export const MUSIC_SOURCE_KEY = ['music-source'] as const;

const CAPABILITY_LABELS: Array<[keyof MusicCapabilities, string]> = [
  ['similarSongs', 'similar tracks'],
  ['sonicSimilarity', 'sonic similarity'],
  ['topSongs', 'top tracks'],
  ['artistInfo', 'artist info'],
  ['lyrics', 'lyrics'],
  ['stars', 'stars'],
  ['playlists', 'playlists'],
  ['scrobble', 'play counts'],
  ['scanStatus', 'scan status'],
];

interface MusicSourceSectionProps {
  data: SettingsData;
  adminFetch: AdminFetch;
  refresh: () => void;
}

export function MusicSourceSection({ data, adminFetch, refresh }: MusicSourceSectionProps) {
  const queryClient = useQueryClient();
  const q = useAdminQuery<MusicSourceView>({
    key: MUSIC_SOURCE_KEY,
    adminFetch,
    request: (fetcher, signal) => adminJson(fetcher, '/settings/music-source', undefined, signal),
  });
  const view = q.data;

  // Draft, seeded once; later refetches (health) must not clobber what the
  // operator is typing. The sources wait for an answer that has the router's
  // manifests (seedableSources).
  const [mode, setMode] = useState<MusicMode | null>(null);
  const [merge, setMerge] = useState(false);
  const [sources, setSources] = useState<DraftSource[]>([]);
  const [sourcesSeeded, setSourcesSeeded] = useState(false);
  useEffect(() => {
    if (!view) return;
    if (mode === null) {
      setMode(view.mode);
      setMerge(view.merge);
    }
    const seed = sourcesSeeded ? null : seedableSources(view);
    if (seed) {
      setSources(seed);
      setSourcesSeeded(true);
    }
  }, [view, mode, sourcesSeeded]);

  const reload = async () => {
    await queryClient.invalidateQueries({ queryKey: MUSIC_SOURCE_KEY });
    refresh();
  };

  const header = (
    <SectionHeader
      eyebrow="music source"
      title="Where the DJ's music comes from."
      sub={<>
        Connect Navidrome directly, or play from Jellyfin, Plex or an installed plugin
        through the SUB/WAVE music router. Every track pick, cover and library lookup
        follows this choice. Changes apply immediately — no restart.
      </>}
      manualHref="/manual/music-sources"
      manualLabel="Music sources in the manual"
    />
  );

  if (!view || mode === null) {
    return (
      <>
        {header}
        <Card title="Source">
          <div className="text-[13px] text-muted">{q.isError ? errorMessage(q.error) : 'Loading…'}</div>
        </Card>
      </>
    );
  }

  return (
    <>
      {header}
      <Card title="Source" sub="choose how the station reaches its library">
        <div className="grid gap-3">
          <Seg
            aria-label="Music source"
            value={mode}
            accent
            onChange={(v) => {
              const next = v as MusicMode;
              setMode(next);
              if (next === 'router' && sources.length === 0) {
                const first = selectablePlugins(view.router?.plugins ?? []).find((p) => p.name !== 'mock');
                if (first) setSources([blankSource(first)]);
              }
            }}
            options={[
              { id: 'navidrome', label: 'Navidrome' },
              { id: 'router', label: 'Jellyfin · Plex · plugins' },
            ]}
          />
          <div className="field-hint">
            {mode === 'navidrome'
              ? 'The station talks to your Navidrome server directly, as it always has.'
              : <>The station talks to the SUB/WAVE music router at <code>{view.routerUrl}</code>, which serves the source you pick below.</>}
            {view.mode !== mode && <strong> Not saved yet — the station still plays from {view.mode === 'router' ? 'the router' : 'Navidrome'}.</strong>}
          </div>
        </div>
      </Card>

      {mode === 'navidrome' ? (
        <>
          {view.mode === 'router' && (
            <SwitchToNavidrome adminFetch={adminFetch} navidromeReady={!!(data.navidrome?.url && data.navidrome?.user && data.navidrome?.passSet)} onDone={reload} />
          )}
          <NavidromeSection data={data} adminFetch={adminFetch} refresh={reload} embedded routerLive={view.mode === 'router'} />
        </>
      ) : (
        <RouterPanel
          view={view}
          adminFetch={adminFetch}
          merge={merge}
          setMerge={setMerge}
          sources={sources}
          setSources={setSources}
          onSaved={reload}
        />
      )}
    </>
  );
}

function SwitchToNavidrome({ adminFetch, navidromeReady, onDone }: { adminFetch: AdminFetch; navidromeReady: boolean; onDone: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const res = await adminJson<SaveResponse>(adminFetch, '/settings/music-source', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'navidrome' }),
      });
      notify.ok(res.reconcile === 'started' ? 'Playing from Navidrome — re-linking your library in the background' : 'Playing from Navidrome');
      await onDone();
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Switch back to Navidrome" sub="the router keeps your other sources on file">
      <div className="grid gap-3">
        <div className="text-[13px] leading-[1.5] text-muted">
          The station currently plays through the music router. Switching changes every
          track id; SUB/WAVE re-links your tags, likes and blocklist by matching each
          track&apos;s artist, title and album.
        </div>
        <div>
          <Btn tone="accent" onClick={go} disabled={busy || !navidromeReady}>
            {busy ? 'Switching…' : 'Play from Navidrome'}
          </Btn>
          {!navidromeReady && <div className="field-hint mt-2">Save a complete Navidrome connection below first.</div>}
        </div>
      </div>
    </Card>
  );
}

interface RouterPanelProps {
  view: MusicSourceView;
  adminFetch: AdminFetch;
  merge: boolean;
  setMerge: (v: boolean) => void;
  sources: DraftSource[];
  setSources: (s: DraftSource[]) => void;
  onSaved: () => Promise<void>;
}

function RouterPanel({ view, adminFetch, merge, setMerge, sources, setSources, onSaved }: RouterPanelProps) {
  const plugins = view.router?.plugins ?? [];
  const choices = selectablePlugins(plugins);
  const [busy, setBusy] = useState(false);
  const [rescanning, setRescanning] = useState(false);

  const dirty = draftDirty(view, 'router', merge, sources);
  const idsChange = changesTrackIds(view, 'router', sources, plugins);
  const missing = sources.flatMap((s) => missingFields(s, plugins.find((p) => p.name === s.plugin)).map((f) => f.label));

  const update = (i: number, next: DraftSource) => setSources(sources.map((s, j) => (j === i ? next : s)));

  const save = async () => {
    if (!sources.length || sources.some((s) => !s.plugin)) return notify.err('Choose a music source');
    if (missing.length) return notify.err(`Still needed: ${missing.join(', ')}`);
    setBusy(true);
    try {
      const res = await adminJson<SaveResponse>(adminFetch, '/settings/music-source', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(selectionPayload('router', merge, sources)),
      });
      if (!res.ok) notify.err(res.error || 'The router could not use this source');
      else if (res.reconcile === 'started') notify.ok('Music source saved — re-linking your library to the new track ids in the background');
      else if (res.reconcile === 'pending') notify.ok('Music source saved — your library is re-linked after the running tagger finishes');
      else notify.ok('Music source saved');
      await onSaved();
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const rescan = async () => {
    setRescanning(true);
    try {
      await adminJson(adminFetch, '/settings/music-source/rescan', { method: 'POST' });
      notify.ok('Plugins rescanned');
      await onSaved();
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setRescanning(false);
    }
  };

  if (!view.router) {
    return (
      <V3Alert tone="error" title="music router unreachable">
        <p>{view.routerError}</p>
        <p className="mt-2">
          The router ships with SUB/WAVE as the <code>router</code> service. Start it with{' '}
          <code>docker compose up -d router</code> (or <code>subwave start</code>), then reload this page.
        </p>
      </V3Alert>
    );
  }

  return (
    <>
      {view.router.configError && view.mode === 'router' && (
        <V3Alert tone="error" title="the router refused the saved selection">
          {view.router.configError} — it kept serving the previous one. Fix the source below and save again.
        </V3Alert>
      )}

      {sources.map((source, i) => {
        const plugin = plugins.find((p) => p.name === source.plugin);
        return (
          <Card
            key={i}
            title={merge ? `Source ${i + 1}` : 'Music source'}
            sub={plugin?.description || 'pick a source'}
            right={merge && sources.length > 1 ? (
              <Btn sm onClick={() => setSources(sources.filter((_, j) => j !== i))}>Remove</Btn>
            ) : undefined}
          >
            <div className="grid gap-[18px]">
              <div className="field">
                <Select
                  value={source.plugin}
                  onValueChange={(name: string) => update(i, blankSource(plugins.find((p) => p.name === name)))}
                >
                  <SelectTrigger className="w-[320px] max-w-full" aria-label="Music source plugin">
                    <SelectValue placeholder="Choose a source…" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {choices.map((p) => (
                        <SelectItem key={p.name} value={p.name} disabled={sources.some((s, j) => j !== i && s.plugin === p.name)}>
                          {p.label}{p.builtin ? '' : ' — installed plugin'}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                {plugin?.homepage && (
                  <div className="field-hint">
                    <a href={plugin.homepage} target="_blank" rel="noopener noreferrer" className="underline">{plugin.homepage}</a>
                  </div>
                )}
                {source.plugin === 'mock' && (
                  <div className="field-hint">Generated tones, not music — for trying SUB/WAVE out and for development.</div>
                )}
              </div>
              {plugin && (
                <SourceFields
                  plugin={plugin}
                  source={source}
                  idPrefix={`src${i}`}
                  onChange={(config) => update(i, { ...source, config })}
                />
              )}
              {plugin && <TestButton adminFetch={adminFetch} source={source} />}
            </div>
          </Card>
        );
      })}

      <Card title="Merge several sources" sub="experimental">
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
            Lists from every source are interleaved; each track still streams from the server it lives on.
            Nothing is de-duplicated, so an album held by two sources appears twice.
          </div>
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
        </div>
      </Card>

      {idsChange && (
        <V3Alert tone="info" title="this changes every track id">
          Saving points the station at a different library, so every track gets a new id. SUB/WAVE then
          re-links your mood tags, analysis, likes and blocklist by matching artist, title, album and
          duration, and removes what it cannot match only after you confirm. Show playlist pins and
          playlist recipes point at the old server&apos;s playlists and need re-picking.
        </V3Alert>
      )}

      <HealthCard status={view.router} saved={view.mode === 'router'} />
      <PluginsCard status={view.router} onRescan={rescan} rescanning={rescanning} />

      <SaveBar
        note={missing.length ? `Still needed: ${missing.join(', ')}` : 'Applies immediately — the auto playlist is rebuilt against the new library; no restart.'}
        busy={busy}
        onSave={save}
        saveLabel="Save music source"
        dirty={dirty}
      />
    </>
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
      <div><Btn sm tone="accent" onClick={test} disabled={testing}>{testing ? 'Testing…' : 'Test connection'}</Btn></div>
      {result && (
        <div
          role="status"
          className={cn(
            'mt-2 max-w-[560px] rounded border bg-[var(--ink-softer)] px-3 py-2 text-[11px] leading-[1.6] whitespace-pre-wrap',
            result.ok ? 'border-[var(--accent)] text-[color:var(--accent)]' : 'border-[var(--danger)] text-[var(--danger)]',
          )}
        >
          {result.ok
            ? `✓ Connected${result.stats ? ` — ${result.stats.songs.toLocaleString()} songs, ${result.stats.albums.toLocaleString()} albums, ${result.stats.artists.toLocaleString()} artists` : ''}`
            : `✗ ${result.error || result.state}`}
        </div>
      )}
    </div>
  );
}

function HealthCard({ status, saved }: { status: RouterStatus; saved: boolean }) {
  if (!saved || !status.active.length) return null;
  return (
    <Card title="Library health" sub="the saved selection, as the router sees it now">
      <div className="grid gap-4">
        {status.active.map((a) => (
          <div key={a.plugin} className="grid gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <strong className="text-[14px]">{a.label}</strong>
              <Pill tone={a.health.state === 'healthy' ? 'accent' : 'solid'} dot>{a.health.state}</Pill>
              {a.health.stats && (
                <span className="text-[12px] text-muted">
                  {a.health.stats.songs.toLocaleString()} songs · {a.health.stats.albums.toLocaleString()} albums · {a.health.stats.artists.toLocaleString()} artists
                </span>
              )}
              {a.health.ms !== undefined && <span className="text-[12px] text-muted">· answered in {a.health.ms.toLocaleString()} ms</span>}
            </div>
            {a.health.error && <div className="text-[12px] text-[var(--danger)]">{a.health.error}</div>}
            <div className="flex flex-wrap gap-1.5">
              {CAPABILITY_LABELS.map(([key, label]) => (
                <MetaChip key={key} accent={a.capabilities[key]}>{a.capabilities[key] ? label : `no ${label}`}</MetaChip>
              ))}
            </div>
          </div>
        ))}
        <div className="field-hint">
          A source without a capability still plays; the DJ just has fewer discovery signals.
          Live traffic and the full capability matrix are on the{' '}
          <Link href="/admin/router" className="underline">Music router</Link> page.
        </div>
      </div>
    </Card>
  );
}

function PluginsCard({ status, onRescan, rescanning }: { status: RouterStatus; onRescan: () => void; rescanning: boolean }) {
  const sorted = useMemo(
    () => [...status.plugins].sort((a, b) => Number(b.builtin) - Number(a.builtin) || a.label.localeCompare(b.label)),
    [status.plugins],
  );
  return (
    <Card
      title="Installed plugins"
      sub={`router ${status.router.version} · plugin API v${status.router.apiVersion}`}
      right={<Btn sm onClick={onRescan} disabled={rescanning}>{rescanning ? 'Rescanning…' : 'Rescan plugins'}</Btn>}
    >
      <div className="grid gap-2">
        {sorted.map((p: MusicPluginInfo) => (
          <div key={`${p.builtin ? 'b' : 'i'}-${p.name}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-[var(--separator-soft)] pb-2 last:border-0">
            <strong className="text-[13px]">{p.label}</strong>
            <code className="text-[11px] text-muted">{p.name}{p.version ? ` ${p.version}` : ''}</code>
            <MetaChip>{p.builtin ? 'built-in' : 'installed'}</MetaChip>
            {p.error && <span className="w-full text-[12px] text-[var(--danger)]">✗ {p.error}</span>}
          </div>
        ))}
        <div className="field-hint">
          To add a source, drop a plugin folder into <code>state/router/plugins/</code> and press Rescan.
          Plugins are code that runs in the router — install only ones you have read and trust.
        </div>
      </div>
    </Card>
  );
}
