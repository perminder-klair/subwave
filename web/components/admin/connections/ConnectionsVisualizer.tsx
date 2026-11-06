'use client';

import Link from 'next/link';
import NotesHelp from '../NotesHelp';
import { Input } from '../../ui/input';
import { formatNotesDate } from '../sleeve-notes-view';
import {notify} from '../../../lib/notify';
import {brainQueueChoice,storiesHref} from '../sleeve-notes-view';
import { useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ExternalLink, LocateFixed, RefreshCw, Search, X } from 'lucide-react';
import type { NowPlayingResponse } from '../../../lib/types';
import { adminJson, type AdminFetch, useAdminMutation, useAdminQuery } from '../../../lib/admin-query';
import { Card, Btn, Eyebrow, Pill } from '../ui';
import ConnectionsGraph from './ConnectionsGraph';
import { EditorDialog } from '../../ui/editor-dialog';
import { currentArtistOnOverview } from './current-artist';
import { COVERAGE_LABELS, withBrainCoverage } from './coverage';
import { ALL_EDGE_TYPES, toggleConnectionGroup } from './filters';
import { useBrainKeySetting } from './key-preferences';
import {
  connectionKeys,
  loadBrainCoverage,
  loadConnectionGraph,
  loadConnectionOverview,
  resolveCurrentConnection,
  searchConnectionEntities,
} from './queries';
import type {
  BrainCoverage,
  ConnectionEntityType,
  ConnectionGraphData,
  ConnectionNode,
} from './types';

const ENTITY_TYPES = new Set<ConnectionEntityType>(['artist', 'recording', 'release', 'release-group', 'series', 'library-artist', 'library-album']);

function providerName(value: string): string {
  if (value === 'musicbrainz') return 'MusicBrainz';
  if (value === 'genius') return 'Genius';
  return value ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : 'Source';
}

function entityLabel(node: ConnectionNode): string {
  if (node.kind === 'external-recording') return 'External track';
  if (node.kind === 'contributor') return 'Credited person';
  if (node.kind === 'release') return 'Album or release';
  if (node.kind === 'series') return 'Editorial list';
  return node.kind.charAt(0).toUpperCase() + node.kind.slice(1);
}

export default function ConnectionsVisualizer({
  adminFetch,
  hydrated,
  readOnly = false,
  timezone,
}: {
  adminFetch: AdminFetch;
  hydrated: boolean;
  readOnly?: boolean;
  timezone?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const rawType = searchParams.get('focusType');
  const focusType = rawType && ENTITY_TYPES.has(rawType as ConnectionEntityType)
    ? rawType as ConnectionEntityType
    : null;
  const focusId = searchParams.get('focusId')?.trim() || null;
  const overview = !focusType || !focusId;
  const [fullscreen, setFullscreen] = useState(false);
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [includeExternal, setIncludeExternal] = useBrainKeySetting('includeExternal');
  const [includeUnresearchedArtists, setIncludeUnresearchedArtists] = useBrainKeySetting('includeUnresearchedArtists');
  const [edgeTypes, setEdgeTypes] = useBrainKeySetting('edgeTypes');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [currentMessage, setCurrentMessage] = useState('');
  const [targetingArtist, setTargetingArtist] = useState(false);
  const [detailsOpen,setDetailsOpen]=useState(true);
  const selectionScope = useRef<string | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const [zoomToSelection, setZoomToSelection] = useState(false);
  const parentLayers = useRef<Array<{ entityType: ConnectionEntityType | null; entityId: string | null; node: ConnectionNode }>>([]);
  const pendingReturn = useRef<{ scope: string; node: ConnectionNode } | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(draft.trim()), 220);
    return () => window.clearTimeout(timer);
  }, [draft]);

  const search = useAdminQuery({
    key: connectionKeys.search(query),
    adminFetch,
    enabled: hydrated && query.length >= 2,
    request: (fetcher, signal) => searchConnectionEntities(fetcher, query, signal),
    staleTime: 30_000,
  });
  const graph = useAdminQuery({
    key: [...connectionKeys.graph(focusType ?? '', focusId ?? '', ALL_EDGE_TYPES), readOnly],
    adminFetch,
    enabled: hydrated && !!focusType && !!focusId,
    request: (fetcher, signal) => {
      if (!focusType || !focusId) throw new Error('Choose a Connections entity first.');
      return loadConnectionGraph(fetcher, focusType, focusId, ALL_EDGE_TYPES, signal);
    },
    staleTime: 30_000,
  });
  const artistOverview = useAdminQuery({
    key: [...connectionKeys.overview(ALL_EDGE_TYPES), readOnly], adminFetch,
    enabled: hydrated && overview,
    request: (fetcher, signal) => loadConnectionOverview(fetcher, ALL_EDGE_TYPES, signal),
    staleTime: 30_000,
  });
  const map = overview ? artistOverview : graph;
  const coverage = useAdminQuery({
    key: [...connectionKeys.coverage(), readOnly], adminFetch, enabled: hydrated,
    request: (fetcher, signal) => loadBrainCoverage(fetcher, signal),
    staleTime: 10_000, refetchInterval: readOnly ? false : 15_000,
  });
  const coveredMap = useMemo(() => withBrainCoverage(map.data, coverage.data?.artists), [map.data, coverage.data]);
  const queueResearch = useAdminMutation<{ queued: boolean; state: 'queued' | 'researching' }, { entityType: 'artist' | 'library-artist' | 'release' | 'release-group' | 'library-album'; entityId: string }>({
    adminFetch,
    request: (vars, fetcher) => adminJson(fetcher, '/sleeve-notes/connections/research', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(vars),
    }),
    onDone: async (_data, _vars, client) => {
      await Promise.all([
        client.invalidateQueries({ queryKey: connectionKeys.coverage() }),
        client.invalidateQueries({ queryKey: ['sleeve-notes', 'readout'] }),
        client.invalidateQueries({ queryKey: ['sleeve-notes', 'status'] }),
      ]);
    },
  });
  const populate = useAdminMutation<{ artists: number }, void>({
    adminFetch,
    request: (_vars, fetcher) => adminJson(fetcher, '/sleeve-notes/connections/populate', { method: 'POST' }),
    onDone: async (_data, _vars, client) => { await client.invalidateQueries({ queryKey: connectionKeys.all() }); },
  });
  const queueTrack=useAdminMutation<{track:{id:string;title:string;artist:string|null};queuePosition:number;reason:string}, {entityType:string;entityId:string}>({
    adminFetch,
    request:(selection,fetcher)=>adminJson(fetcher,'/dj/queue-track',{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({selection}),
    }),
    onDone:async(result,_vars,client)=>{
      notify.ok(`Queued “${result.track.title}” · position ${result.queuePosition}`);
      await client.invalidateQueries({queryKey:['sleeve-notes','live-summary']});
    },
  });
  const nowPlaying = useAdminQuery<NowPlayingResponse>({
    key: [...connectionKeys.all(), 'now-playing'],
    adminFetch,
    enabled: hydrated,
    request: (fetcher, signal) => adminJson(fetcher, '/now-playing', undefined, signal),
    staleTime: 5_000,
    refetchInterval: 5_000,
  });
  const localTrackId = nowPlaying.data?.nowPlaying?.subsonic_id ?? '';
  const currentTrackRef = useRef(localTrackId);
  currentTrackRef.current = localTrackId;
  const current = useAdminQuery({
    key: connectionKeys.current(localTrackId), adminFetch,
    enabled: hydrated && !!localTrackId,
    request: (fetcher, signal) => resolveCurrentConnection(fetcher, localTrackId, signal),
    staleTime: 15_000, refetchInterval: 30_000,
  });

  function choose(entityType: ConnectionEntityType, entityId: string, direction: 'target' | 'down' | 'up' = 'target', openedNode?: ConnectionNode) {
    if (direction !== 'up') { pendingReturn.current = null; setZoomToSelection(false); }
    if (focusType === entityType && focusId === entityId) {
      setSelectedNodeId(`${entityType}:${entityId}`);
      setSelectedEdgeId(null);
      setFocusRequest((request) => request + 1);
      setDraft(''); setQuery(''); setCurrentMessage('');
      return;
    }
    if (direction === 'target') parentLayers.current = [];
    else if (direction === 'down' && openedNode) {
      parentLayers.current.push({ entityType: focusType, entityId: focusId, node: openedNode });
    }
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', 'connections');
    params.set('focusType', entityType);
    params.set('focusId', entityId);
    router.replace(`${pathname ?? '/admin/notes'}?${params.toString()}`, { scroll: false });
    setDraft('');
    setQuery('');
    setSelectedEdgeId(null);
    setSelectedNodeId(null);
    setCurrentMessage('');
    if(!fullscreen) setDetailsOpen(true);
  }

  function clearFocus(restoredNode?: ConnectionNode) {
    parentLayers.current = [];
    pendingReturn.current = restoredNode ? { scope: 'artists', node: restoredNode } : null;
    setZoomToSelection(false);
    const params = new URLSearchParams(searchParams.toString());
    params.delete('focusType');
    params.delete('focusId');
    params.set('tab', 'connections');
    router.replace(`${pathname ?? '/admin/notes'}?${params.toString()}`, { scroll: false });
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setCurrentMessage('');
    if(!fullscreen) setDetailsOpen(true);
  }

  function openCurrentTrack() {
    if (!localTrackId) {
      setCurrentMessage('There is no identified track on air right now.');
      return;
    }
    if (!current.data) {
      setCurrentMessage(current.isLoading ? 'Finding the current track…' :
        current.error instanceof Error ? current.error.message : 'The current track has not been matched yet.');
      return;
    }
    choose(current.data.entityType, current.data.entityId);
  }

  async function openCurrentArtist() {
    const artistName = nowPlaying.data?.nowPlaying?.artist;
    if (!artistName && !current.data?.artistNodeId && !current.data?.localArtistId) {
      setCurrentMessage(nowPlaying.isLoading ? 'Finding the current artist…' : 'There is no identified artist on air right now.');
      return;
    }
    setTargetingArtist(true);
    setCurrentMessage('');
    try {
      let node = currentArtistOnOverview(artistOverview.data, current.data, artistName);
      if (!node) {
        const refreshed = await artistOverview.refetch({ throwOnError: true });
        node = currentArtistOnOverview(refreshed.data, current.data, artistName);
      }
      if (currentTrackRef.current !== localTrackId) {
        setCurrentMessage('The track changed while the map loaded. Target the current artist again.');
        return;
      }
      if (!node) {
        setCurrentMessage('The current artist could not be identified unambiguously on the artist map. Try refreshing the library artists.');
        return;
      }
      if (node.researched === false) setIncludeUnresearchedArtists(true);
      if (!node.local) setIncludeExternal(true);
      setDraft(''); setQuery('');
      if (overview) {
        pendingReturn.current = null;
        parentLayers.current = [];
        selectionScope.current = 'artists';
        setSelectedNodeId(node.id);
        setSelectedEdgeId(null);
        setZoomToSelection(true);
        setFocusRequest(request => request + 1);
      } else clearFocus(node);
    } catch (error) {
      setCurrentMessage(error instanceof Error ? error.message : 'The artist map could not be loaded. Try again.');
    } finally { setTargetingArtist(false); }
  }

  function openNode(node: ConnectionNode) {
    if (!node.expandable) return;
    if (node.kind === 'artist' && node.localArtistId) { choose('library-artist', node.localArtistId, 'down', node); return; }
    if (ENTITY_TYPES.has(node.entityType as ConnectionEntityType)) choose(node.entityType as ConnectionEntityType, node.entityId, 'down', node);
  }

  function selectNode(node: ConnectionNode) {
    if(!fullscreen) setDetailsOpen(true);
    setSelectedNodeId(node.id); setSelectedEdgeId(null);
    const params=new URLSearchParams(searchParams.toString());
    params.set('brainSelected',node.id);
    router.replace(`${pathname??'/admin/notes'}?${params}`,{scroll:false});
  }

  const visibleGraph = useMemo<ConnectionGraphData | null>(() => {
    if (!coveredMap) return null;
    const edges = coveredMap.edges.filter((edge) => edgeTypes.includes(edge.type));
    const linked = new Set(edges.flatMap((edge) => [edge.source, edge.target]));
    const nodes = coveredMap.nodes.filter((node) => {
      if (!includeUnresearchedArtists && node.kind === 'artist' && node.local && node.researched === false) return false;
      return node.id === coveredMap?.focusId
        || ((includeExternal || node.local || node.kind === 'contributor')
          && (node.local || linked.has(node.id)));
    });
    const ids = new Set(nodes.map((node) => node.id));
    return { ...coveredMap, nodes, edges: edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)) };
  }, [coveredMap, includeExternal, includeUnresearchedArtists, edgeTypes]);

  useEffect(() => {
    if (!visibleGraph) return;
    const requestedTrack=searchParams.get('brainTrack');
    const scope = overview ? 'artists' : `${visibleGraph.focusId}:${requestedTrack??''}`;
    const restored = pendingReturn.current;
    if (restored && restored.scope === (overview ? 'artists' : `${focusType}:${focusId}`)) {
      const node = visibleGraph.nodes.find((item) => item.id === restored.node.id)
        ?? visibleGraph.nodes.find((item) => item.kind === 'artist' && restored.node.kind === 'artist'
          && !!restored.node.localArtistId && item.localArtistId === restored.node.localArtistId);
      pendingReturn.current = null;
      selectionScope.current = scope;
      setSelectedNodeId(node?.id ?? visibleGraph.focusId ?? null);
      setSelectedEdgeId(null);
      setZoomToSelection(!!node);
      if (node) setFocusRequest((request) => request + 1);
      return;
    }
    if (selectionScope.current !== scope) {
      selectionScope.current = scope;
      const retained=visibleGraph.nodes.find(node=>requestedTrack&&node.localTrackId===requestedTrack)?.id??searchParams.get('brainSelected');
      setSelectedNodeId(visibleGraph.nodes.some(node=>node.id===retained)?retained:overview?null:visibleGraph.focusId||null);
      setSelectedEdgeId(null);
      return;
    }
    if (selectedNodeId && visibleGraph.nodes.some((node) => node.id === selectedNodeId)) return;
    if (selectedEdgeId && visibleGraph.edges.some((edge) => edge.id === selectedEdgeId)) return;
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
  }, [selectedNodeId, selectedEdgeId, visibleGraph, overview, focusType, focusId, searchParams]);

  const selectedNode = visibleGraph?.nodes.find((node) => node.id === selectedNodeId) ?? null;
  const libraryArtistCount = useMemo(() => new Set(map.data?.nodes.map((node) => node.localArtistId)
    .filter(Boolean)).size, [map.data]);
  const rootNode = map.data?.nodes.find((node) => node.id === map.data?.focusId);
  const parentArtistId = rootNode?.kind === 'release' ? rootNode.localArtistId : null;
  const canLayerDown = !!selectedNode && selectedNode.id !== map.data?.focusId && selectedNode.expandable
    && ((selectedNode.kind === 'artist' && !!selectedNode.localArtistId)
      || ENTITY_TYPES.has(selectedNode.entityType as ConnectionEntityType));

  const albumTarget=selectedNode?.kind==='release' && ['release','release-group','library-album'].includes(selectedNode.entityType)
    ? {entityType:selectedNode.entityType as 'release'|'release-group'|'library-album',entityId:selectedNode.entityId}:null;
  const researchTarget = albumTarget ?? (selectedNode?.kind === 'artist' && (selectedNode.entityType === 'artist' || selectedNode.localArtistId || selectedNode.entityType === 'library-artist')
    ? { entityType: selectedNode.entityType === 'artist' ? 'artist' as const : 'library-artist' as const,
      entityId: selectedNode.entityType === 'artist' ? selectedNode.entityId : selectedNode.localArtistId ?? selectedNode.entityId } : null);
  const albumCoverage=useAdminQuery<{active:boolean;coverage:BrainCoverage & {error?:string|null}}>({
    key:[...connectionKeys.coverage(),'album',albumTarget?.entityType,albumTarget?.entityId,readOnly],adminFetch,
    enabled:hydrated && !!albumTarget,
    request:(fetcher,signal)=>adminJson(fetcher,`/sleeve-notes/connections/album-coverage?${new URLSearchParams({entityType:albumTarget!.entityType,entityId:albumTarget!.entityId})}`,undefined,signal),
    staleTime:10_000,refetchInterval:readOnly?false:15_000,
  });
  const selectedResearch=albumTarget?albumCoverage:coverage;
  const sameResearchTarget = !!researchTarget && queueResearch.variables?.entityType === researchTarget.entityType
    && queueResearch.variables?.entityId === researchTarget.entityId;
  const selectedCoverage = albumTarget?albumCoverage.data?.coverage:selectedNode?.coverage;

  function layerUp() {
    const parent = parentLayers.current.pop();
    if (parent?.entityType && parent.entityId) {
      pendingReturn.current = { scope: `${parent.entityType}:${parent.entityId}`, node: parent.node };
      choose(parent.entityType, parent.entityId, 'up');
    } else if (parent) clearFocus(parent.node);
    else if (parentArtistId && rootNode) {
      pendingReturn.current = { scope: `library-artist:${parentArtistId}`, node: rootNode };
      choose('library-artist', parentArtistId, 'up');
    } else clearFocus(rootNode);
  }

  const catalogueResults = overview && query.length >= 2 ? visibleGraph?.nodes.filter((node) =>
    node.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())
    && !search.data?.some((result) => result.nodeId === node.id)).slice(0, 8) ?? [] : [];
  const selectedEdge = visibleGraph?.edges.find((edge) => edge.id === selectedEdgeId) ?? null;
  const selectedEdgeEndpoints = selectedEdge && visibleGraph ? {
    source: visibleGraph.nodes.find((node) => node.id === selectedEdge.source) ?? null,
    target: visibleGraph.nodes.find((node) => node.id === selectedEdge.target) ?? null,
  } : null;

  const queueChoice=brainQueueChoice(overview,rootNode,selectedNode);
  const queueNode=queueChoice.node;
  const queueTarget=queueNode
    ? queueNode.localTrackId ? {entityType:'library-track',entityId:queueNode.localTrackId}
      : queueNode.kind==='artist'&&queueNode.localArtistId ? {entityType:'library-artist',entityId:queueNode.localArtistId}
        : {entityType:queueNode.entityType,entityId:queueNode.entityId} : null;
  const queueResult=queueTrack.data;
  const sameQueueTarget=queueTarget&&queueTrack.variables?.entityType===queueTarget.entityType&&queueTrack.variables?.entityId===queueTarget.entityId;
  const queueButton=<Btn title="Append this operator selection to the queue. Recent plays and duplicates are allowed; never-play blocks remain in force."
    disabled={!queueTarget||queueTrack.isPending} tone="solid" className="max-w-full text-left whitespace-normal"
    onClick={()=>{if(queueTarget) queueTrack.mutate(queueTarget);}}>
    {queueTrack.isPending?'Adding to queue…':queueChoice.label}
  </Btn>;
  const queuePanel=<section className="space-y-3 border-t border-border pt-3" aria-label="Queue from Station Brain">
    <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-semibold">Queue from Station Brain</h3>
      <NotesHelp text="This is an operator choice, just like Library → Queue on air. Recent plays and duplicate tracks are allowed; the never-play blocklist still applies. Artist and album choices use mood and flow within that selection." /></div>
    {queueNode?<>
      <p className="text-[13px] font-medium break-words">{queueNode.title}</p>
      <p className="text-xs leading-5 text-muted">{queueNode.kind==='recording'?'Add this exact recording to the end of the on-air queue.':'Choose one library track from this '+(queueNode.kind==='artist'?'artist':'album')+' for the current mood and the music it will follow.'}</p>
    </>:<p className="text-[13px] text-muted">Select an artist on the map to choose a track for the on-air queue.</p>}
    {!fullscreen&&queueButton}
    {sameQueueTarget&&queueTrack.error&&<p role="alert" className="text-[13px] text-vermilion">{queueTrack.error.message}</p>}
    {sameQueueTarget&&queueResult&&<div role="status" className="space-y-1 text-[13px]">
      <p className="font-medium">Queued: {queueResult.track.artist||'Unknown artist'} · {queueResult.track.title}</p>
      <p>Position {queueResult.queuePosition}</p><p className="text-xs text-muted">{queueResult.reason}</p>
    </div>}
  </section>;

  function changeFullscreen(open: boolean) {
    if(open) setDetailsOpen(false);
    setFullscreen(open);
    if (!open) requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('[aria-label="Open full-screen map"]')?.focus());
  }

  const detailsPanel = (selectedNode || selectedEdge) && (!fullscreen||detailsOpen) && <Card headingLevel={2}
            className={fullscreen?'absolute top-3 right-3 bottom-3 z-10 w-[min(22rem,calc(100%-1.5rem))] overflow-y-auto':undefined}
            right={fullscreen?<Btn sm onClick={()=>setDetailsOpen(false)}>Hide details</Btn>:undefined} title={selectedEdge ? 'Relationship evidence' : selectedNode ? entityLabel(selectedNode) : 'Details'}
            sub={selectedEdge ? providerName(selectedEdge.provider) : selectedNode?.local ? 'matched to this library' : 'external or unresolved'}>
            {fullscreen&&queuePanel}
            {selectedEdge && selectedEdgeEndpoints ? (
              <div className="space-y-4">
                <p className="text-[15px] leading-6"><strong>{selectedEdgeEndpoints.source?.title}</strong> {selectedEdge.label} <strong>{selectedEdgeEndpoints.target?.title}</strong></p>
                {selectedEdge.count && selectedEdge.count > 1 ? <p className="text-xs text-muted">{selectedEdge.count} track connections · showing up to five sourced examples</p> : null}
                <Eyebrow>Evidence</Eyebrow>
                {(selectedEdge.sources ?? [selectedEdge]).map((source, index) => <div key={index} className="space-y-2 border-b border-border/50 pb-3 last:border-0">
                  <p className="text-[13px] leading-[1.55] text-muted">{source.evidence}</p>
                  {source.attribution && <p className="text-xs leading-5 text-muted">{source.attribution}</p>}
                  {source.sourceUrl && <a href={source.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">Open source <ExternalLink className="size-3" /></a>}
                </div>)}
              </div>
            ) : selectedNode ? (
              <div className="space-y-4">
                <div><h3 className="text-lg font-semibold">{selectedNode.title}</h3>{selectedNode.subtitle && <p className="text-[13px] text-muted">{selectedNode.subtitle}</p>}</div>
                <div className="flex flex-wrap gap-2"><Pill tone={selectedNode.local ? 'solid' : 'default'}>{selectedNode.kind === 'contributor' ? 'Shared credit' : selectedNode.local ? 'In library' : 'External'}</Pill><Pill tone="ink">{entityLabel(selectedNode)}</Pill></div>
                {selectedNode.trackCount !== undefined && <p className="text-xs text-muted">{selectedNode.trackCount} local tracks · {selectedNode.connectionCount ?? 0} connections</p>}
                {researchTarget && <div className="space-y-2 border-t border-border/60 pt-3">
                  <Eyebrow>Research coverage</Eyebrow>
                  {selectedCoverage ? <>
                    <p className="text-[13px] font-medium">{COVERAGE_LABELS[selectedCoverage.state]}</p>
                    {selectedCoverage.lastResearchedAt && <p className="text-xs text-muted">Last completed research: {formatNotesDate(selectedCoverage.lastResearchedAt,timezone)}</p>}
                    <p className="text-xs leading-5 text-muted">{selectedCoverage.usableStories} usable {selectedCoverage.usableStories === 1 ? 'story' : 'stories'} {albumTarget?'saved for this album':'across this artist, their albums and tracks'}. The DJ still checks track relevance and recent use.</p>
                  </> : <p className="text-xs text-muted">{selectedResearch.error ? 'Coverage could not be loaded.' : selectedResearch.isLoading ? 'Checking coverage…' : 'No coverage is saved yet.'}</p>}
                  {readOnly || selectedResearch.data?.active === false ? <p className="text-xs text-muted">Enable Sleeve Notes to add research to the queue.</p> : <>
                    <button type="button" disabled={queueResearch.isPending || !selectedCoverage?.canQueue || selectedResearch.isFetching}
                      onClick={() => queueResearch.mutate(researchTarget)}
                      className="border border-border px-3 py-2 text-xs font-medium text-primary hover:bg-muted/20 disabled:cursor-default disabled:opacity-50">
                      {sameResearchTarget && queueResearch.isPending ? 'Adding to queue…' : selectedCoverage?.state === 'researching' ? 'Researching'
                        : selectedCoverage?.state === 'queued' ? 'Queued' : selectedCoverage?.hasResearchHistory ? 'Research again' : 'Add to research queue'}
                    </button>
                    <p className="text-xs leading-5 text-muted">Research runs when broadcast activity allows. Existing stories stay available.</p>
                    {selectedCoverage && !selectedCoverage.canQueue && !['queued', 'researching'].includes(selectedCoverage.state) && <p className="text-xs text-muted">A confirmed {albumTarget?'album':'artist'} identity is needed. Select it from your library to resolve it.</p>}
                  </>}
                  {albumCoverage.data?.coverage.error && albumTarget && <p className="text-xs text-muted">{albumCoverage.data.coverage.error}</p>}
                  {sameResearchTarget && queueResearch.error && <p role="alert" className="text-xs text-muted">{queueResearch.error.message}</p>}
                  {sameResearchTarget && queueResearch.isSuccess && <p role="status" className="text-xs text-muted">{queueResearch.data.queued ? 'Added to the research queue.' : 'This research is already in progress.'}</p>}
                </div>}
                {selectedNode.entityType === 'library-artist' && <p className="text-xs leading-5 text-muted">Albums and tracks come from your library. Musical connections appear as Sleeve Notes encounters and researches the music.</p>}
                {selectedNode.expandable && ENTITY_TYPES.has(selectedNode.entityType as ConnectionEntityType) && (
                  <button type="button" onClick={() => openNode(selectedNode)} className="block text-[13px] font-medium text-primary hover:underline">{selectedNode.kind === 'artist' ? 'Open albums' : selectedNode.entityType === 'library-album' ? 'Open tracks' : 'Open this neighbourhood'}</button>
                )}
                {selectedNode.local && selectedNode.entityType !== 'series' && <Link href={storiesHref(selectedNode,searchParams.toString())} className="block text-[13px] font-medium text-primary hover:underline">Open saved stories for {selectedNode.title}</Link>}
                {selectedNode.sourceUrl && <a href={selectedNode.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">Open source <ExternalLink className="size-3" /></a>}
              </div>
            ) : <p className="text-[13px] text-muted">Select a node or relationship to inspect it.</p>}
            <div className="mt-5 border-t border-border/60 pt-4 text-xs leading-5 text-muted">
              Credit names marked “identity unresolved” are kept separate. Connections never merges people on a matching name alone.
            </div>
          </Card>;

  const mapView = (
    map.isLoading ? (
        <Card headingLevel={2} title="Waking the Station Brain"><p role="status" className="text-[13px] text-muted">Loading {overview ? 'your artist network' : focusType === 'library-album' ? 'the album’s tracks' : focusType === 'library-artist' || focusType === 'artist' ? 'the artist’s albums' : 'the track neighbourhood'}…</p></Card>
      ) : map.error && !map.data ? (
        <Card headingLevel={2} title="Could not load Connections">
          <p className="text-[13px] text-muted">{map.error instanceof Error ? map.error.message : 'The graph is temporarily unavailable.'}</p>
          <button type="button" onClick={() => void map.refetch()} className="mt-3 text-[13px] font-medium text-primary hover:underline">Try again</button>
        </Card>
      ) : visibleGraph ? (
        <div className={fullscreen?'relative h-full min-h-0':`grid min-w-0 items-start gap-5 ${selectedNode || selectedEdge ? '2xl:grid-cols-[minmax(0,1fr)_20rem]' : ''}`}>
          <Card headingLevel={2} className={fullscreen?'flex h-full min-h-0 flex-col border-0':undefined}
            bodyClass={fullscreen?'relative flex min-h-0 flex-1 flex-col !p-0':undefined}
            right={fullscreen?<div className="flex max-w-full flex-wrap items-center gap-2">{queueButton}{(selectedNode||selectedEdge)&&<Btn sm onClick={()=>setDetailsOpen(!detailsOpen)}>{detailsOpen?'Hide details':'Show details'}</Btn>}</div>:undefined}
            title={overview ? 'Artist constellation' : focusType === 'library-artist' || focusType === 'artist' ? 'Artist albums' : focusType === 'library-album' ? 'Album tracks' : 'Musical neighbourhood'} sub={`${visibleGraph.nodes.length.toLocaleString()} entities${overview ? ` · ${libraryArtistCount.toLocaleString()} library artists` : ''} · ${visibleGraph.edges.length.toLocaleString()} connections`}>
            {overview && !fullscreen && <p className="mb-3 text-xs text-muted">Artist rings show research coverage. Select an artist for music queue and research options; double-click to open their albums.</p>}
            {map.error && <p role="status" className="mb-3 text-xs text-muted">The map could not refresh. Showing the last loaded connections.</p>}
            {map.data && (
              <>
                {map.data.nodes.length === 0 ? <p className="py-16 text-center text-[13px] text-muted">{visibleGraph.active ? 'Your library’s artists appear here as the library scan completes. Saved research adds stories and connections when available.' : 'No saved map yet. Enable Sleeve Notes in Settings to gather connections.'}</p> :
                  <ConnectionsGraph
                    data={coveredMap ?? map.data} visibleData={visibleGraph} fullscreen={fullscreen} onToggleFullscreen={() => changeFullscreen(!fullscreen)} selectedNode={selectedNodeId} selectedEdge={selectedEdgeId}
                    focusRequest={focusRequest} zoomToSelection={zoomToSelection}
                    canLayerUp={!overview} canLayerDown={canLayerDown}
                    onLayerUp={layerUp} onLayerDown={() => { if (canLayerDown && selectedNode) openNode(selectedNode); }}
                    edgeTypes={edgeTypes} includeExternal={includeExternal}
                    includeUnresearchedArtists={includeUnresearchedArtists}
                    onToggleUnresearchedArtists={() => setIncludeUnresearchedArtists((value) => !value)}
                    onToggleGroup={(types) => setEdgeTypes((current) => toggleConnectionGroup(current, types))}
                    onToggleExternal={() => setIncludeExternal((value) => !value)}
                    overview={overview} currentNodeId={overview ? currentArtistOnOverview(coveredMap, current.data, nowPlaying.data?.nowPlaying?.artist)?.id : current.data?.nodeId}
                    onSelectNode={selectNode}
                    onClearSelection={() => { setSelectedNodeId(null); setSelectedEdgeId(null); }}
                    onSelectEdge={(edge) => { if(!fullscreen) setDetailsOpen(true);setSelectedEdgeId(edge.id); setSelectedNodeId(null); }}
                    onOpenNode={openNode} />}
                {!fullscreen&&queuePanel}
              </>
            )}
            {visibleGraph.truncated && <p className="mt-3 text-xs text-muted">{overview ? 'Library artists take priority within the map’s display limit. Search to explore an artist beyond this view.' : 'This neighbourhood reached the display limit. Open a connected local node to continue exploring.'}</p>}
            {fullscreen&&detailsPanel}
          </Card>
          {!fullscreen&&detailsPanel}
        </div>
      ) : null
  );

  return (
    <div className="space-y-5">
      <Card headingLevel={2} title="The Station Brain" right={<NotesHelp text="The map shows saved musical connections. Select an item to read its details; open it to browse albums or tracks. Focus the map and use the left or right arrow key to select an item, then Enter to open it." />} sub={overview ? 'Explore the artists and musical connections in your library' : 'Follow the connections around this music'}>
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
          <div className="relative">
            <label className="relative block">
              <span className="sr-only">Search Connections</span>
              <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
              <Input type="search" maxLength={120} value={draft} onChange={(event) => setDraft(event.target.value)}
                placeholder="Search tracks, artists, albums or lists…"
                className="pr-9 pl-9" />
              {draft && <button type="button" onClick={() => setDraft('')} aria-label="Clear search"
                className="absolute top-1/2 right-2 -translate-y-1/2 p-1 text-muted hover:text-ink"><X className="size-4" /></button>}
            </label>
            {query.length >= 2 && (
              <div className="absolute z-20 mt-1 max-h-72 w-full overflow-y-auto border border-border bg-card">
                {search.isLoading && <p className="px-3 py-3 text-xs text-muted">Searching…</p>}
                {search.error && <p className="px-3 py-3 text-xs text-muted">Connections search is temporarily unavailable.</p>}
                {search.data?.map((result) => (
                  <button key={result.nodeId} type="button" onClick={() => choose(result.entityType, result.entityId)}
                    className="flex w-full items-center justify-between gap-3 border-b border-border/50 px-3 py-2.5 text-left last:border-0 hover:bg-muted/20">
                    <span className="min-w-0"><span className="block truncate text-[13px] font-medium">{result.title}</span>
                      <span className="block truncate text-xs text-muted">{result.subtitle || result.kind}</span></span>
                    <Pill tone="default">{result.kind}</Pill>
                  </button>
                ))}
                {catalogueResults.map((node) => <button key={node.id} type="button" onClick={() => {
                  selectNode(node); setDraft(''); setQuery('');
                }} className="block w-full border-b border-border/50 px-3 py-2.5 text-left last:border-0 hover:bg-muted/20">
                  <span className="block text-[13px] font-medium">{node.title}</span><span className="text-xs text-muted">{node.subtitle}</span>
                </button>)}
                {!search.isLoading && search.data?.length === 0 && catalogueResults.length === 0 && <p className="px-3 py-3 text-xs text-muted">No Connections entities match.</p>}
              </div>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => void openCurrentArtist()} disabled={targetingArtist || nowPlaying.isLoading}
            className="inline-flex grow items-center justify-center gap-2 border border-border px-3 py-2 text-xs font-medium hover:bg-muted/30 disabled:opacity-50">
            <LocateFixed className="size-4" aria-hidden="true" /> {targetingArtist ? 'Finding current artist…' : 'Target current artist'}
          </button>
          <button type="button" onClick={openCurrentTrack} disabled={!!localTrackId && current.isLoading}
            className="inline-flex grow items-center justify-center gap-2 border border-border px-3 py-2 text-xs font-medium hover:bg-muted/30 disabled:opacity-50">
            <LocateFixed className="size-4" aria-hidden="true" /> Target current track
          </button>
          </div>
        </div>
        {currentMessage && <p role="status" className="mt-2 text-xs text-muted">{currentMessage}</p>}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => void map.refetch()} disabled={map.isFetching}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline disabled:opacity-50">
            <RefreshCw className={`size-3 ${map.isFetching ? 'animate-spin motion-reduce:animate-none' : ''}`} aria-hidden="true" />
            {map.isFetching ? 'Refreshing…' : 'Refresh map'}
          </button>
          {overview && <button type="button" onClick={() => populate.mutate()} disabled={readOnly || populate.isPending || map.data?.active === false}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline disabled:opacity-50">
            <RefreshCw className={`size-3 ${populate.isPending ? 'animate-spin motion-reduce:animate-none' : ''}`} aria-hidden="true" />
            {populate.isPending ? 'Populating artists…' : 'Populate library artists'}
          </button>}
          {!overview && parentArtistId
            && <button type="button" onClick={() => choose('library-artist', parentArtistId)}
              className="text-xs font-medium text-primary hover:underline">Back to artist’s albums</button>}
          {!overview && <button type="button" onClick={() => clearFocus()} className="ml-auto text-xs font-medium text-primary hover:underline">Back to artists</button>}
        </div>
        {readOnly && <p className="mt-3 text-xs text-muted">Browsing saved connections. Library layers are available if previously opened; enable Sleeve Notes in Settings to load new layers.</p>}
        {overview && populate.data && <p role="status" className="mt-3 text-xs text-muted">{populate.data.artists.toLocaleString()} library artists populated. Double-click an artist to load its albums.</p>}
        {coverage.error && <p role="status" className="mt-3 text-xs text-muted">Research coverage could not be refreshed. <button type="button" onClick={() => void coverage.refetch()} className="text-primary hover:underline">Retry coverage</button></p>}
        {overview && populate.error && <p role="alert" className="mt-3 text-xs text-muted">{populate.error.message}</p>}
      </Card>

      {fullscreen ? <EditorDialog open onOpenChange={changeFullscreen} title="Station Brain" className="[&_.v3-scroll]:overflow-hidden [&_.v3-scroll>div]:h-full [&_.v3-scroll>div]:p-0">{mapView}</EditorDialog> : mapView}
    </div>
  );
}
