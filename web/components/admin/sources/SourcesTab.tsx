'use client';

// Admin → Music sources → Sources (#692): what the station plays from. Every
// source is served through the SUB/WAVE music router; the station's Navidrome
// is the default one, and further sources (Jellyfin, Plex, an installed
// plugin) are added beside it — more than one is a merged library.
//
// The Navidrome source has no settings of its own: it plays the station's
// Navidrome connection, which its card edits and saves at once (it is also
// what direct mode and the router failover use). Every other source is a
// draft saved together, because a source change can re-link the library.

import { useEffect, useState } from 'react';
import { adminJson, type AdminFetch } from '../../../lib/admin-query';
import { errorMessage, notify } from '../../../lib/notify';
import { V3Alert } from '../../ui/alert';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../../ui/select';
import { Btn, Card, MetaChip, Pill } from '../ui';
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
} from '../music/sourceDraft';
import type { MusicCapabilities, RouterTestResult } from '../../../lib/schemas.generated';
import { NavidromeConnection } from './NavidromeConnection';
import { navidromeReady, type MusicSourceView, type SaveResponse } from './queries';

const NAVIDROME = 'navidrome';

const CAPABILITY_LABELS: Array<[keyof MusicCapabilities, string]> = [
  ['similarSongs', 'similar tracks'],
  ['sonicSimilarity', 'sonic similarity'],
  ['topSongs', 'top tracks'],
  ['artistInfo', 'artist info'],
  ['lyrics', 'lyrics'],
  ['stars', 'stars'],
  ['playlists', 'playlists'],
  ['scrobble', 'play counts'],
];

const json = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

interface SourcesTabProps {
  view: MusicSourceView;
  adminFetch: AdminFetch;
  reload: () => Promise<void>;
}

export function SourcesTab({ view, adminFetch, reload }: SourcesTabProps) {
  const direct = view.mode === 'navidrome';
  return (
    <div className="grid gap-4">
      {view.failover.active && (
        <V3Alert tone="error" title="music router down — playing Navidrome directly">
          The router stopped answering{view.failover.since ? ` at ${new Date(view.failover.since).toLocaleTimeString()}` : ''}
          {view.failover.reason ? ` (${view.failover.reason})` : ''}. The station keeps playing your Navidrome with the same
          track ids, and moves back behind the router on its own once it answers. Check the <code>router</code> service.
        </V3Alert>
      )}
      {!view.router && !direct && !view.failover.active && (
        <V3Alert tone="error" title="music router unreachable">
          <p>{view.routerError}</p>
          <p className="mt-2">
            The router ships with SUB/WAVE as the <code>router</code> service. Start it with <code>docker compose up -d router</code>{' '}
            (or <code>subwave start</code>), then reload this page.
            {view.failover.eligible && ' Until then the station plays your Navidrome directly.'}
          </p>
        </V3Alert>
      )}
      {view.router?.configError && !direct && (
        <V3Alert tone="error" title="the router refused the saved selection">
          {view.router.configError} — it kept serving the previous one. Fix the source below and save again.
        </V3Alert>
      )}

      {direct ? <DirectMode view={view} adminFetch={adminFetch} reload={reload} /> : <RouterSources view={view} adminFetch={adminFetch} reload={reload} />}
    </div>
  );
}

// --- behind the router (the default) ------------------------------------------------

function RouterSources({ view, adminFetch, reload }: SourcesTabProps) {
  const plugins = view.router?.plugins ?? [];
  const choices = selectablePlugins(plugins);
  // Seeded once; later refetches (health) must not clobber what is being typed.
  // The sources wait for an answer with the router's manifests (seedableSources).
  const [sources, setSources] = useState<DraftSource[] | null>(null);
  useEffect(() => {
    if (sources !== null) return;
    const seed = seedableSources(view);
    if (seed) setSources(seed);
  }, [view, sources]);
  const [busy, setBusy] = useState(false);

  if (sources === null) {
    // Without the router's manifests the other sources cannot be edited, but
    // the station's Navidrome connection needs none — and it is what plays
    // while the router is down, so it stays fixable.
    return view.sources.every((s) => s.plugin === NAVIDROME) ? (
      <Card title="Navidrome" sub="the station’s Navidrome — the default source">
        <div className="grid gap-4">
          <div className="field-hint">Other sources can be added once the music router answers again.</div>
          <NavidromeConnection navidrome={view.navidrome} adminFetch={adminFetch} onSaved={() => void reload()} />
        </div>
      </Card>
    ) : (
      <Card title="Sources"><div className="text-[13px] text-muted">Waiting for the music router — its plugin list says how to show these sources.</div></Card>
    );
  }

  const merge = sources.length > 1;
  const dirty = draftDirty(view, 'router', merge, sources);
  const idsChange = changesTrackIds(view, 'router', sources, plugins);
  const usesNavidrome = sources.some((s) => s.plugin === NAVIDROME);
  const missing = [
    ...sources.flatMap((s) => missingFields(s, plugins.find((p) => p.name === s.plugin)).map((f) => f.label)),
    ...(usesNavidrome && !navidromeReady(view.navidrome) ? ['a saved Navidrome connection'] : []),
  ];
  const update = (i: number, next: DraftSource) => setSources(sources.map((s, j) => (j === i ? next : s)));
  const unused = choices.filter((p) => !sources.some((s) => s.plugin === p.name));

  const save = async () => {
    if (!sources.length || sources.some((s) => !s.plugin)) return notify.err('Choose a music source');
    if (missing.length) return notify.err(`Still needed: ${missing.join(', ')}`);
    setBusy(true);
    try {
      const res = await adminJson<SaveResponse>(adminFetch, '/settings/music-source', json(selectionPayload('router', merge, sources)));
      if (!res.ok) notify.err(res.error || 'The router could not use this source');
      else if (res.reconcile === 'started') notify.ok('Sources saved — re-linking your library to the new track ids in the background');
      else if (res.reconcile === 'pending') notify.ok('Sources saved — your library is re-linked after the running tagger finishes');
      else notify.ok('Sources saved');
      await reload();
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {sources.map((source, i) => {
        const plugin = plugins.find((p) => p.name === source.plugin);
        const live = view.router?.active.find((a) => a.plugin === source.plugin && view.sources.some((s) => s.plugin === a.plugin));
        return (
          <Card
            key={`${i}-${source.plugin}`}
            title={plugin?.label ?? (source.plugin || 'New source')}
            sub={source.plugin === NAVIDROME ? 'the station’s Navidrome — the default source' : plugin?.description || 'pick a source'}
            right={
              <span className="flex items-center gap-2">
                {live && <Pill tone={live.health.state === 'healthy' ? 'accent' : 'solid'} dot>{live.health.state}</Pill>}
                {sources.length > 1 && (
                  <Btn sm onClick={() => setSources(sources.filter((_, j) => j !== i))} aria-label={`Remove ${plugin?.label ?? 'source'}`}>
                    Remove
                  </Btn>
                )}
              </span>
            }
          >
            <div className="grid gap-4">
              <div className="flex flex-wrap items-center gap-2">
                <Select value={source.plugin} onValueChange={(name: string) => update(i, blankSource(plugins.find((p) => p.name === name)))}>
                  <SelectTrigger className="w-[320px] max-w-full" aria-label="Music source plugin">
                    <SelectValue placeholder="Choose a source" />
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
                  <a href={plugin.homepage} target="_blank" rel="noopener noreferrer" className="text-[12px] text-muted underline">
                    {plugin.homepage}
                  </a>
                )}
              </div>

              {live && (
                <div className="grid gap-2">
                  <div className="text-[12px] text-muted">
                    {live.health.stats
                      ? `${live.health.stats.songs.toLocaleString()} songs · ${live.health.stats.albums.toLocaleString()} albums · ${live.health.stats.artists.toLocaleString()} artists`
                      : 'no library counts'}
                    {live.health.ms !== undefined && ` · answered in ${live.health.ms.toLocaleString()} ms`}
                  </div>
                  {live.health.error && <div className="text-[12px] text-[var(--danger)]">{live.health.error}</div>}
                  <div className="flex flex-wrap gap-1.5">
                    {CAPABILITY_LABELS.map(([key, label]) => (
                      <MetaChip key={key} accent={live.capabilities[key]}>{live.capabilities[key] ? label : `no ${label}`}</MetaChip>
                    ))}
                  </div>
                </div>
              )}

              {source.plugin === NAVIDROME ? (
                <NavidromeConnection navidrome={view.navidrome} adminFetch={adminFetch} onSaved={() => void reload()} />
              ) : plugin ? (
                <>
                  <SourceFields plugin={plugin} source={source} idPrefix={`src${i}`} onChange={(config) => update(i, { ...source, config })} />
                  <TestButton adminFetch={adminFetch} source={source} />
                </>
              ) : null}
            </div>
          </Card>
        );
      })}

      <Card title={merge ? 'Merged library' : 'More sources'} sub={merge ? 'experimental' : undefined}>
        <div className="grid gap-3">
          <div className="field-hint">
            {merge
              ? 'Lists from every source are interleaved, and each track still streams from the server it lives on. Nothing is de-duplicated: an album held by two sources appears twice.'
              : 'Add Jellyfin, Plex or an installed plugin beside this source and the station plays them as one library (experimental). To replace the source instead, pick another one above.'}
          </div>
          <div>
            <Btn sm disabled={!unused.length} onClick={() => unused[0] && setSources([...sources, blankSource(unused[0])])}>
              Add another source
            </Btn>
          </div>
        </div>
      </Card>

      <div className="card flex flex-wrap items-center gap-3 p-3">
        <span className="min-w-0 flex-1 text-[12px] leading-[1.5] text-muted">
          {idsChange ? (
            <strong className="text-[var(--danger)]">
              This changes every track id. SUB/WAVE re-links your tags, likes and blocklist by matching artist, title and album.
            </strong>
          ) : dirty ? (
            'Applies immediately — no restart.'
          ) : (
            'Saved. The Navidrome connection saves on its own button.'
          )}
          {missing.length > 0 && <span className="block text-[var(--danger)]">Still needed: {missing.join(', ')}</span>}
        </span>
        <Btn tone="accent" onClick={save} disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save sources'}</Btn>
      </div>

      <DirectCard view={view} adminFetch={adminFetch} reload={reload} />
    </>
  );
}

function TestButton({ adminFetch, source }: { adminFetch: AdminFetch; source: DraftSource }) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<RouterTestResult | null>(null);
  useEffect(() => setResult(null), [source.plugin]);
  const test = async () => {
    setTesting(true);
    try {
      setResult(await adminJson<RouterTestResult>(adminFetch, '/settings/music-source/test', json({ plugin: source.plugin, config: source.config })));
    } catch (err) {
      setResult({ ok: false, state: 'error', error: errorMessage(err) });
    } finally {
      setTesting(false);
    }
  };
  return (
    <div className="grid gap-2">
      <div><Btn sm onClick={test} disabled={testing}>{testing ? 'Testing…' : 'Test connection'}</Btn></div>
      {result && (
        <div role="status" className={result.ok ? 'text-[12px] text-[color:var(--accent)]' : 'text-[12px] text-[var(--danger)]'}>
          {result.ok
            ? `✓ Connected${result.stats ? ` — ${result.stats.songs.toLocaleString()} songs, ${result.stats.albums.toLocaleString()} albums, ${result.stats.artists.toLocaleString()} artists` : ''}`
            : `✗ ${result.error || result.state}`}
        </div>
      )}
    </div>
  );
}

// --- the direct escape hatch ----------------------------------------------------------

function DirectCard({ view, adminFetch, reload }: SourcesTabProps) {
  const [busy, setBusy] = useState(false);
  const ready = navidromeReady(view.navidrome);
  const sameLibrary = view.failover.eligible;
  const go = async () => {
    setBusy(true);
    try {
      const res = await adminJson<SaveResponse>(adminFetch, '/settings/music-source', json({ mode: 'navidrome' }));
      notify.ok(res.reconcile === 'started' ? 'Playing Navidrome directly — re-linking your library in the background' : 'Playing Navidrome directly');
      await reload();
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Advanced" sub="bypass the router">
      <div className="grid gap-3">
        <div className="text-[13px] leading-[1.5] text-muted">
          Connect straight to your Navidrome, as SUB/WAVE did before the music router. You lose the other sources and
          the live monitor. You rarely need this: when the station plays its Navidrome alone, it already falls back to a
          direct connection by itself whenever the router is down.
          {!sameLibrary && ' Your current sources are not your Navidrome, so going direct changes every track id; they are kept on file for later.'}
        </div>
        <div>
          <Btn onClick={go} disabled={busy || !ready}>{busy ? 'Switching…' : 'Play Navidrome directly'}</Btn>
          {!ready && <div className="field-hint mt-2">Save a complete Navidrome connection first.</div>}
        </div>
      </div>
    </Card>
  );
}

function DirectMode({ view, adminFetch, reload }: SourcesTabProps) {
  const [busy, setBusy] = useState(false);
  const back = async () => {
    setBusy(true);
    try {
      const res = await adminJson<SaveResponse>(adminFetch, '/settings/music-source', json({ mode: 'router', sources: [{ plugin: NAVIDROME, config: {} }] }));
      if (!res.ok) notify.err(res.error || 'The router could not serve Navidrome');
      else notify.ok('Navidrome plays through the music router again');
      await reload();
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Card title="Playing Navidrome directly" sub="the music router is bypassed">
        <div className="grid gap-3">
          <div className="text-[13px] leading-[1.5] text-muted">
            The station talks to Navidrome itself. Move it back behind the music router to add other sources, see live
            traffic on the Monitor tab, and get the automatic fallback. Track ids stay the same either way.
          </div>
          <div><Btn tone="accent" onClick={back} disabled={busy || !view.router}>{busy ? 'Moving…' : 'Play through the router'}</Btn></div>
        </div>
      </Card>
      <Card title="Navidrome" sub="the station’s connection">
        <NavidromeConnection navidrome={view.navidrome} adminFetch={adminFetch} onSaved={() => void reload()} />
      </Card>
    </>
  );
}
