'use client';

// Admin → Music sources → Plugins (#692): every music-source plugin the router
// has loaded — the built-ins and any installed into state/router/plugins/ —
// with what each needs, what it supported when last built, and why one failed
// to load. Installing is still "copy the folder, press Rescan": a plugin is
// code that runs inside the router, so it arrives by the operator's hand.

import { useMemo } from 'react';
import { adminJson, useAdminMutation, type AdminFetch } from '../../../lib/admin-query';
import { notify } from '../../../lib/notify';
import { V3Alert } from '../../ui/alert';
import { Btn, Card, MetaChip, Pill } from '../ui';
import type { MusicCapabilities, MusicPluginInfo } from '../../../lib/schemas.generated';
import { MUSIC_SOURCE_KEY, type MusicSourceView } from './queries';

const PLUGIN_GUIDE = 'https://github.com/perminder-klair/subwave/blob/main/docs/music-source-plugins.md';

const CAPABILITY_LABELS: Array<[keyof MusicCapabilities, string]> = [
  ['similarSongs', 'similar tracks'],
  ['sonicSimilarity', 'sonic similarity'],
  ['topSongs', 'top tracks'],
  ['artistInfo', 'artist info'],
  ['artists', 'artist index'],
  ['lyrics', 'lyrics'],
  ['stars', 'stars'],
  ['playlists', 'playlists'],
  ['scrobble', 'play counts'],
  ['scanStatus', 'scan status'],
];

export function PluginsTab({ view, adminFetch }: { view: MusicSourceView; adminFetch: AdminFetch }) {
  const status = view.router;
  const inUse = useMemo(() => new Set(view.mode === 'router' ? view.sources.map((s) => s.plugin) : []), [view]);
  const sorted = useMemo(
    () =>
      [...(status?.plugins ?? [])].sort(
        (a, b) => Number(inUse.has(b.name)) - Number(inUse.has(a.name)) || Number(b.builtin) - Number(a.builtin) || a.label.localeCompare(b.label),
      ),
    [status, inUse],
  );
  const rescan = useAdminMutation<unknown, void>({
    adminFetch,
    request: (_vars, fetcher) => adminJson(fetcher, '/settings/music-source/rescan', { method: 'POST' }),
    onDone: async (_data, _vars, client) => {
      await client.invalidateQueries({ queryKey: MUSIC_SOURCE_KEY, exact: true });
      notify.ok('Plugins rescanned');
    },
  });

  if (!status) {
    return (
      <V3Alert tone="error" title="music router unreachable">
        {view.routerError} — the plugin list comes from the router. Start the <code>router</code> service and reload.
      </V3Alert>
    );
  }

  return (
    <div className="grid gap-4">
      <Card
        title="Installed plugins"
        sub={`router ${status.router.version} · plugin API v${status.router.apiVersion} · ${sorted.length} loaded`}
        right={<Btn sm onClick={() => rescan.mutate()} disabled={rescan.isPending}>{rescan.isPending ? 'Rescanning…' : 'Rescan plugins'}</Btn>}
      >
        <div className="grid gap-0">
          {sorted.map((p) => (
            <PluginRow
              key={`${p.builtin ? 'b' : 'i'}-${p.name}`}
              plugin={p}
              inUse={inUse.has(p.name)}
              rawIds={Boolean(status.active.find((a) => a.plugin === p.name)?.rawIds)}
            />
          ))}
        </div>
      </Card>

      <Card title="Install a plugin" sub="a folder and a Rescan">
        <ol className="grid list-decimal gap-2 pl-5 text-[13px] leading-[1.55]">
          <li>
            Copy the plugin&apos;s folder — a <code>subwave-source.json</code> manifest and one ES module — into{' '}
            <code>state/router/plugins/&lt;name&gt;/</code> on the host.
          </li>
          <li>Press <strong>Rescan plugins</strong> above. A manifest that does not load is listed here with the reason.</li>
          <li>Add it on the <strong>Sources</strong> tab, fill in its settings, and Test it before saving.</li>
        </ol>
        <div className="field-hint mt-3">
          A plugin is code that runs inside the router, with the router&apos;s access to your music servers. Install only
          plugins you have read and trust. Writing one?{' '}
          <a href={PLUGIN_GUIDE} target="_blank" rel="noopener noreferrer" className="underline">The plugin author guide</a>{' '}
          covers the contract and the conformance kit.
        </div>
      </Card>
    </div>
  );
}

function PluginRow({ plugin: p, inUse, rawIds }: { plugin: MusicPluginInfo; inUse: boolean; rawIds: boolean }) {
  const required = p.config.filter((f) => f.required).map((f) => f.label);
  const optional = p.config.filter((f) => !f.required).map((f) => f.label);
  return (
    <div className="grid gap-2 border-b border-[var(--separator-soft)] py-3.5 first:pt-0 last:border-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <strong className="text-[14px]">{p.label}</strong>
        <code className="text-[11px] text-muted">{p.name}{p.version ? ` v${p.version}` : ''}</code>
        {inUse && <Pill tone="accent" dot>in use</Pill>}
        {p.error && <Pill tone="solid">load error</Pill>}
        <MetaChip>{p.builtin ? 'built-in' : 'installed'}</MetaChip>
        {p.devOnly && <MetaChip>development only</MetaChip>}
        <MetaChip>API v{p.apiVersion}</MetaChip>
        {rawIds ? <MetaChip>ids raw — the server&apos;s own</MetaChip> : p.idPrefix && <MetaChip>ids {p.idPrefix}-</MetaChip>}
      </div>
      {p.description && <div className="text-[13px] leading-[1.5] text-muted">{p.description}</div>}
      {p.error && <div className="text-[12px] text-[var(--danger)]">✗ {p.error}</div>}
      {p.name === 'navidrome' ? (
        <div className="text-[12px] text-muted">Plays the station&apos;s Navidrome connection, set on the Sources tab.</div>
      ) : p.config.length > 0 && (
        <div className="text-[12px] text-muted">
          {required.length > 0 && <>Needs {required.join(', ')}</>}
          {required.length > 0 && optional.length > 0 && ' · '}
          {optional.length > 0 && <>optional {optional.join(', ')}</>}
          {p.envLocked.length > 0 && ` · set by env: ${p.envLocked.join(', ')}`}
        </div>
      )}
      <div className="flex flex-wrap gap-1.5">
        {p.capabilities ? (
          CAPABILITY_LABELS.map(([key, label]) => (
            <MetaChip key={key} accent={p.capabilities![key]}>{p.capabilities![key] ? label : `no ${label}`}</MetaChip>
          ))
        ) : (
          <span className="text-[12px] text-muted">Capabilities show once it is selected or tested.</span>
        )}
      </div>
      {p.homepage && (
        <a href={p.homepage} target="_blank" rel="noopener noreferrer" className="w-fit text-[12px] text-muted underline">
          {p.homepage}
        </a>
      )}
    </div>
  );
}
