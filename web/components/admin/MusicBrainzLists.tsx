'use client';

import { V3AlertDialog } from '../ui/alert-dialog';

import NotesHelp from './NotesHelp';
import NotesSettingsSaveBar from './NotesSettingsSaveBar';
import { countLeafDiffs } from './settings/form-diff';
import type { QueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Card, Pill, Seg } from './ui';
import { adminJson, useAdminMutation, useAdminQuery, type AdminFetch } from '../../lib/admin-query';
import { useZodForm } from '../../lib/form';
import { TextField } from '../../lib/form-fields';
import { seriesCheckSchema } from '../../lib/schemas.generated';

type SeriesList = {
  id: string; label: string; entityType: 'recording' | 'release-group'; enabled: boolean;
  origin: 'supplied' | 'custom'; ranked: boolean; editionGroup?: string; editionYear?: number;
  fetchedAt: string | null; lastError: string | null; members: number; matches: number;
};
type CheckedList = {
  existing?: SeriesList; checkId?: string; id?: string; name?: string;
  entityType?: 'recording' | 'release-group'; members?: number; numberedMembers?: number;
  sample?: Array<{ id: string; title: string; rank: string | null }>;
};
type ListPatch = { ids: string[]; enabled?: boolean; ranked?: boolean; removed?: boolean };

export default function MusicBrainzLists({ adminFetch, hydrated }: { adminFetch: AdminFetch; hydrated: boolean }) {
  const lists = useAdminQuery<{ enabled: boolean; lists: SeriesList[] }>({
    key: ['sleeve-notes', 'series'], adminFetch, enabled: hydrated,
    request: (fetcher, signal) => adminJson(fetcher, '/sleeve-notes/series', undefined, signal), staleTime: 10_000,
  });
  const refresh = async (_data: unknown, _vars: unknown, client: QueryClient) => {
    await client.invalidateQueries({ queryKey: ['sleeve-notes'] });
  };
  const configure = useAdminMutation<{ ok: boolean }, ListPatch>({
    adminFetch, request: (patch, fetcher) => adminJson(fetcher, '/sleeve-notes/series/configure', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    }), onDone: refresh,
  });
  const check = useAdminMutation<CheckedList, { input: string }>({
    adminFetch, request: (input, fetcher) => adminJson(fetcher, '/sleeve-notes/series/check', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
    }),
  });
  const add = useAdminMutation<{ id: string }, { checkId: string; ranked: boolean }>({
    adminFetch, request: (input, fetcher) => adminJson(fetcher, '/sleeve-notes/series', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
    }), onDone: refresh,
  });
  const form = useZodForm(seriesCheckSchema, { input: '' });
  const [preview, setPreview] = useState<CheckedList | null>(null);
  const [ranked, setRanked] = useState(false);
  const [message, setMessage] = useState('');
  const [removeList, setRemoveList] = useState<SeriesList|null>(null);
  const [savingChoices,setSavingChoices] = useState(false);
  const busy = savingChoices || configure.isPending || add.isPending || check.isPending;
  type Choice = Pick<SeriesList, 'enabled'|'ranked'>;
  const [drafts,setDrafts] = useState<Record<string,{baseline:Choice;value:Choice}>>({});
  const displayed = (lists.data?.lists ?? []).map(item=>({...item,...drafts[item.id]?.value}));
  const changedCount = Object.values(drafts).reduce((n,entry)=>n+countLeafDiffs(entry.baseline,entry.value),0);
  function stage(patch:ListPatch) {
    setMessage('');
    setDrafts(previous=>{
      const next={...previous};
      for(const id of patch.ids) {
        const item=lists.data?.lists.find(item=>item.id===id);
        if(!item)continue;
        const baseline=next[id]?.baseline??{enabled:item.enabled,ranked:item.ranked};
        const value={...(next[id]?.value??baseline),
          ...(patch.enabled===undefined?{}:{enabled:patch.enabled}),
          ...(patch.ranked===undefined?{}:{ranked:patch.ranked})};
        if(countLeafDiffs(baseline,value))next[id]={baseline,value};else delete next[id];
      }
      return next;
    });
  }
  async function saveChoices() {
    if(busy)return;
    setSavingChoices(true);
    setMessage('');
    try {
      for(const [id,{baseline,value}] of Object.entries(drafts)) {
        try {
          await configure.mutateAsync({ids:[id],
            ...(baseline.enabled===value.enabled?{}:{enabled:value.enabled}),
            ...(baseline.ranked===value.ranked?{}:{ranked:value.ranked})});
          setDrafts(previous=>{const next={...previous};delete next[id];return next;});
        } catch {setMessage('Some list settings were not saved. Your remaining changes are kept; try saving again.');return;}
      }
      setMessage('MusicBrainz list settings saved.');
    } finally {setSavingChoices(false);}
  }
  const family = displayed.filter((item) => item.editionGroup === '1001-albums');

  async function change(patch: ListPatch) {
    setMessage('');
    try {
      await configure.mutateAsync(patch);
      if(patch.removed)setDrafts(previous=>Object.fromEntries(Object.entries(previous).filter(([id])=>!patch.ids.includes(id))));
      setMessage(patch.removed ? 'Custom list removed. Saved history is kept.' : 'List settings saved.');
    } catch { /* The mutation renders the controller's error below. */ }
  }

  function row(item: SeriesList) {
    item={...item,...drafts[item.id]?.value};
    const status = !item.enabled ? 'Disabled' : item.lastError ? 'Needs attention'
      : !lists.data?.enabled ? 'Collection paused' : item.fetchedAt ? 'Cached' : 'Waiting for collection';
    return <article id={`mbseries-${item.id}`} key={item.id} className="border border-border/70 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <a href={`https://musicbrainz.org/series/${item.id}`} target="_blank" rel="noreferrer" className="text-[13px] font-semibold hover:underline">{item.label}{item.editionYear ? ` · ${item.editionYear}` : ''} ↗</a>
          <p className="mt-1 text-xs text-muted">{item.origin === 'supplied' ? 'Supplied' : 'Custom'} · {item.entityType === 'recording' ? 'Tracks' : 'Albums'} · {item.members.toLocaleString()} cached members · {item.matches.toLocaleString()} library track matches</p>
        </div>
        <Pill tone={item.enabled ? 'ink' : 'default'}>{status}</Pill>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <div role="group" aria-label={`Enable ${item.label}${item.editionYear ? ` ${item.editionYear}` : ''}`}>
          <Seg value={item.enabled ? 'on' : 'off'} disabled={busy} options={[{ id: 'off', label: 'Off' }, { id: 'on', label: 'On' }]} onChange={(value) => stage({ ids: [item.id], enabled: value === 'on' })} />
        </div>
        {item.origin === 'custom' && <>
          <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={item.ranked} disabled={busy} onChange={(event) => stage({ ids: [item.id], ranked: event.target.checked })} />Use positions as rankings</label>
          <button type="button" disabled={busy} onClick={() => setRemoveList(item)} className="text-xs text-primary hover:underline disabled:opacity-50">Remove custom list</button>
        </>}
      </div>
      {item.origin === 'custom' && <p className="mt-2 text-xs text-muted">Example Spark wording: “{item.entityType === 'recording' ? 'This track' : 'This album'} {item.ranked ? 'was ranked number 12 in' : 'was included in'} {item.label}.” {item.ranked && 'Only an explicit numeric position is used.'}</p>}
      {item.lastError && <details className="mt-2 text-xs text-muted"><summary className="cursor-pointer">Refresh details</summary><p className="mt-1">{item.lastError}</p></details>}
    </article>;
  }

  return <div className="space-y-3">
    <NotesSettingsSaveBar count={changedCount} section="MusicBrainz Lists" busy={busy} onSave={()=>void saveChoices()} onDiscard={()=>{setDrafts({});configure.reset();setMessage('');}} />
    <Card headingLevel={2} title="MusicBrainz Lists" right={<NotesHelp text="These lists add facts about recordings and albums in published selections. Turning a list off stops using its facts but keeps saved history. Use rankings only when the list supplies meaningful positions." />} sub="Save or discard changes to enabled lists and rankings">
    <p className="mb-4 text-[13px] leading-[1.55] text-muted">Enabled lists supply source-backed facts about tracks and albums in your library. Disabling stops refreshes and Story Spark offers; cached material and air history are kept.</p>
    {lists.data && !lists.data.enabled && <p className="mb-4 text-xs text-muted">Sleeve Notes is off. You can manage lists here; background collection waits until it is enabled.</p>}
    {lists.isLoading && <p role="status" className="text-[13px] text-muted">Loading lists…</p>}
    {lists.error && <div role="alert" className="text-[13px]"><p>{lists.error instanceof Error ? lists.error.message : 'Could not load lists'}</p><button type="button" onClick={() => void lists.refetch()} className="mt-2 text-primary hover:underline">Retry lists</button></div>}
    <div className="space-y-3">
      {displayed.filter((item) => item.origin === 'custom').map(row)}
      <details className="border border-border p-3"><summary className="cursor-pointer text-[13px] font-medium">Supplied lists · {displayed.filter((item) => item.origin === 'supplied' && item.enabled).length} enabled</summary><div className="mt-3 space-y-3">
      {displayed.filter((item) => item.origin === 'supplied' && item.editionGroup !== '1001-albums').map(row)}
      {!!family.length && <details className="border border-border p-3">
        <summary className="cursor-pointer text-[13px] font-medium">1001 Albums You Must Hear Before You Die · {family.filter((item) => item.enabled).length} of {family.length} editions enabled</summary>
        <div className="mt-3 flex flex-wrap gap-3 text-xs">
          <button type="button" disabled={busy} onClick={() => stage({ ids: family.map((item) => item.id), enabled: true })} className="text-primary hover:underline disabled:opacity-50">Enable all editions</button>
          <button type="button" disabled={busy} onClick={() => stage({ ids: family.map((item) => item.id), enabled: false })} className="text-primary hover:underline disabled:opacity-50">Disable all editions</button>
        </div>
        <div className="mt-3 space-y-3">{family.map(row)}</div>
      </details>}
      </div></details>
    </div>
    <div className="mt-5 border-t border-border pt-4">
      <form onSubmit={form.handleSubmit(async (input) => {
        setMessage(''); setPreview(null); setRanked(false);
        try { setPreview(await check.mutateAsync(input)); } catch { /* Error rendered below. */ }
      })} onChange={() => { setPreview(null); check.reset(); add.reset(); }} className="space-y-3">
        <TextField control={form.control} name="input" label="Add a MusicBrainz Series" placeholder="Paste a Series URL or MBID" description="Checking retrieves the list name, type and example members. Tracks and album release groups are supported." disabled={busy} />
        <button type="submit" disabled={busy || !form.formState.isValid} className="border border-border px-3 py-2 text-xs font-medium disabled:opacity-50">{check.isPending ? 'Checking…' : 'Check list'}</button>
      </form>
      {preview?.existing && <div className="mt-3 text-[13px]"><p>This list is already supplied or added: {preview.existing.label}.</p><a href={`#mbseries-${preview.existing.id}`} className="mt-2 inline-block text-primary hover:underline" onClick={() => {
        let ancestor = document.getElementById(`mbseries-${preview.existing?.id}`)?.parentElement;
        while (ancestor) { if (ancestor.tagName === 'DETAILS') ancestor.setAttribute('open', ''); ancestor = ancestor.parentElement; }
      }}>Open existing list</a>{!preview.existing.enabled && <button type="button" disabled={busy} onClick={() => stage({ ids: [preview.existing!.id], enabled: true })} className="ml-3 text-primary hover:underline">Re-enable list</button>}</div>}
      {preview?.checkId && <div className="mt-3 border border-border p-3 text-[13px]">
        <p className="font-semibold">{preview.name}</p><p className="mt-1 text-xs text-muted">{preview.entityType === 'recording' ? 'Tracks' : 'Albums'} · {preview.members} members</p>
        <ul className="mt-2 list-disc pl-5 text-xs">{preview.sample?.map((item) => <li key={item.id}>{item.title}</li>)}</ul>
        <label className="mt-3 flex items-center gap-2 text-xs"><input type="checkbox" checked={ranked} onChange={(event) => setRanked(event.target.checked)} />Use positions as rankings</label>
        <p className="mt-2 text-xs text-muted">Example wording: “{(ranked ? preview.sample?.find((item) => item.rank) : preview.sample?.[0])?.title ?? (preview.entityType === 'recording' ? 'This track' : 'This album')} {ranked && preview.sample?.some((item) => item.rank) ? `was ranked number ${preview.sample.find((item) => item.rank)?.rank} in` : 'was included in'} {preview.name}.” Positions can describe catalogue or chronological order; choose rankings only for a ranked list.</p>
        <button type="button" disabled={busy} onClick={async () => {
          try { await add.mutateAsync({ checkId: preview.checkId!, ranked }); setPreview(null); form.reset(); setMessage('List added. Collection will run in the background while Sleeve Notes is enabled.'); } catch { /* Error rendered below. */ }
        }} className="mt-3 bg-ink px-3 py-2 text-xs font-semibold text-bg disabled:opacity-50">Add list</button>
      </div>}
    </div>
    <V3AlertDialog open={!!removeList} onOpenChange={open=>{if(!open) setRemoveList(null);}}
      title="Remove custom list?" description={removeList ? `Remove ${removeList.label}? Its facts will stop being offered. Cached material and air history are kept.` : ''}
      confirmLabel="Remove list" cancelLabel="Cancel" danger
      onConfirm={()=>{if(removeList && !busy) void change({ids:[removeList.id],removed:true});}} />
    {message && <p role="status" className="mt-3 text-[13px]">{message}</p>}
    {(configure.error || check.error || add.error) && <p role="alert" className="mt-3 text-[13px]">{(configure.error || check.error || add.error)?.message}</p>}
  </Card></div>;
}
