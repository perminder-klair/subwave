'use client';

import { Fragment, useEffect, useRef, useState, type FormEvent } from 'react';
import { Disc3, Loader2, Play, Plus, Search, Square, Trash2, X } from 'lucide-react';
import { InputGroup, InputGroupAddon, InputGroupInput } from '../ui/input-group';
import { V3AlertDialog } from '../ui/alert-dialog';
import { Btn, Card, Eyebrow, Pill } from './ui';
import { ADMIN_API_URL, useAdminAuth } from '../../lib/adminAuth';
import { adminJson, useAdminMutation, useAdminQuery } from '../../lib/admin-query';
import { fmtDuration } from './library/bits';
import { useWatch } from 'react-hook-form';
import { useZodForm } from '../../lib/form';
import { TextField } from '../../lib/form-fields';
import { flowProtectionSchema, subFlowNameSchema } from '../../lib/schemas.generated';
import { useSettingsMutation, useSettingsQuery } from './settings/queries';
import { albumSelection } from './library/sub-flow-order';
import { useJoinPreview } from './library/useJoinPreview';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';
import { dashKeys } from './dash/queries';

type Track = { id: string; title: string; duration: number | null; artist: string | null; album: string | null; order?: number };
type Flow = { id: string; name: string; tracks: Track[]; enabled: boolean; revision: number; orderVerified: boolean; verification: 'pending' | 'verified' | 'failed'; verificationError: string | null };
type Album = { id: string; name: string; artist: string | null; year: number | null; coverArt: string | null };

function JoinProtection() {
  const { adminFetch, hydrated, needsAuth } = useAdminAuth();
  const settings = useSettingsQuery<{ values?: { picker?: { flowProtectBeforeSec?: number; flowProtectAfterSec?: number } } }>({
    adminFetch, enabled: hydrated && !needsAuth, refetchOnMount: 'always',
  });
  const form = useZodForm(flowProtectionSchema, { flowProtectBeforeSec: 5, flowProtectAfterSec: 5 });
  const { isDirty } = form.formState;
  const loadedSettings = useRef<typeof settings.data>(undefined);
  const save = useSettingsMutation({ adminFetch });
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (settings.data && !isDirty && loadedSettings.current !== settings.data) {
      loadedSettings.current = settings.data;
      form.reset({
        flowProtectBeforeSec: settings.data.values?.picker?.flowProtectBeforeSec ?? 5,
        flowProtectAfterSec: settings.data.values?.picker?.flowProtectAfterSec ?? 5,
      });
    }
  }, [settings.data, isDirty, form]);
  return <Card headingLevel={2} title="Join protection" sub="Keep joins clear of speech and jingles">
    <form onSubmit={form.handleSubmit(async values => {
      setMessage('');
      try {
        const receipt = await save.mutateAsync({ picker: values });
        form.reset(values);
        setMessage(receipt.refreshError ? 'Saved, but could not reload settings. Reload the page to check the saved values.' : 'Join protection saved. It applies to newly queued Flows.');
      } catch { setMessage('Could not save join protection. Your changes are still here; try again.'); }
    })} className="grid gap-4">
      <p className="text-sm text-muted">Choose how many seconds to keep clear before and after each join. Speech and jingles can play elsewhere in the Flow. Changes apply to newly queued Flows.</p>
      {settings.isError && <p role="alert" className="text-sm text-muted">Could not load join protection. <Btn sm onClick={() => { void settings.refetch(); }}>Try again</Btn></p>}
      <fieldset disabled={!settings.data || save.isPending} className="flex flex-wrap items-end gap-4">
        <TextField control={form.control} name="flowProtectBeforeSec" label="Before join (seconds)" numeric min={1} max={30} step={1} className="w-full sm:w-52" />
        <TextField control={form.control} name="flowProtectAfterSec" label="After join (seconds)" numeric min={1} max={30} step={1} className="w-full sm:w-52" />
        <Btn type="submit" tone="accent" disabled={!isDirty}>{save.isPending ? 'Saving…' : 'Save protection'}</Btn>
      </fieldset>
      <p className="text-xs text-muted">1–30 seconds on each side. The default is 5 seconds.</p>
      {message && <p role="status" className="text-sm text-muted">{message}</p>}
    </form>
  </Card>;
}

export default function SubFlowDraft() {
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [browsedAlbum, setAlbum] = useState<Album | null>(null);
  const [albumFlow, setAlbumFlow] = useState<{ id: string; revision: number } | null>(null);
  const [artFailed, setArtFailed] = useState(false);
  const [tracks, setTracks] = useState<Track[]>([]);
  const nameForm = useZodForm(subFlowNameSchema, { name: '' });
  const name = useWatch({ control: nameForm.control, name: 'name' }) ?? '';
  const [editing, setEditing] = useState<{ id: string; revision: number } | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [pendingDelete, setPendingDelete] = useState<Flow | null>(null);
  const savedHeading = useRef<HTMLSpanElement>(null);
  const [queuedMessage, setQueuedMessage] = useState<string | null>(null);
  const { adminFetch, hydrated, needsAuth } = useAdminAuth();
  const preview = useJoinPreview(JSON.stringify(tracks.map(track => track.id)), adminFetch);
  const flowsQuery = useAdminQuery({
    key: ['sub-flow', 'definitions'], adminFetch, enabled: hydrated && !needsAuth,
    refetchInterval: 5000,
    request: (fetcher, signal) => adminJson<{ flows: Flow[] }>(fetcher, '/library/sub-flow', undefined, signal),
  });
  const flows = flowsQuery.data?.flows ?? [];
  const saveFlow = useAdminMutation({
    adminFetch,
    request: (value: { id: string | null; revision?: number; name: string; enabled: boolean; trackIds: string[] }, fetcher) =>
      adminJson<{ flow: Flow }>(fetcher, value.id ? `/library/sub-flow/${encodeURIComponent(value.id)}` : '/library/sub-flow', {
        method: value.id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: value.name, enabled: value.enabled, trackIds: value.trackIds, ...(value.revision ? { revision: value.revision } : {}) }),
      }),
    onDone: async (_data, _value, client) => { await client.invalidateQueries({ queryKey: ['sub-flow', 'definitions'] }); },
  });
  const deleteFlow = useAdminMutation({
    adminFetch,
    request: (flow: Flow, fetcher) => adminJson(fetcher, `/library/sub-flow/${encodeURIComponent(flow.id)}?revision=${flow.revision}`, { method: 'DELETE' }),
    onDone: async (_data, _value, client) => { await client.invalidateQueries({ queryKey: ['sub-flow', 'definitions'] }); },
  });
  const setFlowEnabled = useAdminMutation({
    adminFetch,
    request: (flow: Flow, fetcher) => adminJson(fetcher, `/library/sub-flow/${encodeURIComponent(flow.id)}/enabled`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: flow.revision, enabled: !flow.enabled }),
    }),
    onDone: async (_data, _value, client) => { await client.invalidateQueries({ queryKey: ['sub-flow', 'definitions'] }); },
  });
  const queueFlow = useAdminMutation({
    adminFetch,
    request: (flow: Flow, fetcher) => adminJson(fetcher, `/library/sub-flow/${encodeURIComponent(flow.id)}/queue`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: flow.revision }),
    }),
    onDone: async (_data, flow, client) => {
      setQueuedMessage(`“${flow.name}” queued with protected joins. View it in the Dash queue.`);
      await client.invalidateQueries({ queryKey: dashKeys.status() });
    },
  });
  const albums = useAdminQuery({
    key: ['sub-flow', 'albums', submitted], adminFetch,
    enabled: hydrated && !needsAuth && !!submitted,
    request: (fetcher, signal) => adminJson<{ albums: Album[] }>(fetcher, `/library/sub-flow/albums?q=${encodeURIComponent(submitted)}`, undefined, signal),
  });
  const savedAlbum = useAdminQuery({
    key: ['sub-flow', 'saved-album', albumFlow?.id, albumFlow?.revision], adminFetch,
    enabled: hydrated && !needsAuth && !!albumFlow,
    request: (fetcher, signal) => adminJson<{ album: Album }>(fetcher, `/library/sub-flow/${encodeURIComponent(albumFlow?.id ?? '')}/album`, undefined, signal),
  });
  const album = browsedAlbum ?? (albumFlow ? savedAlbum.data?.album : null) ?? null;
  const albumTracks = useAdminQuery({
    key: ['sub-flow', 'album', album?.id], adminFetch,
    enabled: hydrated && !needsAuth && !!album,
    request: (fetcher, signal) => adminJson<{ tracks: (Track & { order: number })[] }>(fetcher, `/library/sub-flow/albums/${encodeURIComponent(album?.id ?? '')}/tracks`, undefined, signal),
  });
  const availableTracks = albumTracks.data?.tracks ?? [];

  const reset = () => { setTracks([]); nameForm.reset({ name: '' }); setEditing(null); setEnabled(true); };
  const edit = (flow: Flow) => {
    // A saved Flow must not be checked against a previously browsed album.
    setQuery(''); setSubmitted(''); setAlbum(null);
    setAlbumFlow({ id: flow.id, revision: flow.revision }); setArtFailed(false);
    setEditing({ id: flow.id, revision: flow.revision });
    nameForm.reset({ name: flow.name }); setTracks([...flow.tracks]); setEnabled(flow.enabled);
    requestAnimationFrame(() => nameForm.setFocus('name'));
  };
  const selectedOrder = albumSelection(tracks.map(track => track.id), availableTracks);
  const selectionValid = !!selectedOrder && selectedOrder.every((id, index) => id === tracks[index]?.id);
  const albumLoaded = !!album && !!albumTracks.data;
  const canAdd = (track: Track) => !saveFlow.isPending && tracks.length < 3 && !tracks.some(t => t.id === track.id)
    && !!albumSelection([...tracks.map(item => item.id), track.id], availableTracks);
  const add = (track: Track) => {
    if (!canAdd(track)) return;
    setTracks(current => {
      if (current.some(t => t.id === track.id) || current.length >= 3) return current;
      const next = [...current];
      next.push(track);
      const ids = albumSelection(next.map(item => item.id), availableTracks);
      return ids ? ids.map(id => next.find(item => item.id === id)!) : current;
    });
  };
  const save = async () => {
    if (tracks.length < 2 || !(await nameForm.trigger())) return;
    try {
      await saveFlow.mutateAsync({ id: editing?.id ?? null, revision: editing?.revision, name: name.trim(), enabled, trackIds: tracks.map(track => track.id) });
      reset();
    } catch { /* mutation displays the error and keeps the editor intact */ }
  };
  const findAlbum = (event: FormEvent) => {
    event.preventDefault();
    const text = query.trim();
    if (text === submitted) void albums.refetch();
    else setSubmitted(text);
    setAlbum(null);
    setAlbumFlow(null);
  };

  return (
    <div className="grid min-w-0 gap-5 max-sm:[&_[data-slot=input-group]]:min-h-11 max-sm:[&_button]:min-h-11 max-sm:[&_button]:min-w-11 max-sm:[&_input]:min-h-11 [@media(pointer:coarse)]:[&_[data-slot=input-group]]:min-h-11 [@media(pointer:coarse)]:[&_button]:min-h-11 [@media(pointer:coarse)]:[&_button]:min-w-11 [@media(pointer:coarse)]:[&_input]:min-h-11">
      <section className="card">
        <div className="p-4">
          <Eyebrow className="text-vermilion">Library</Eyebrow>
          <h1 className="mt-1.5 text-[22px] font-extrabold tracking-[-0.02em]">Sub/Flow</h1>
          <p className="mt-1 max-w-3xl text-[11px] leading-[1.6] text-muted">Keep two or three neighbouring album tracks together, with no gaps between them. Speech and jingles stay clear of the joins.</p>
          <p className="mt-2 max-w-3xl text-[11px] leading-[1.6] text-muted">Build a Flow below, then queue it yourself or let the DJ choose it when it suits the show. Choosing any of its tracks from the Library plays the whole Flow. Only one Flow can be queued or playing at a time. Listener requests and playlists set to play in order still play tracks separately.</p>
        </div>
      </section>
      <Card headingLevel={2} title="Build a Sub/Flow" sub="Choose an album, then add its tracks in order">
        <fieldset disabled={saveFlow.isPending} className="grid min-w-0 gap-5">
          <form onSubmit={findAlbum} className="flex flex-wrap gap-2">
            <InputGroup className="min-w-0 flex-1">
              <InputGroupAddon><Search /></InputGroupAddon>
              <InputGroupInput aria-label="Search albums" placeholder="Search albums or artists" value={query} onChange={event => setQuery(event.target.value)} />
            </InputGroup>
            <Btn type="submit" tone="accent" disabled={!query.trim()}>Search</Btn>
            <Btn onClick={() => { setQuery(''); setSubmitted(''); setAlbum(null); setAlbumFlow(null); }}>Clear</Btn>
          </form>
          {albumFlow && !album && <div aria-live="polite">
            {savedAlbum.isFetching && <p className="text-sm text-muted">Loading saved Flow’s album…</p>}
            {savedAlbum.isError && <p role="alert" className="text-sm text-muted">Could not load this Flow’s album. <Btn sm onClick={() => { void savedAlbum.refetch(); }}>Try again</Btn></p>}
          </div>}
          {submitted && !album && <div className="grid gap-2" aria-live="polite">
            {albums.isFetching && <p className="text-sm text-muted">Searching albums…</p>}
            {albums.isError && <p className="text-sm text-muted">Could not search albums. Try again.</p>}
            {!albums.isFetching && !albums.isError && albums.data?.albums.length === 0 && <p className="text-sm text-muted">No albums found.</p>}
            {albums.data?.albums.map(item => <button key={item.id} type="button" onClick={() => { setAlbum(item); setArtFailed(false); }} className="flex items-center gap-3 border border-separator-strong p-3 text-left hover:bg-ink-soft">
              <Disc3 size={24} className="text-muted" /><span><span className="block text-sm font-bold">{item.name}</span><span className="text-xs text-muted">{[item.artist, item.year].filter(Boolean).join(' · ')}</span></span>
            </button>)}
          </div>}

          <div>
            <div className="mb-2 flex items-baseline justify-between gap-2"><h3 className="text-sm font-bold">Flow tracks</h3><span className="text-xs text-muted">{tracks.length} of 3 · at least 2 required</span></div>
            <TooltipProvider delayDuration={250}><div className="grid items-stretch gap-2 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)]">
              {[0, 1, 2].map(index => {
                const track = tracks[index];
                const next = tracks[index + 1];
                const isActive = preview.active === index;
                const canPreview = !!track && !!next && (!albumLoaded || !!albumSelection([track.id, next.id], availableTracks));
                const label = isActive && preview.loading ? 'Cancel join preview' : isActive && preview.playing ? 'Stop join preview' : 'Listen to join';
                return <Fragment key={index}><div onDragOver={event => event.preventDefault()} onDrop={event => {
                  event.preventDefault();
                  const selected = availableTracks.find(item => item.id === event.dataTransfer.getData('text/plain'));
                  if (selected) add(selected);
                }} className="min-w-0 border border-separator-strong bg-bg p-3">
                  <span className="text-xs text-muted">Track {index + 1}</span>
                  {track ? <><p className="mt-1 truncate text-sm font-bold" title={track.title}>{track.title}</p><p className="text-xs text-muted">{fmtDuration(track.duration) ?? 'Duration unknown'}</p>
                    <div className="mt-3 flex gap-1">
                      <Btn sm aria-label={`Remove ${track.title}`} onClick={() => setTracks(current => current.filter(item => item.id !== track.id))}><X size={14} /></Btn>
                    </div></> : <p className="mt-2 text-sm text-muted">Drag or add a track</p>}
                </div>{index < 2 && <div className="flex items-center justify-center">
                  <Tooltip><TooltipTrigger asChild><span tabIndex={canPreview ? undefined : 0}>
                    <Btn className="size-11 p-0" disabled={!canPreview} aria-label={`${label} between tracks ${index + 1} and ${index + 2}`} aria-pressed={isActive}
                      onClick={() => { if (track && next) void preview.toggle(index, [track.id, next.id]); }}>
                      {isActive && preview.loading ? <Loader2 size={16} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : isActive && preview.playing ? <Square size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
                    </Btn>
                  </span></TooltipTrigger><TooltipContent className="max-w-72 rounded-none border border-border bg-ink leading-5 whitespace-normal text-bg">
                    {canPreview ? `${label} · up to 10 seconds either side` : 'Choose two neighbouring album tracks to listen to their join.'}
                  </TooltipContent></Tooltip>
                </div>}</Fragment>;
              })}
            </div></TooltipProvider>
            {preview.active != null && preview.loading && <p role="status" className="mt-2 text-xs text-muted">Preparing join preview… press again to cancel.</p>}
            {preview.message && <p role="status" className="mt-2 text-sm text-muted">{preview.message}</p>}
            {tracks.length > 0 && <p className="mt-2 text-xs text-muted">Add neighbouring tracks from the same album. They stay in album order.</p>}
            {tracks.length > 1 && albumLoaded && !selectionValid && <p role="alert" className="mt-2 text-sm text-muted">Choose consecutive tracks from this album, with no gaps.</p>}
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <TextField control={nameForm.control} name="name" label="Flow name" placeholder="Name this Flow" maxLength={200} className="min-w-48 flex-1" />
            <Btn tone="accent" onClick={() => { void save(); }} disabled={!name.trim() || tracks.length < 2 || saveFlow.isPending || (albumLoaded && !selectionValid)}>{saveFlow.isPending ? 'Saving…' : editing ? 'Update Flow' : 'Save Flow'}</Btn>
            <Btn onClick={reset}>Clear</Btn>
          </div>

          {album && <div className="grid gap-4 border-t border-separator-strong pt-5 sm:grid-cols-[180px_minmax(0,1fr)]">
            <div>
              <div className="grid aspect-square w-full max-w-44 place-items-center overflow-hidden border border-separator-strong bg-ink-soft text-muted">{!artFailed && album.coverArt ? <img src={`${ADMIN_API_URL}/cover/${encodeURIComponent(album.coverArt)}`} alt="" className="h-full w-full object-cover" onError={() => setArtFailed(true)} /> : <Disc3 size={52} aria-label="Artwork unavailable" />}</div>
              <h3 className="mt-3 font-bold">{album.name}</h3><p className="text-sm text-muted">{[album.artist, album.year].filter(Boolean).join(' · ')}</p>
            </div>
            <div className="min-w-0"><h3 className="mb-2 text-sm font-bold">Album tracks</h3><p className="mb-2 text-xs text-muted">Drag a track to a slot or use Add.</p>
              {albumTracks.isFetching && <p className="text-sm text-muted">Loading tracks…</p>}
              {albumTracks.isError && <p className="text-sm text-muted">Could not load this album. Search and try again.</p>}
              {!albumTracks.isFetching && !albumTracks.isError && availableTracks.length === 0 && <p className="text-sm text-muted">No tracks found for this album.</p>}
              {availableTracks.map((track, index) => <div key={track.id} draggable onDragStart={event => event.dataTransfer.setData('text/plain', track.id)} className="flex items-center gap-3 border-b border-separator-strong py-3">
                <span className="w-5 text-right text-xs text-muted">{index + 1}</span><span className="min-w-0 flex-1 truncate text-sm">{track.title}</span><span className="text-xs text-muted">{fmtDuration(track.duration)}</span>
                <Btn sm onClick={() => add(track)} disabled={!canAdd(track)} aria-label={`Add ${track.title} to Flow`}><Plus size={14} /> Add</Btn>
              </div>)}
            </div>
          </div>}
        </fieldset>
      </Card>

      <JoinProtection />
      <Card headingLevel={2} anchor="saved-flows" title={<span ref={savedHeading} tabIndex={-1} className="focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-vermilion">Saved Flows</span>} sub={`${flows.length} Flow${flows.length === 1 ? '' : 's'}`}>
        {queueFlow.isPending && <p role="status" className="mb-3 text-sm text-muted">Preparing the complete Flow and checking its audio…</p>}
        {queuedMessage && <p role="status" className="mb-3 text-sm text-muted">{queuedMessage}</p>}
        {flowsQuery.isLoading ? <p className="text-sm text-muted">Loading Flows…</p> : flowsQuery.isError ? <p className="text-sm text-muted">Could not load saved Flows. Refresh the page to try again.</p> : flows.length === 0 ? <p className="text-sm text-muted">No Flows saved yet. Build one above to see it here.</p> : <div className="grid gap-3">{flows.map(flow =>
          <div key={flow.id} className="grid min-w-0 gap-3 border border-separator-strong p-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
            <div className="min-w-0 [overflow-wrap:anywhere]"><div className="flex flex-wrap items-center gap-2"><strong className="min-w-0 text-sm">{flow.name}</strong><Pill>{flow.enabled ? 'Enabled' : 'Disabled'}</Pill><Pill>{flow.verification === 'pending' ? 'Checking…' : flow.verification === 'verified' ? 'Audio checked at save' : 'Needs attention'}</Pill>{!flow.orderVerified && <Pill>Check track order</Pill>}</div><p className="mt-1 text-xs text-muted">{flow.tracks.map(track => track.title).join(' → ')}</p>{flow.verificationError && <p className="mt-1 text-xs text-muted">{flow.verificationError}</p>}</div>
            <div className="flex min-w-0 flex-wrap gap-2">
            <Btn sm tone="accent" disabled={queueFlow.isPending || !flow.enabled || flow.verification !== 'verified' || !flow.orderVerified}
              onClick={() => { setQueuedMessage(null); void queueFlow.mutateAsync(flow).catch(() => {}); }}>Queue Flow</Btn>
            <Btn sm disabled={saveFlow.isPending} onClick={() => edit(flow)}>Edit</Btn>
            <Btn sm disabled={setFlowEnabled.isPending} onClick={() => { void setFlowEnabled.mutateAsync(flow).catch(() => {}); }}>{flow.enabled ? 'Disable' : 'Enable'}</Btn>
            <Btn sm disabled={saveFlow.isPending || flow.verification === 'pending'} onClick={() => { void saveFlow.mutateAsync({ id: flow.id, revision: flow.revision, name: flow.name, enabled: flow.enabled, trackIds: flow.tracks.map(track => track.id) }).catch(() => {}); }}>Check again</Btn>
            <Btn sm disabled={deleteFlow.isPending} aria-label={`Delete ${flow.name}`} onClick={() => setPendingDelete(flow)}><Trash2 size={14} /></Btn>
            </div>
          </div>)}</div>}
      </Card>
      <V3AlertDialog
        open={!!pendingDelete}
        onOpenChange={open => { if (!open) setPendingDelete(null); }}
        title="Delete Flow?"
        description={`Delete “${pendingDelete?.name ?? ''}”? This cannot be undone.`}
        confirmLabel="Delete Flow"
        cancelLabel="Cancel"
        danger
        onConfirm={() => {
          if (!pendingDelete || deleteFlow.isPending) return;
          const flow = pendingDelete;
          void deleteFlow.mutateAsync(flow).then(() => {
            if (editing?.id === flow.id) reset();
            savedHeading.current?.focus();
          }).catch(() => {});
        }}
      />
    </div>
  );
}
