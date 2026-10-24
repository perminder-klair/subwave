'use client';

import NotesStorage, {NotesResearchProgress, type ResearchProgress} from './NotesResearchHealth';
import NotesSettingsSaveBar from './NotesSettingsSaveBar';
import { notesSettingsDefaults, notesSettingsPatch, notesSettingsSchema, type NotesSettingsForm } from './notes-settings';
import { useZodForm } from '../../lib/form';
import { TextField } from '../../lib/form-fields';
import { countLeafDiffs } from './settings/form-diff';

import { V3AlertDialog } from '../ui/alert-dialog';
import { useDebounceValue } from 'usehooks-ts';
import NotesHelp from './NotesHelp';
import { formatNotesDate } from './sleeve-notes-view';
import SleeveNotesSegmentSettings from './SleeveNotesSegmentSettings';

import Link from 'next/link';
import type { FormEvent, ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ArrowRight, ExternalLink, GitBranch, Search } from 'lucide-react';
import { Card, Btn, Eyebrow, Pill, Seg } from './ui';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { SectionTabs } from './SectionTabs';
import { NOTES_TABS as TABS } from './notes-tabs';
import HeardOnAir from './HeardOnAir';
import NotesLiveSummary from './NotesLiveSummary';
import NotesRecentlyAired from './NotesRecentlyAired';
import { useAdminAuth } from '../../lib/adminAuth';
import { adminJson, useAdminQuery, useAdminMutation, type AdminFetch } from '../../lib/admin-query';
import { notify } from '../../lib/notify';
import { useSettingsMutation, useSettingsQuery } from './settings/queries';
import type { SettingsData } from './settings/shared';
import ConnectionsVisualizer from './connections/ConnectionsVisualizer';
import ExternalDiscoveries from './connections/ExternalDiscoveries';
import GeniusCaptureNotice from './connections/GeniusCaptureNotice';
import AiringReviews from './AiringReviews';
import MusicBrainzLists from './MusicBrainzLists';

type NotesTab = 'overview' | 'stories' | 'heard' | 'moderation' | 'connections' | 'config';

type NotesStatus = {
  enabled: boolean;
  reviewReady?: number;
  timezone?: string;
  providerEnabled: boolean;
  providerConfigured: boolean;
  providerTokenSource?: 'settings' | 'environment' | 'missing';
  collectionRunning: boolean;
  collectionPaused?: boolean;
  collectionBlockedReason: string | null;
  wikipediaPrompt?: string;
  wikipediaDefaultPrompt?: string;
  wikipediaPromptIsCustom?: boolean;
  coverage?: Record<string, number>;
};

type NotesReadout = {
  geniusQueue?: {
    minuteRequests: number; minuteLimit: number; dayRequests: number; dayLimit: number | null;
    waitReason: 'backoff' | 'allowance' | null; retryAt: string | null;
    pending: { encountered: number; albums: number; samples: number };
    ready: number; readyRequests: number; deferred: number; running: number; oldestReadyAt: string | null; oldestReadyAgeSeconds: number | null;
    enabled: boolean; configured: boolean; worker: { running: boolean; quiet: boolean } | null;
  };
  progress?: ResearchProgress;
  researchPausedByBudget?: boolean;
  active: boolean;
  readAt?: number;
  localAttachments: number;
  encounters: number;
  pendingMatches: number;
  retainedClaims: number;
  wikipediaArtistChunkCharacterTarget?: number;
  wikipediaAlbumChunkCharacterTarget?: number;
  wikipediaExtractAverageLatencyMs?: number | null;
  wikipediaExtractCallCount?: number;
  airtimeClaims: number;
  storyClaims: number;
  connectionClaims: number;
  libraryConnections?: number;
  creditClaims: number;
  recycleBinPending: number;
  researchJobs: number;
  artists: Array<{ name: string; musicbrainzId: string | null; sources: number; claims: number }>;
  claims: Array<{
    id: string;
    review?: {id:string;state:string}|null;
    enabled?: number;
    entityType?: ExploreEntity['entityType'];
    entityId?: string;
    artist: string | null;
    recording: string | null;
    provider: string;
    category: string;
    topic: string;
    wording: string;
    shortWording: string;
    evidence: string;
    sourceUrl: string;
    attribution?: string;
  }>;
  musicBrainzSeries: Array<{
    id: string;
    name: string;
    entityType: 'recording' | 'release-group';
    ranked: number;
    editionYear: number | null;
    fetchedAt: string | null;
    nextRefreshAt: string;
    attempts: number;
    lastError: string | null;
    members: number;
    localClaims: number;
    enabled?: boolean;
    removed?: boolean;
    libraryAlbums: number;
    libraryTracks: number;
  }>;
  jobSummary: Array<{ provider: string; capability: string; state: string; jobs: number; attempts: number; nextDue: string | null; updatedAt: string }>;
  workQueue?: Array<{ provider: string; capability: string; phase: 'ready' | 'first-play' | 'next-play' | 'time-delay' | 'running' | 'unavailable'; jobs: number }>;
  workQueueItems?: Array<{
    id: string; provider: string; capability: string;
    phase: 'ready' | 'first-play' | 'next-play' | 'time-delay' | 'running' | 'unavailable';
    subjectType: string; subjectTitle: string; subjectArtist: string | null;
    priority: number; attempts: number; runAfter: string | null; promotedAt?:string|null;
    wikiNextChunk: number; researchNextSection: number;
  }>;
  providerSummary: Array<{ provider: string; capability: string; outcome: string; status: number | null; requests: number; lastRequestedAt: string }>;
};

type ExploreEntity = {
  entityType: 'artist' | 'recording' | 'release' | 'release-group';
  entityId: string;
  title: string;
  artist: string | null;
  localMatch: boolean;
  sources: number;
  claimCount: number;
  childCount: number;
  updatedAt: string;
};

type ExplorePage = { active: boolean; entities: ExploreEntity[]; total: number; limit: number; offset: number };
type EntityDossier = ExploreEntity & { claims: Array<NotesReadout['claims'][number] & { attribution: string }> };


const EXPLORE_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');


function providerName(provider: string) {
  if (provider === 'web-operator') return 'Archived web research';
  if (provider === 'musicbrainz-series' || provider === 'musicbrainz') return 'MusicBrainz';
  return provider ? `${provider.charAt(0).toUpperCase()}${provider.slice(1)}` : provider;
}

function ClaimEvidence({ provider, evidence }: { provider: string; evidence: string }) {
  if (provider !== 'musicbrainz-series' && provider !== 'genius') return <p className="text-xs leading-5 text-muted">{evidence}</p>;
  let label = provider === 'musicbrainz-series' ? 'MusicBrainz Series membership' : 'Genius metadata';
  try {
    const value = JSON.parse(evidence) as {
      seriesName?: string; rank?: string | number | null; editionYear?: number | null;
      role?: string; names?: string[]; type?: string; target?: { title?: string; artist?: string | null };
    };
    if (provider === 'musicbrainz-series') {
      const details = [
        value.seriesName,
        value.rank ? `Rank ${value.rank}` : null,
        value.editionYear ? `${value.editionYear} edition` : null,
      ].filter(Boolean);
      label = details.join(' · ') || label;
    } else {
      const names = value.names?.join(', ');
      const target = value.target?.title
        ? `${value.target.title}${value.target.artist ? ` · ${value.target.artist}` : ''}`
        : null;
      label = value.role && names ? `${value.role}: ${names}` : value.type && target ? `${value.type.replaceAll('_', ' ')} · ${target}` : label;
    }
  } catch { /* keep the provider fallback */ }
  return <p className="text-xs leading-5 text-muted">{label}</p>;
}

function Metric({ label, value, detail }: { label: string; value: number; detail?: string }) {
  return (
    <div className="border border-border/70 px-3 py-3">
      <div className="text-xl font-semibold tabular-nums">{value.toLocaleString('en-GB')}</div>
      <div className="text-xs text-ink">{label}</div>
      {detail && <div className="mt-1 text-[11px] text-muted">{detail}</div>}
    </div>
  );
}

function CompactMetric({ label, value, detail }: { label: string; value: number | string; detail?: string }) {
  return <div className="min-w-0 border border-border/70 px-3 py-2 lg:px-2 lg:py-1.5">
    <div className="flex items-baseline gap-2">
      <span className="text-lg font-semibold tabular-nums lg:text-base">{typeof value === 'number' ? value.toLocaleString('en-GB') : value}</span>
      <span className="text-xs text-ink">{label}</span>
    </div>
    {detail && <p className="text-[11px] leading-4 text-muted">{detail}</p>}
  </div>;
}

function ReadoutTable({
  title, empty, headings, rows, sub,
}: { title: string; empty: string; headings: string[]; rows: ReactNode[]; sub?: string }) {
  return (
    <Card headingLevel={2} title={title} sub={sub}>
      <div className="max-h-[30rem] overflow-auto border border-border/70">
        <table className="w-full min-w-[650px] text-left text-xs">
          <thead className="sticky top-0 bg-card text-muted">
            <tr>{headings.map((heading) => <th key={heading} className="px-3 py-2 font-medium">{heading}</th>)}</tr>
          </thead>
          <tbody>{rows.length ? rows : <tr><td colSpan={headings.length} className="px-3 py-4 text-muted">{empty}</td></tr>}</tbody>
        </table>
      </div>
    </Card>
  );
}

export function ClaimCard({ claim, adminFetch, readOnly = false }: { claim: NotesReadout['claims'][number]; adminFetch: AdminFetch; readOnly?: boolean }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const review = useAdminMutation<{ id: string;state:string }, void>({ adminFetch,
    request: (_value, fetcher) => adminJson(fetcher, `/sleeve-notes/claims/${encodeURIComponent(claim.id)}/review`, { method: 'POST' }),
    onDone: async (_data, _vars, client) => {
      notify.ok('Fact flagged for background review. Its availability is unchanged.');
      await client.invalidateQueries({ queryKey: ['sleeve-notes'] });
    },
  });
  const availability=useAdminMutation<unknown,'withdraw'|'restore'|'deleted'>({adminFetch,
    request:(action,fetcher)=>adminJson(fetcher,`/sleeve-notes/claims/${encodeURIComponent(claim.id)}/${action}`,{method:'POST'}),
    onDone:async(_data,action,client)=>{notify.ok(action==='withdraw'?'Fact withdrawn from DJ use.':action==='restore'?'Fact restored for DJ use.':'Fact deleted.');await client.invalidateQueries({queryKey:['sleeve-notes']});},
  });
  const currentReview = claim.review ?? review.data;
  const activeReview = currentReview && ['queued','running','ready'].includes(currentReview.state);
  const identity = claim.recording || claim.artist || 'Unmatched entity';
  const subtitle = claim.recording && claim.artist ? claim.artist : providerName(claim.provider);
  return (
    <article className="border border-border/70 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone="ink">{claim.category.replaceAll('-', ' ')}</Pill>
        <span className="text-xs text-muted">{claim.topic}</span>
      </div>
      <h3 className="mt-2 text-[13px] font-semibold">{identity}</h3>
      <p className="text-xs text-muted">{subtitle}</p>
      <div className="mt-3 space-y-2 text-[13px] leading-[1.55]">
        <p>{claim.wording}</p>
      </div>
      {claim.entityId && claim.entityType && <div className="mt-3 flex gap-3 text-xs text-primary">
        <Link href={`/admin/notes?tab=stories&storyType=${claim.entityType}&storyId=${encodeURIComponent(claim.entityId)}`}>Saved story context</Link>
        <Link href={`/admin/notes?tab=connections&focusType=${claim.entityType}&focusId=${encodeURIComponent(claim.entityId)}`}>Station Brain</Link>
      </div>}
      <div className="mt-3 flex flex-wrap items-end justify-between gap-3 border-t border-border/60 pt-2">
        <div className="min-w-0">
          <details><summary className="cursor-pointer text-xs text-muted">Supporting evidence</summary><ClaimEvidence provider={claim.provider} evidence={claim.evidence} /></details>
          {claim.attribution && <p className="mt-1 text-[11px] leading-4 text-muted">{claim.attribution}</p>}
        </div>
        <a href={claim.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex flex-none items-center gap-1 text-xs font-medium text-primary hover:underline">
          {providerName(claim.provider)} source <ExternalLink className="size-3" aria-hidden="true" />
        </a>
      </div>
      {!readOnly && <div className="mt-3 border-t border-border/60 pt-2 [&_button]:max-w-full [&_button]:whitespace-normal">
        <Btn sm disabled={review.isPending || !!activeReview} title="Ask the model to check this fact. The fact stays available for DJ use unless you withdraw it." onClick={() => review.mutate()}
         >{review.isPending ? 'Flagging…' : activeReview ? 'Flagged for review' : currentReview ? 'Flag again' : 'Flag for review'}</Btn>
        {currentReview && <Link href="/admin/notes?tab=moderation" className="ml-3 text-xs text-primary hover:underline">{currentReview.state==='ready'?'Ready for your decision':currentReview.state==='running'?'Reviewing':currentReview.state==='queued'?'Queued for review':'Review completed'} →</Link>}
        <div className="mt-2 flex flex-wrap gap-3">
          <Btn sm title="Keep this fact saved, but change whether the DJ can use it." disabled={availability.isPending} onClick={()=>availability.mutate(claim.enabled===0?'restore':'withdraw')}
           >{claim.enabled===0?'Restore unchanged':'Withdraw from DJ use'}</Btn>
          {claim.enabled===0&&<Btn sm tone="danger" title="Delete this withdrawn fact from future use. Saved airing history is kept." disabled={availability.isPending} onClick={()=>setConfirmDelete(true)}
           >Delete fact</Btn>}
        </div>
        <p className="mt-1 text-[11px] text-muted">{claim.enabled===0?'Withdrawn from DJ use. Dismissing a review will not restore it.':'Flagging requests an AI review and keeps this fact available. Withdraw it separately to stop DJ use immediately.'}</p>
        {availability.error&&<p role="alert" className="mt-1 text-xs text-vermilion">{availability.error.message}</p>}
        {review.error && <p role="alert" className="mt-1 text-xs text-vermilion">{review.error.message}</p>}
      </div>}
      <V3AlertDialog open={confirmDelete && !readOnly} onOpenChange={setConfirmDelete}
        title="Delete this fact?" description="It will no longer be available to the DJ. Saved airing history is kept."
        confirmLabel="Delete fact" cancelLabel="Cancel" danger
        onConfirm={()=>{if(!readOnly && !availability.isPending && claim.enabled===0) availability.mutate('deleted');}} />
    </article>
  );
}

function seriesState(series: NotesReadout['musicBrainzSeries'][number]) {
  if (series.removed) return { label: 'Removed · cache kept', tone: 'default' as const };
  if (series.enabled === false) return { label: 'Disabled · cache kept', tone: 'default' as const };
  if (series.lastError) return { label: 'Needs attention', tone: 'accent' as const };
  if (!series.fetchedAt) return { label: 'Waiting', tone: 'default' as const };
  if (series.members === 0) return { label: 'No members', tone: 'default' as const };
  return { label: 'Cached', tone: 'solid' as const };
}

export default function NotesPanel() {
  const { adminFetch: stationFetch, hydrated } = useAdminAuth();
  const adminFetch = useMemo(() => (path: string, init?: RequestInit) => {
    const cached = path.startsWith('/sleeve-notes/') && (!init?.method || init.method === 'GET');
    return stationFetch(cached ? `${path}${path.includes('?') ? '&' : '?'}cached=1` : path, init);
  }, [stationFetch]);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const rawTab = searchParams.get('tab');
  const fromBrain=searchParams.get('from')==='brain';
  const aliases: Record<string, NotesTab> = { research: 'stories', explore: 'stories', sources: 'stories', settings: 'config', review: 'moderation', brain: 'connections' };
  const tab: NotesTab = rawTab && TABS.some((item) => item.id === rawTab) ? rawTab as NotesTab : aliases[rawTab ?? ''] ?? 'overview';
  const brainView=searchParams.get('brainView')==='discoveries'?'discoveries':'map';
  const storiesView=searchParams.get('storiesView');
  const [storiesMode, setStoriesMode] = useState(rawTab === 'sources' ? 'details' : ['all','recent','browse','details','withdrawn'].includes(storiesView??'') ? storiesView! : rawTab === 'explore' ? 'browse' : 'all');
  useEffect(()=>{if (storiesView&&['all','recent','browse','details','withdrawn'].includes(storiesView)) setStoriesMode(storiesView);},[storiesView]);
  const storyType = searchParams.get('storyType');
  const storyId = searchParams.get('storyId');
  const settingsQuery=useSettingsQuery<SettingsData>({adminFetch,enabled:hydrated});
  const status = useAdminQuery<NotesStatus>({
    key: ['sleeve-notes', 'status'], adminFetch, enabled: hydrated && settingsQuery.data?.values?.djBehaviour?.extendedSleeveNotes===true,
    request: (fetcher, signal) => adminJson(fetcher, '/sleeve-notes/status', undefined, signal),
    staleTime: 10_000, refetchInterval: 30_000,
  });

  const enabled = settingsQuery.data?.values?.djBehaviour?.extendedSleeveNotes === true;
  const story = useAdminQuery<EntityDossier>({
    key: ['sleeve-notes', 'dossier', storyType, storyId], adminFetch,
    enabled: hydrated && enabled && tab === 'stories' && !!storyId && ['artist', 'recording', 'release', 'release-group'].includes(storyType ?? ''),
    request: (fetcher, signal) => adminJson(fetcher, `/sleeve-notes/dossier/${encodeURIComponent(storyType ?? '')}/${encodeURIComponent(storyId ?? '')}`, undefined, signal),
    staleTime: 10_000, refetchInterval:30_000,
  });

  const needsReadout = tab === 'overview' || tab === 'stories' && !storyId && storiesMode === 'details';
  const readout = useAdminQuery<NotesReadout>({
    key: ['sleeve-notes', 'readout', enabled], adminFetch, enabled: hydrated && enabled && needsReadout,
    request: (fetcher, signal) => adminJson(fetcher, `/sleeve-notes/readout${enabled?'':'?cached=1'}`, undefined, signal),
    staleTime: 10_000, refetchInterval: 30_000,
  });
  const libraryConnections = useAdminQuery<{total:number}>({
    key: ['sleeve-notes', 'library-connection-count'], adminFetch,
    enabled: hydrated && enabled && tab === 'overview',
    request: (fetcher, signal) => adminJson(fetcher, '/sleeve-notes/stories?category=library-connections&limit=1', undefined, signal),
    staleTime: 10_000, refetchInterval: 30_000,
  });
  const settingsSave = useSettingsMutation<SettingsData>({ adminFetch });
  const data = readout.data;
  const [search, setSearch] = useState(searchParams.get('q')??'');
  const [storyOffset,setStoryOffset]=useState(0);
  const [debouncedSearch] = useDebounceValue(search, 250);
  const categoryQuery=searchParams.get('category')??'all';
  const [category, setCategory] = useState(categoryQuery);
  useEffect(()=>{setCategory(categoryQuery);setStoryOffset(0);},[categoryQuery]);
  const storyQuery=searchParams.get('q')??'';
  useEffect(()=>{setSearch(storyQuery);setStoryOffset(0);if(fromBrain){setStoriesMode('all');setCategory('all');}},[storyQuery,fromBrain]);
  const [configMessage, setConfigMessage] = useState('');
  const [configSaving, setConfigSaving] = useState(false);
  const [configSaveFailed, setConfigSaveFailed] = useState(false);
  const [wikiRefreshBusy, setWikiRefreshBusy] = useState(false);
  const [wikiRefreshConfirmation, setWikiRefreshConfirmation] = useState<{mode:'clear'|'replace';description:string}|null>(null);
  const [wikiRefreshMessage, setWikiRefreshMessage] = useState('');
  const collection=useAdminQuery<{claims:NotesReadout['claims'];total:number;categories:string[]}>({
    key:['sleeve-notes','stories',debouncedSearch,category,storiesMode,storyOffset],adminFetch,
    enabled:hydrated&&enabled&&tab==='stories'&&!storyId&&!['browse','details'].includes(storiesMode),
    request:(fetcher,signal)=>adminJson(fetcher,`/sleeve-notes/stories?${new URLSearchParams({search:debouncedSearch,category:category==='all'?'':category,recent:storiesMode==='recent'?'1':'0',withdrawn:storiesMode==='withdrawn'?'1':'0',offset:String(storyOffset)})}`,undefined,signal),
    staleTime:10_000, refetchInterval:30_000, placeholderData: (previous,query) => query?.queryKey[3]===category&&query?.queryKey[4]===storiesMode?previous:undefined,
  });
  const backParams=new URLSearchParams(searchParams.toString());
  backParams.delete('storyType');backParams.delete('storyId');backParams.delete('storyName');
  backParams.delete('from');backParams.set('tab',fromBrain?'connections':'stories');
  const storyBack=`${pathname??'/admin/notes'}?${backParams}`;

  function selectTab(next: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', next);
    router.replace(`${pathname ?? '/admin/notes'}?${params.toString()}`, { scroll: false });
  }

  async function prepareWikipediaRefresh(mode: 'clear' | 'replace') {
    if (wikiRefreshBusy || wikiRefreshConfirmation) return;
    setWikiRefreshBusy(true);
    setWikiRefreshMessage('');
    try {
      // admin-query-imperative: wikipedia-refresh-preview
      const preview = await adminJson<{ artists: number; albums: number; claims: number }>(
        adminFetch, '/sleeve-notes/wikipedia-refresh-preview',
      );
      const description = mode === 'clear'
        ? `Disable ${preview.claims} automatic Wikipedia facts for ${preview.artists} artists and ${preview.albums} albums now, then research them again on their next encounter?`
        : `Mark ${preview.artists} artists and ${preview.albums} albums for refresh when each is next played? Existing facts stay available until that entity's full scan succeeds, and only encountered entities enter the research queue.`;
      setWikiRefreshConfirmation({mode,description});
    } catch (error) {
      setWikiRefreshMessage(error instanceof Error ? error.message : 'Could not preview Wikipedia refresh.');
    } finally {
      setWikiRefreshBusy(false);
    }
  }

  async function refreshWikipedia(mode: 'clear' | 'replace') {
    if (wikiRefreshBusy) return;
    setWikiRefreshBusy(true);
    setWikiRefreshMessage('');
    try {
      const result = await adminJson<{ artists: number; albums: number; claimsCleared: number }>(
        adminFetch, '/sleeve-notes/wikipedia-refresh', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }),
        },
      );
      setWikiRefreshMessage(mode === 'clear'
        ? `Marked ${result.artists} artists and ${result.albums} albums for research on next encounter; disabled ${result.claimsCleared} automatic facts.`
        : `Marked ${result.artists} artists and ${result.albums} albums for refresh on next play. Existing facts remain available until each full scan succeeds; jobs are added as entities are encountered.`);
      await Promise.all([readout.refetch(), status.refetch()]);
    } catch (error) {
      setWikiRefreshMessage(error instanceof Error ? error.message : 'Could not mark Wikipedia research for refresh.');
    } finally {
      setWikiRefreshBusy(false);
    }
  }

  async function saveConfig(patch: Record<string, unknown>, success: string) {
    setConfigSaving(true);
    setConfigSaveFailed(false);
    setConfigMessage('');
    try {
      const receipt = await settingsSave.mutateAsync(patch);
      await Promise.all([status.refetch(), settingsQuery.refetch()]);
      setConfigMessage(receipt.refreshError
        ? `Saved, but settings could not be refreshed: ${receipt.refreshError}`
        : success);
      return true;
    } catch (error) {
      setConfigSaveFailed(true);
      setConfigMessage(error instanceof Error ? error.message : 'Could not save Sleeve Notes settings.');
      return false;
    } finally {setConfigSaving(false);}
  }

  if(!enabled)return <Card headingLevel={2} title="Extended Sleeve Notes">
    <p className="text-[13px] text-muted">{settingsQuery.isLoading?'Checking feature status…':settingsQuery.error?'Feature status could not be read.':'Enable Extended Sleeve Notes in Settings → DJ Behaviour to use this feature.'}</p>
    <Link href="/admin/settings?section=behaviour#extended-sleeve-notes" className="mt-3 inline-block text-[13px] text-primary hover:underline">Open DJ Behaviour settings →</Link>
  </Card>;

  return (
    <div className={`mx-auto w-full space-y-5 ${tab === 'connections' ? 'max-w-none' : 'max-w-6xl'}`}>
      <V3AlertDialog open={!!wikiRefreshConfirmation} onOpenChange={open=>{if(!open) setWikiRefreshConfirmation(null);}}
        title={wikiRefreshConfirmation?.mode==='clear'?'Disable automatic facts and refresh?':'Refresh Wikipedia facts on next play?'}
        description={wikiRefreshConfirmation?.description}
        confirmLabel={wikiRefreshConfirmation?.mode==='clear'?'Disable facts and refresh':'Refresh on next play'} cancelLabel="Cancel"
        danger={wikiRefreshConfirmation?.mode==='clear'}
        onConfirm={()=>{if(wikiRefreshConfirmation) void refreshWikipedia(wikiRefreshConfirmation.mode);}} />
      <section className="card">
        <div className="border-b border-ink p-4">
          <Eyebrow className="text-vermilion">Programming</Eyebrow>
          <h1 className="mt-1.5 text-[22px] font-extrabold tracking-[-0.02em]">Extended Sleeve Notes</h1>
          <p className="mt-1 max-w-3xl text-[11px] leading-[1.6] text-muted">
            Give your DJ stories about the music you play. Sleeve Notes gathers source-backed facts and connections; the DJ uses them when they fit.
          </p>
          {status.data?.timezone&&<p className="mt-1 text-[11px] text-muted">Dates and times use the station time zone ({status.data.timezone}).</p>}
        </div>
        <SectionTabs tabs={TABS.map(item=>item.id==='moderation'&&status.data?.reviewReady ? {...item,count:status.data.reviewReady,attention:true}:item)} value={tab} onChange={selectTab} label="Extended Sleeve Notes sections" />
      </section>

      {tab === 'overview' && (
        <OverviewView
          adminFetch={adminFetch}
          enabled={enabled}
          status={status.data}
          statusLoading={status.isLoading || !hydrated}
          statusError={!!status.error}
          readout={data ? {...data, libraryConnections:libraryConnections.data?.total} : undefined}
          onRetryStatus={() => void status.refetch()}
        />
      )}

      <div hidden={tab !== 'config'}>
        <ConfigView
          status={status.data}
          values={settingsQuery.data?.values}
          loading={settingsQuery.isLoading || !hydrated}
          settingsError={settingsQuery.error instanceof Error ? settingsQuery.error.message : null}
          busy={configSaving || settingsSave.isPending}
          message={configMessage}
          saveError={configSaveFailed}
          onDiscard={()=>{setConfigMessage('');setConfigSaveFailed(false);}}
          onSave={saveConfig}
          wikiRefreshBusy={wikiRefreshBusy}
          wikiRefreshMessage={wikiRefreshMessage}
          onWikiRefresh={(mode) => void prepareWikipediaRefresh(mode)}
          adminFetch={adminFetch}
          hydrated={hydrated && tab === 'config'}
        />
      </div>

      {tab !== 'overview' && tab !== 'config' && !hydrated && (
        <Card headingLevel={2} title="Loading collection status"><p className="text-[13px] text-muted">Connecting to the station…</p></Card>
      )}
      {tab !== 'overview' && tab !== 'config' && hydrated && status.isLoading && (
        <Card headingLevel={2} title="Checking collection status"><p className="text-[13px] text-muted">Reading the station-wide setting…</p></Card>
      )}
      {tab !== 'overview' && tab !== 'config' && hydrated && status.error && (
        <Card headingLevel={2} title="Collection status unavailable">
          <p className="text-[13px] leading-[1.55] text-muted">The station’s Extended Sleeve Notes setting could not be read. Retry before assuming collection is on or off.</p>
          <button type="button" onClick={() => void status.refetch()} className="mt-3 text-[13px] font-medium text-primary hover:underline">Try again</button>
        </Card>
      )}

      {tab !== 'overview' && tab !== 'config' && hydrated && !status.error && !status.isLoading && !enabled && (
        <Card headingLevel={2} title="Extended Sleeve Notes is off" sub="No collection work is running">
          <p className="text-[13px] leading-[1.55] text-muted">Saved stories and connections remain browsable. Collection and Story Spark offers are paused until you enable Sleeve Notes in Settings.</p>
          <Link href="/admin/notes?tab=config" className="mt-3 inline-flex items-center gap-2 text-[13px] font-medium text-primary hover:underline">
            Open Sleeve Notes Settings <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
        </Card>
      )}

      {hydrated && needsReadout && readout.error && (
        <Card headingLevel={2} title="Could not load collection data">
          <p className="text-[13px] text-muted">{readout.error instanceof Error ? readout.error.message : 'The Notes readout is temporarily unavailable.'}</p>
          <button type="button" onClick={() => void readout.refetch()} className="mt-3 text-[13px] font-medium text-primary hover:underline">Try again</button>
        </Card>
      )}
      {hydrated && needsReadout && readout.isLoading && <p className="text-[13px] text-muted">Loading collection data…</p>}

      {tab === 'stories' && storyId && <Card headingLevel={2} title={story.data?.title ?? searchParams.get('storyName') ?? 'Saved story context'}>
        <Link href={storyBack} className="text-xs text-primary">{fromBrain?'Back to Station Brain':'Back to Stories'}</Link>
        {story.error && <p role="alert" className="mt-3 text-[13px]">{story.error instanceof Error ? story.error.message : 'Could not load saved stories'}</p>}
        {story.isLoading && <p role="status" className="mt-3 text-[13px]">Loading saved facts…</p>}
        {story.data && !story.data.claims.length && <p className="mt-3 text-[13px] text-muted">No saved stories yet for this artist, album or track.</p>}
        <div className="mt-3 space-y-3">{story.data?.claims.map((claim) => <ClaimCard key={`${claim.id}:${claim.wording}`} claim={claim} adminFetch={adminFetch} readOnly={!enabled} />)}</div>
      </Card>}
      {tab === 'stories' && !storyId && <Seg aria-label="Stories sections" value={storiesMode} options={[{id:'all',label:'All saved facts'},{ id: 'recent', label: 'Recent facts' }, { id: 'browse', label: 'Browse library' }, {id:'withdrawn',label:'Withdrawn facts'}, {id:'details',label:'Research details'}]} onChange={value=>{setStoriesMode(value);setStoryOffset(0);const params=new URLSearchParams(searchParams.toString());params.set('tab','stories');params.set('storiesView',value);router.replace(`${pathname??'/admin/notes'}?${params}`,{scroll:false});}} />}
      {tab==='stories'&&!storyId&&fromBrain&&<Link href={storyBack} className="text-xs text-primary">Back to Station Brain</Link>}
      {tab==='stories'&&!['browse','details'].includes(storiesMode)&&collection.error&&<p role="alert">Could not load saved facts. Please try again.</p>}
      {tab==='stories'&&collection.isLoading&&!['browse','details'].includes(storiesMode)&&!storyId&&<p role="status">Loading saved facts…</p>}
      {hydrated && collection.data && tab === 'stories' && !storyId && !['browse','details'].includes(storiesMode) && (
        <ResearchView
          adminFetch={adminFetch}
          readOnly={!enabled}
          total={collection.data.total}
          recent={storiesMode==='recent'}
          withdrawn={storiesMode==='withdrawn'}
          search={search}
          onSearch={value=>{setSearch(value);setStoryOffset(0);}}
          category={category}
          onCategory={value=>{setCategory(value);setStoryOffset(0);}}
          categories={collection.data.categories}
          claims={collection.data.claims}
          offset={storyOffset}
          fetching={collection.isFetching || search !== debouncedSearch}
          onOffset={setStoryOffset}
        />
      )}
      {hydrated && tab === 'stories' && !storyId && storiesMode === 'details' && data && status.data && <ResearchDetailsView data={data} status={status.data} />}
      {hydrated && tab === 'moderation' && <AiringReviews adminFetch={adminFetch} timezone={status.data?.timezone} />}
      {hydrated && tab === 'heard' && <HeardOnAir adminFetch={adminFetch} timezone={status.data?.timezone} />}
      {hydrated && tab === 'stories' && !storyId && storiesMode === 'browse' && <ExploreView adminFetch={adminFetch} hydrated={hydrated} readOnly={!enabled} />}
      {tab==='connections'&&<Seg aria-label="Station Brain sections" value={brainView} options={[{id:'map',label:'Map'},{id:'discoveries',label:'Stats & Discoveries'}]} onChange={value=>{const params=new URLSearchParams(searchParams.toString());params.set('brainView',value);router.replace(`${pathname??'/admin/notes'}?${params}`,{scroll:false});}} />}
      {hydrated&&tab==='connections'&&<GeniusCaptureNotice state={status.data ? {enabled:status.data.providerEnabled,configured:status.data.providerConfigured} : undefined} />}
      {hydrated&&tab==='connections'&&brainView==='discoveries'&&<ExternalDiscoveries adminFetch={adminFetch} timezone={status.data?.timezone} genius={status.data ? {enabled:status.data.providerEnabled,configured:status.data.providerConfigured} : undefined}/>}
      {hydrated && tab === 'connections' && brainView==='map' && <ConnectionsVisualizer adminFetch={adminFetch} hydrated={hydrated} readOnly={!enabled} timezone={status.data?.timezone} />}

    </div>
  );
}

export function OverviewView({
  enabled, status, statusLoading, statusError, readout, onRetryStatus, adminFetch,
}: {
  adminFetch: AdminFetch;
  enabled: boolean;
  status: NotesStatus | undefined;
  statusLoading: boolean;
  statusError: boolean;
  readout: NotesReadout | undefined;
  onRetryStatus: () => void;
}) {
  if (statusLoading && !statusError) {
    return <Card headingLevel={2} title="Checking Extended Sleeve Notes"><p className="text-[13px] text-muted">Reading the station-wide setting…</p></Card>;
  }
  if (statusError || !status) {
    return (
      <Card headingLevel={2} title="Collection status unavailable">
        <p className="text-[13px] leading-[1.55] text-muted">The station’s Extended Sleeve Notes setting could not be read. Retry before assuming collection is on or off.</p>
        <button type="button" onClick={onRetryStatus} className="mt-3 text-[13px] font-medium text-primary hover:underline">Try again</button>
      </Card>
    );
  }
  return <div className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
      <div><p className="text-sm font-medium">{enabled && !status.collectionPaused && !readout?.researchPausedByBudget ? 'Research enabled' : 'Research paused'}</p>
        <p className="mt-1 text-xs text-muted">{enabled && status.collectionPaused ? 'Collection is paused. Saved Sparks remain available to the DJ.' : enabled && readout?.researchPausedByBudget ? 'Paused by the station token budget. Saved jobs will resume when allowance is available.' : enabled ? 'Research runs when broadcast activity allows.' : 'Saved stories remain available to browse.'}</p></div>
      <div className="flex flex-wrap items-end gap-5 text-sm">
        <div>
          <p className="mb-1 text-xs text-muted">Saved knowledge</p>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <Link href="/admin/notes?tab=stories&category=stories-only" title="Saved anecdotes and background about the music. Track relevance and cooldowns determine what the DJ can use now.">{readout?.storyClaims?.toLocaleString() ?? '—'} Stories</Link>
            <Link href="/admin/notes?tab=connections" title="Unique sample and cover relationships between recordings matched to your current library. Each relationship is counted once, including when saved from both directions.">{readout?.libraryConnections?.toLocaleString() ?? '—'} Library connections</Link>
            <Link href="/admin/notes?tab=connections" title="Saved writer, producer and performer details. Credits provide context and are not standalone DJ stories.">{readout?.creditClaims?.toLocaleString() ?? '—'} Credits</Link>
          </div>
        </div>
        <Link href="/admin/notes?tab=moderation">{status.reviewReady?.toLocaleString() ?? '—'} ready for Review</Link>
      </div>
      <Link href="/admin/notes?tab=config" className="inline-flex items-center gap-2 text-xs text-primary">Research settings <ArrowRight className="size-4" /></Link>
    </div>
    <NotesLiveSummary adminFetch={adminFetch} enabled={enabled}>
      <NotesRecentlyAired adminFetch={adminFetch} timezone={status.timezone} />
      {readout ? <ResearchActivity data={readout} status={status} adminFetch={adminFetch} /> : <Card headingLevel={2} title="Research activity"><p className="text-[13px] text-muted">Loading research queue…</p></Card>}
    </NotesLiveSummary>
    <NotesStorage adminFetch={adminFetch} timezone={status.timezone} />
    {enabled && status.providerEnabled && !status.providerConfigured && <Card headingLevel={2} title="Needs attention">
      <p className="text-[13px] text-muted">Genius connections are enabled but need an access token.</p>
      <Link href="/admin/notes?tab=config" className="mt-2 inline-block text-sm text-primary">Open Settings →</Link>
    </Card>}
    {readout && readout.retainedClaims === 0 && <Card headingLevel={2} title="Get your first story">
      <ol className="list-decimal space-y-2 pl-5 text-[13px]"><li>Enable Sleeve Notes in Settings.</li><li>Optionally add a Genius token for credits and musical connections.</li><li>Play music. Research saves facts over time, then offers a suitable fact to the DJ as a Story Spark.</li></ol>
      <div className="mt-4 border border-border p-3 text-[13px]"><Eyebrow>Illustrative example · not station data</Eyebrow><p className="mt-2">Saved fact: an album was recorded in a converted church.</p><p className="mt-1">Offered Spark: that recording story, when an album track is played.</p><p className="mt-1">DJ line: “This album was recorded in a converted church — here’s another track from it.”</p></div>
    </Card>}
  </div>;
}

export function ResearchQueueActions({id,running,enabled,adminFetch}:{id:string;running:boolean;enabled:boolean;adminFetch:AdminFetch}) {
  const [confirmCancel,setConfirmCancel]=useState(false);
  const action=useAdminMutation<{ok:boolean},'top'|'cancel'>({adminFetch,
    request:(value,fetcher)=>adminJson(fetcher,`/sleeve-notes/queue/${encodeURIComponent(id)}/${value}`,{method:'POST'}),
    onDone:async(_data,value,client)=>{setConfirmCancel(false);notify.ok(value==='top'?'Job prioritised. Eligibility and broadcast checks still apply.':'Queued job cancelled. Saved knowledge is kept.');await client.invalidateQueries({queryKey:['sleeve-notes']});},
  });
  const disabled=!enabled||running||action.isPending;
  return <div className="flex flex-wrap gap-2">
    <Btn sm disabled={disabled} title={running?'Wait for the current step to finish':'Move ahead of eligible work in this worker queue; retry and first-play waits still apply'} onClick={()=>action.mutate('top')}>Send to top</Btn>
    <Btn sm tone="danger" disabled={disabled} title={running?'Wait for the current step to finish':'Cancel queued work without deleting saved knowledge'} onClick={()=>setConfirmCancel(true)}>Cancel job</Btn>
    <V3AlertDialog open={confirmCancel} onOpenChange={setConfirmCancel} title="Cancel this queued job?"
      description={id.startsWith('review:')?'This dismisses the queued review. The saved fact and its availability stay unchanged.':'Saved facts and progress are kept. Automatic collection or a later research request may queue this subject again.'}
      confirmLabel="Cancel job" cancelLabel="Keep queued" danger onConfirm={()=>{if(!disabled)action.mutate('cancel');}}/>
  </div>;
}

export function ResearchActivity({ data, status, adminFetch }: { data: NotesReadout; status: NotesStatus;adminFetch?:AdminFetch }) {
  const [expanded,setExpanded] = useState<Record<string,boolean>>({});
  const jobs = (data.workQueueItems ?? []).filter(job => job.phase !== 'unavailable');
  const geniusEnabled=status.providerEnabled ?? data.geniusQueue?.enabled;
  const geniusConfigured=status.providerConfigured ?? data.geniusQueue?.configured;
  const taskNames: Record<string, string> = {
    match: 'MusicBrainz track match', 'release-context': 'MusicBrainz album details',
    connections: 'Genius track connections', 'album-biography': 'Genius album biography',
    'library-seed': 'Research an unexamined library track', 'sample-traversal': 'Follow a sample connection',
    'expand-samples': 'Find sample connections in saved research', biography: 'Wikipedia artist article',
    'release-group-biography': 'Wikipedia album article', 'extract-wikipedia': 'Extract artist stories',
    'extract-wikipedia-release-group': 'Extract album stories', 'extract-genius-album': 'Extract album stories',
    'review-flagged-speech': 'Review flagged speech',
  };
  const phaseText = (job: NonNullable<NotesReadout['workQueueItems']>[number], detailed = false) => {
    if (job.provider === 'genius') {
      if (geniusEnabled===false) return 'Paused — Genius capture is off';
      if (geniusConfigured===false) return 'Waiting for a Genius API key';
    }
    if (job.phase === 'running') return 'Researching';
    if (job.phase === 'ready') return 'Ready';
    if (job.phase === 'first-play') return 'Needs first play';
    if (job.phase === 'next-play') return 'Waiting for next play';
    if (!job.runAfter) return 'Retry scheduled';
    if (detailed) return `Retry after ${formatNotesDate(job.runAfter,status.timezone)}`;
    if (data.readAt == null) return 'Retry scheduled';
    const minutes = Math.ceil((Date.parse(job.runAfter) - data.readAt) / 60_000);
    return minutes > 0 ? `Retry in ${minutes} min` : 'Retry shortly';
  };
  const genius = data.geniusQueue;
  return <Card headingLevel={2} title="Research activity" right={<NotesHelp text="Research activity status and progress">
      <NotesResearchProgress tooltip progress={data.progress} reason={status.collectionBlockedReason}
        ready={jobs.some(job=>job.phase==='ready' && (job.provider!=='genius' || (geniusEnabled && geniusConfigured)))} now={data.readAt??0} timezone={status.timezone} />
    </NotesHelp>}>
    <div className="divide-y divide-border/60">
      {[{ name: 'Controller Research', llm: false, help: 'Collects source information and finds connections. Genius requests share Subwave’s rolling allowance and yield to broadcast work.' },
        { name: 'LLM Research', llm: true, help: 'Turns collected material into Sparks and reviews flagged speech. It waits behind broadcast and interactive work.' }].map(section => {
        const queue = jobs.filter(job => (job.provider === 'researcher') === section.llm).sort((a,b) =>
          Number(a.provider==='genius' && (geniusEnabled===false || geniusConfigured===false)) - Number(b.provider==='genius' && (geniusEnabled===false || geniusConfigured===false))
          || Number(b.phase === 'running') - Number(a.phase === 'running')
          || Number(b.phase === 'ready') - Number(a.phase === 'ready')
          || (b.promotedAt??'').localeCompare(a.promotedAt??'')
          || Number(b.capability==='review-flagged-speech')-Number(a.capability==='review-flagged-speech') || b.priority - a.priority);
        const current = queue[0];
        const state = !status.enabled ? 'Research is off' : status.collectionPaused ? 'Collection paused'
          : data.researchPausedByBudget ? 'Waiting for station budget'
            : current?.provider === 'genius' && geniusEnabled===false ? 'Paused — Genius capture is off'
              : current?.provider === 'genius' && geniusConfigured===false ? 'Waiting for a Genius API key'
                : current?.phase === 'running' ? 'Researching'
              : current?.phase === 'ready' && genius?.worker?.quiet === false ? 'Yielding to broadcast work'
                : current?.provider === 'genius' && current.phase === 'ready' && current.capability !== 'expand-samples' && genius?.waitReason
                  ? genius.waitReason === 'backoff' ? 'Backing off after an error' : 'Waiting for request allowance'
                  : current ? phaseText(current) : 'Queue clear';
        return <section key={section.name} aria-label={section.name} className="space-y-2 py-3 first:pt-0 last:pb-0">
          <div className="flex items-center justify-between gap-2"><h3 className="text-[13px] font-semibold">{section.name}</h3><NotesHelp text={section.help} /></div>
          <p className="text-xs">{state}<span className="text-muted"> · {queue.filter(job => job.phase !== 'running').length} queued</span></p>
          {!section.llm && genius?.enabled && <p className="text-xs text-muted tabular-nums">Genius: {genius.minuteRequests} / {genius.minuteLimit} requests this minute</p>}
          {current && <div className="min-w-0">
            <p className="truncate text-[13px] font-medium" title={[current.subjectArtist,current.subjectTitle].filter(Boolean).join(' · ')}>{[current.subjectArtist,current.subjectTitle].filter(Boolean).join(' · ')}</p>
            <p className="text-xs text-muted">{taskNames[current.capability] ?? current.capability.replaceAll('-',' ')}</p>
          </div>}
          {queue.length > 0 && <details className="text-xs" onToggle={event => {
            const open = event.currentTarget.open;
            setExpanded(previous => ({...previous,[section.name]:open}));
          }}><summary className="cursor-pointer text-primary">Show queue</summary>
            {expanded[section.name] && <div className="mt-2 divide-y divide-border/60">{queue.map(job => <div key={job.id} className="space-y-1 py-2">
              <p className="font-medium break-words">{[job.subjectArtist,job.subjectTitle].filter(Boolean).join(' · ')}</p>
              <p className="text-muted">{taskNames[job.capability] ?? job.capability.replaceAll('-',' ')} · {phaseText(job,true)}</p>
              {job.promotedAt&&<p className="text-primary">Prioritised · eligibility checks still apply</p>}
              {adminFetch&&<ResearchQueueActions id={job.id} running={job.phase==='running'} enabled={status.enabled} adminFetch={adminFetch}/>}

            </div>)}</div>}
          </details>}
        </section>;
      })}
    </div>
  </Card>;
}

export function ResearchDetailsView({data,status}:{data:NotesReadout;status:NotesStatus}) {
  return <Card headingLevel={2} title="Research details" right={<NotesHelp text="These are collection totals, not the number of stories available for the current track. Credits, cooldowns and track relevance affect what the DJ can use." />}><div className="space-y-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <CompactMetric label="Saved facts" value={data.retainedClaims} />
            <CompactMetric label="Tracks encountered" value={data.localAttachments} />
            {data.geniusQueue && <CompactMetric label="Genius requests · last 24 hours" value={data.geniusQueue.dayLimit == null ? data.geniusQueue.dayRequests.toLocaleString() : `${data.geniusQueue.dayRequests.toLocaleString()} / ${data.geniusQueue.dayLimit.toLocaleString()}`} />}
            {data.wikipediaExtractAverageLatencyMs != null && <CompactMetric label="Average Wiki extraction" value={`${(data.wikipediaExtractAverageLatencyMs / 1000).toFixed(1)}s`} />}
            {data.wikipediaArtistChunkCharacterTarget != null && <CompactMetric label="Artist Wiki chunk" value={`${data.wikipediaArtistChunkCharacterTarget} chars`} />}
            {data.wikipediaAlbumChunkCharacterTarget != null && <CompactMetric label="Album Wiki chunk" value={`${data.wikipediaAlbumChunkCharacterTarget} chars`} />}
          </div>
          <p className="text-xs text-muted">Saved facts include credits and other retained context. Stories for the DJ exclude credits; track relevance, cooldowns and reservations determine what is available now.</p>
          <details><summary className="cursor-pointer text-sm font-medium">Source coverage and curated lists</summary><div className="mt-3"><SourcesView data={data} status={status} /></div></details>
  </div></Card>;
}

function ResearchView({
  total, recent, withdrawn, offset, onOffset, fetching, search, onSearch, category, onCategory, categories, claims, adminFetch, readOnly,
}: {
  fetching:boolean;
  total:number; recent:boolean; withdrawn:boolean; offset:number; onOffset:(value:number)=>void;
  search: string;
  onSearch: (value: string) => void;
  category: string;
  onCategory: (value: string) => void;
  categories: string[];
  claims: NotesReadout['claims'];
  adminFetch: AdminFetch;
  readOnly: boolean;
}) {
  return (
    <div className="space-y-5">
      <Card headingLevel={2} title={category==='library-connections'?'Library connections':withdrawn?'Withdrawn facts':recent?'Recent saved facts':'All saved facts'} right={<NotesHelp text="Saved facts are the source material. The DJ chooses suitable ones as Sparks. Flag asks for a review; withdraw immediately stops DJ use while keeping the fact saved." />} sub={category==='library-connections'?'Unique sample and cover relationships between recordings in your library. Each relationship appears once.':withdrawn?'Saved facts kept off air until you explicitly restore them. Flag any fact for an AI review.':recent?'Search the latest 80 saved facts.':'Search stories, artists, albums and tracks across your saved collection.'}>
        <div className="mb-4 flex flex-col gap-2 sm:flex-row">
          <label className="relative min-w-0 flex-1">
            <span className="sr-only">Search saved facts</span>
            <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
            <Input type="search" maxLength={120} value={search} onChange={(event) => onSearch(event.target.value)} placeholder={recent?'Search recent facts…':'Search all saved facts…'} className="pr-3 pl-9" />
          </label>
          <label className="flex items-center gap-2 text-xs text-muted">
            <span>Category</span>
            <select value={category} onChange={(event) => onCategory(event.target.value)} className="max-w-full border border-border bg-field px-3 py-[9px] text-[13px] text-ink">
              <option value="all">All</option>
              <option value="stories-only">Stories (excluding connections and credits)</option>
              <option value="library-connections">Library connections</option>
              {categories.map((value) => <option key={value} value={value}>{value.replaceAll('-', ' ')}</option>)}
            </select>
          </label>
        </div>
        <div className="space-y-3">
          {claims.length
            ? claims.map((claim, index) => <ClaimCard key={`${claim.id??`${claim.provider}-${claim.topic}-${index}`}:${claim.wording}`} claim={claim} adminFetch={adminFetch} readOnly={readOnly} />)
            : <p className="border border-dashed border-border px-4 py-8 text-center text-[13px] text-muted">{search||category!=='all'?'No facts match those filters.':withdrawn?'No withdrawn facts. Flagging a fact does not withdraw it automatically.':'No facts saved yet. Play music with Sleeve Notes enabled to build your collection.'}</p>}
        </div>
        <div className="mt-4 flex items-center gap-3 text-xs"><span role="status">{fetching?'Updating facts…':total?`${offset+1}–${Math.min(offset+30,total)} of ${total} facts`:'0 facts'}</span>
          <Btn sm title="Show the previous page of saved facts" disabled={!offset} onClick={()=>onOffset(Math.max(0,offset-30))}>Previous</Btn>
          <Btn sm title="Show the next page of saved facts" disabled={offset+30>=total} onClick={()=>onOffset(offset+30)}>Next</Btn>
        </div>
      </Card>
    </div>
  );
}

function entityTypeName(type: ExploreEntity['entityType']): string {
  if (type === 'artist') return 'Artist';
  if (type === 'recording') return 'Track';
  if (type === 'release-group') return 'Album';
  return 'Release';
}

function ExploreView({ adminFetch, hydrated, readOnly }: { adminFetch: (path: string, init?: RequestInit) => Promise<Response>; hydrated: boolean; readOnly: boolean }) {
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [selectedLetter, setSelectedLetter] = useState('');
  const [page, setPage] = useState(0);
  const [selectedArtist, setSelectedArtist] = useState<ExploreEntity | null>(null);
  const [selectedAlbum, setSelectedAlbum] = useState<ExploreEntity | null>(null);
  const [selectedTrack, setSelectedTrack] = useState<ExploreEntity | null>(null);
  const pageSize = 30;
  const offset = page * pageSize;
  const level = selectedAlbum ? 'tracks' : selectedArtist ? 'albums' : 'artists';
  const params = new URLSearchParams({ level, limit: String(pageSize), offset: String(offset), search });
  if (selectedLetter) params.set('letter', selectedLetter);
  if (selectedArtist) params.set('artistId', selectedArtist.entityId);
  if (selectedAlbum) {
    params.set('albumType', selectedAlbum.entityType);
    params.set('albumId', selectedAlbum.entityId);
  }
  const results = useAdminQuery<ExplorePage>({
    key: ['sleeve-notes', 'explore', level, selectedArtist?.entityId, selectedAlbum?.entityType, selectedAlbum?.entityId, search, selectedLetter, page],
    adminFetch,
    enabled: hydrated,
    request: (fetcher, signal) => adminJson(fetcher, `/sleeve-notes/explore?${params.toString()}`, undefined, signal),
    staleTime: 10_000,
  });
  const selected = selectedTrack ?? selectedAlbum ?? selectedArtist;
  const selectedType = selected?.entityType ?? null;
  const selectedId = selected?.entityId ?? null;
  const selectedLabel = selectedTrack ? 'Track' : selectedAlbum ? 'Album' : selectedArtist ? 'Artist' : null;
  const dossier = useAdminQuery<EntityDossier>({
    key: ['sleeve-notes', 'dossier', selectedType, selectedId],
    adminFetch,
    enabled: hydrated && !!selectedType && !!selectedId && (selected?.claimCount ?? 0) > 0,
    request: (fetcher, signal) => {
      if (!selectedType || !selectedId) throw new Error('Choose an artist, album or track to see its saved stories.');
      return adminJson(fetcher,
        `/sleeve-notes/dossier/${encodeURIComponent(selectedType)}/${encodeURIComponent(selectedId)}`,
        undefined,
        signal,
      );
    },
    staleTime: 10_000,
  });
  const totalPages = Math.max(1, Math.ceil((results.data?.total ?? 0) / pageSize));

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSearch(draft.trim());
    setSelectedLetter('');
    setPage(0);
    if (level === 'albums') {
      setSelectedAlbum(null);
      setSelectedTrack(null);
    } else if (level === 'tracks') {
      setSelectedTrack(null);
    }
  }

  function enterArtist(entity: ExploreEntity) {
    setSelectedArtist(entity);
    setSelectedAlbum(null);
    setSelectedTrack(null);
    setSearch('');
    setSelectedLetter('');
    setDraft('');
    setPage(0);
  }

  function enterAlbum(entity: ExploreEntity) {
    setSelectedAlbum(entity);
    setSelectedTrack(null);
    setSearch('');
    setSelectedLetter('');
    setDraft('');
    setPage(0);
  }

  function showArtists() {
    setSelectedArtist(null);
    setSelectedAlbum(null);
    setSelectedTrack(null);
    setSearch('');
    setSelectedLetter('');
    setDraft('');
    setPage(0);
  }

  function showAlbums() {
    setSelectedAlbum(null);
    setSelectedTrack(null);
    setSearch('');
    setSelectedLetter('');
    setDraft('');
    setPage(0);
  }

  function showTracks() {
    setSelectedTrack(null);
    setSearch('');
    setSelectedLetter('');
    setDraft('');
    setPage(0);
  }

  function jumpToLetter(letter: string) {
    setSelectedLetter(letter);
    setSearch('');
    setDraft('');
    setSelectedTrack(null);
    setPage(0);
  }

  const levelTitle = level === 'artists' ? 'Artists' : level === 'albums' ? `Albums by ${selectedArtist?.title ?? 'artist'}` : `Tracks on ${selectedAlbum?.title ?? 'album'}`;
  const listTitle = selectedLetter ? `${levelTitle} · ${selectedLetter}` : levelTitle;
  const searchPlaceholder = level === 'artists' ? 'Search artists…' : level === 'albums' ? 'Search albums…' : 'Search tracks…';
  const emptyText = level === 'artists'
    ? 'Artists with saved stories will appear here.'
    : level === 'albums'
      ? 'No albums with saved stories were found for this artist.'
      : 'No tracks with saved stories were found on this album.';

  return (
    <div className="space-y-5">
      <Card headingLevel={2} title="Browse saved stories" right={<NotesHelp text="Start with an artist, open an album, then select a track. The second panel shows saved facts for your selection. Search stays within the current level." />} sub="browse from artist to album to track">
        <nav aria-label="Explore location" className="mb-4 flex flex-wrap items-center gap-2 text-xs">
          <button type="button" onClick={showArtists} className={!selectedArtist ? 'font-semibold text-ink' : 'text-primary hover:underline'}>Artists</button>
          {selectedArtist && <><span aria-hidden="true" className="text-muted">/</span><button type="button" onClick={showAlbums} className={!selectedAlbum ? 'font-semibold text-ink' : 'text-primary hover:underline'}>{selectedArtist.title}</button></>}
          {selectedAlbum && <><span aria-hidden="true" className="text-muted">/</span><button type="button" onClick={showTracks} className={!selectedTrack ? 'font-semibold text-ink' : 'text-primary hover:underline'}>{selectedAlbum.title}</button></>}
          {selectedTrack && <><span aria-hidden="true" className="text-muted">/</span><span className="font-semibold text-ink">{selectedTrack.title}</span></>}
        </nav>
        <form onSubmit={submitSearch} className="flex flex-col gap-2 sm:flex-row">
          <label className="relative min-w-0 flex-1">
            <span className="sr-only">{searchPlaceholder}</span>
            <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
            <Input type="search" maxLength={120} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={searchPlaceholder} className="pr-3 pl-9" />
          </label>
          <Btn type="submit" title="Search within the artists, albums or tracks shown here">Search</Btn>
        </form>
      </Card>
      {results.error && <Card headingLevel={2} title="Could not load the Notes library"><p className="text-[13px] text-muted">{results.error instanceof Error ? results.error.message : 'The Explore index is temporarily unavailable.'}</p><button type="button" onClick={() => void results.refetch()} className="mt-3 text-[13px] font-medium text-primary hover:underline">Try again</button></Card>}
      {results.isLoading && <p className="text-[13px] text-muted">Loading {level.toLowerCase()}…</p>}
      {!results.error && results.data && (
        <div className="grid items-start gap-5 xl:grid-cols-[minmax(18rem,0.8fr)_minmax(0,1.4fr)]">
          <Card headingLevel={2} title={listTitle} sub={results.data.total ? `${offset + 1}–${Math.min(offset + pageSize, results.data.total)} of ${results.data.total}` : `No ${level} with retained notes${selectedLetter ? ` starting with ${selectedLetter}` : ''}`}>
              <label className="flex items-center gap-2 text-xs xl:hidden">Starting letter
                <select aria-label="Jump to first letter" value={selectedLetter} onChange={event=>jumpToLetter(event.target.value)} className="min-h-11 border border-border bg-field px-3">
                  <option value="">All</option>{EXPLORE_LETTERS.map(letter=><option key={letter} value={letter}>{letter}</option>)}
                </select>
              </label>
            <div className="grid grid-cols-1 gap-2 xl:grid-cols-[minmax(0,1fr)_2rem]">
              <div className="xl:max-h-[36rem] xl:overflow-y-auto xl:pr-2">
                {results.data.entities.length ? (
                  <div className="divide-y divide-border/60">
                    {results.data.entities.map((entity) => (
                      <button
                        key={`${entity.entityType}-${entity.entityId}`}
                        type="button"
                        onClick={() => {
                          if (level === 'artists') enterArtist(entity);
                          else if (level === 'albums') enterAlbum(entity);
                          else setSelectedTrack(entity);
                        }}
                        aria-pressed={selectedType === entity.entityType && selectedId === entity.entityId}
                        className="flex w-full items-center justify-between gap-3 py-3 text-left first:pt-0 last:pb-0 hover:text-primary"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-[13px] font-medium">{entity.title}</span>
                          <span className="block text-[11px] text-muted">{level === 'albums' ? 'Album' : entityTypeName(entity.entityType)}{entity.artist ? ` · ${entity.artist}` : ''} · {entity.localMatch ? 'matched to library' : 'not matched locally'}</span>
                          <span className="block text-[11px] text-muted">{entity.claimCount > 0 ? `${entity.claimCount} saved ${entity.claimCount === 1 ? 'fact' : 'facts'}` : level === 'artists' ? 'Browse albums and tracks' : level === 'albums' ? 'Browse tracks' : 'Saved stories'}</span>
                          {entity.childCount > 0 && <span className="block text-[11px] text-muted">{entity.childCount} {level === 'albums' ? 'tracks with notes' : 'items'}</span>}
                        </span>
                        <ArrowRight className="size-4 shrink-0" aria-hidden="true" />
                      </button>
                    ))}
                  </div>
                ) : <p className="py-5 text-[13px] text-muted">{emptyText}</p>}
              </div>
              <nav aria-label="Jump to first letter" className="hidden max-h-[36rem] flex-col items-stretch gap-1 overflow-y-auto border-l border-border/60 pl-1 xl:flex">
                <button type="button" aria-pressed={!selectedLetter} onClick={() => jumpToLetter('')} className={`min-h-8 min-w-8 px-1 py-1 text-xs font-semibold ${!selectedLetter ? 'bg-ink text-bg' : 'text-muted hover:bg-muted/40 hover:text-ink'}`}>All</button>
                {EXPLORE_LETTERS.map((letter) => (
                  <button key={letter} type="button" aria-pressed={selectedLetter === letter} onClick={() => jumpToLetter(letter)} className={`min-h-8 min-w-8 px-1 py-1 text-xs font-medium ${selectedLetter === letter ? 'bg-ink text-bg' : 'text-muted hover:bg-muted/40 hover:text-ink'}`}>{letter}</button>
                ))}
              </nav>
            </div>
            {results.data.total > pageSize && <div className="mt-4 flex items-center justify-between border-t border-border/60 pt-3">
              <Btn sm disabled={page === 0} onClick={() => setPage((value) => Math.max(0, value - 1))} >Previous</Btn>
              <span className="text-xs text-muted">{offset+1}–{Math.min(offset+pageSize,results.data.total)} of {results.data.total} items</span>
              <Btn sm disabled={page + 1 >= totalPages} onClick={() => setPage((value) => Math.min(totalPages - 1, value + 1))} >Next</Btn>
            </div>}
          </Card>
          <Card headingLevel={2} title={dossier.data?.title ?? selected?.title ?? 'Saved stories'} sub={dossier.data ? `${selectedLabel ?? entityTypeName(dossier.data.entityType)} · ${dossier.data.localMatch ? 'matched to library' : 'not matched locally'}` : selected ? 'saved facts and source evidence' : 'select an artist, album or track'}>
            {selected && <Link href={`/admin/notes?tab=connections&focusType=${encodeURIComponent(selected.entityType)}&focusId=${encodeURIComponent(selected.entityId)}`} className="mb-3 inline-flex items-center gap-2 text-[13px] font-medium text-primary hover:underline">
              View connections <GitBranch className="size-4" aria-hidden="true" />
            </Link>}
            {!selected && <p className="text-[13px] text-muted">Choose an artist to browse its albums, then open a track to read saved facts and their sources.</p>}
            {selected && selected.claimCount === 0 && <p className="text-[13px] leading-[1.55] text-muted">No saved facts are attached directly to this {(selectedLabel ?? entityTypeName(selected.entityType)).toLowerCase()}. {level === 'artists' ? 'Browse its albums and tracks for saved stories.' : level === 'albums' ? 'Browse tracks on this album for saved stories.' : 'No source-backed track notes are available yet.'}</p>}
            {selected && selected.claimCount > 0 && dossier.isLoading && <p className="text-[13px] text-muted">Loading saved stories…</p>}
            {dossier.error && <p className="text-[13px] text-muted">{dossier.error instanceof Error ? dossier.error.message : 'Saved stories are temporarily unavailable.'}</p>}
            {dossier.data && <div className="space-y-3 xl:max-h-[38rem] xl:overflow-y-auto xl:pr-2">
              {dossier.data.claims.length
                ? dossier.data.claims.map((claim, index) => <ClaimCard key={`${claim.id??`${claim.provider}-${claim.topic}-${index}`}:${claim.wording}`} claim={claim} adminFetch={adminFetch} readOnly={readOnly} />)
                : <p className="text-[13px] text-muted">No saved facts are attached to this artist, album or track.</p>}
            </div>}
          </Card>
        </div>
      )}
    </div>
  );
}

function ConfigView({
  status, values, loading, settingsError, busy, message, saveError, onSave, onDiscard,
  wikiRefreshBusy, wikiRefreshMessage, onWikiRefresh,
  adminFetch, hydrated,
}: {
  status: NotesStatus | undefined;
  values: SettingsData['values'] | undefined;
  loading: boolean;
  settingsError: string | null;
  busy: boolean;
  message: string;
  saveError: boolean;
  onDiscard: () => void;
  onSave: (patch: Record<string, unknown>, success: string) => Promise<boolean>;
  wikiRefreshBusy: boolean;
  wikiRefreshMessage: string;
  onWikiRefresh: (mode: 'clear' | 'replace') => void;
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
  hydrated: boolean;
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const form = useZodForm(notesSettingsSchema, notesSettingsDefaults(values, status?.wikipediaDefaultPrompt));
  const draft = form.watch();
  const baseline = form.formState.defaultValues as NotesSettingsForm;
  const dirtyCount = countLeafDiffs(draft, baseline);
  const incoming = JSON.stringify(notesSettingsDefaults(values, status?.wikipediaDefaultPrompt));
  const loaded = useRef<string | null>(null);
  useEffect(() => {
    if (loading || !values || loaded.current === incoming) return;
    loaded.current = incoming;
    if (!form.formState.isDirty) form.reset(JSON.parse(incoming));
  }, [incoming, loading, values, form]);
  const set = <K extends keyof NotesSettingsForm>(key: K, value: NotesSettingsForm[K]) => {
    form.setValue(key, value as never, {shouldDirty: true, shouldValidate: true});
  };
  const {geniusEnabled,researchWhenEmpty,token:tokenDraft,prompt:wikiPromptDraft} = draft;
  const savedInSettings = status?.providerTokenSource === 'settings';
  const prompt = values?.sleeveNotes?.wikipedia?.extractPrompt ?? '';
  const effectivePrompt = wikiPromptDraft.trim() || status?.wikipediaDefaultPrompt || '';
  const save = form.handleSubmit(async submitted => {
    if (await onSave(notesSettingsPatch(submitted, baseline, status?.wikipediaDefaultPrompt), 'Sleeve Notes settings saved.')) {
      form.reset({...submitted, token: '', clearToken: false});
    }
  });
  const previewArtists = useAdminQuery<{ artists: Array<{ id: string; name: string; hasCachedArticle: boolean }> }>({
    key: ['sleeve-notes', 'wikipedia-preview-artists'],
    adminFetch,
    enabled: hydrated && advancedOpen && status?.enabled === true,
    request: (fetcher, signal) => adminJson(fetcher, '/sleeve-notes/wikipedia-preview-artists', undefined, signal),
    staleTime: 30_000,
  });
  const [previewArtistId, setPreviewArtistId] = useState('');
  const previewAlbums = useAdminQuery<{ albums: Array<{ id: string; name: string; hasCachedArticle: boolean }> }>({
    key: ['sleeve-notes', 'wikipedia-preview-albums', previewArtistId],
    adminFetch,
    enabled: hydrated && advancedOpen && status?.enabled === true && Boolean(previewArtistId),
    request: (fetcher, signal) => adminJson(fetcher,
      `/sleeve-notes/wikipedia-preview-albums/${encodeURIComponent(previewArtistId)}`, undefined, signal),
    staleTime: 30_000,
  });
  const [previewAlbumId, setPreviewAlbumId] = useState('');
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [previewOutput, setPreviewOutput] = useState<{
    entityType: 'artist' | 'release-group'; subject: string | null;
    section: string; output: string; elapsedMs: number; inputCharacters: number; wikiNumber: number;
  } | null>(null);

  async function previewWikipediaPrompt() {
    if (!previewArtistId) return;
    setPreviewBusy(true);
    setPreviewError('');
    setPreviewOutput(null);
    try {
      const result = await adminJson<NonNullable<typeof previewOutput>>(
        adminFetch, '/sleeve-notes/wikipedia-prompt-preview', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ entityType: previewAlbumId ? 'release-group' : 'artist',
            entityId: previewAlbumId || previewArtistId, prompt: wikiPromptDraft }),
        },
      );
      setPreviewOutput(result);
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : 'Could not generate a preview.');
    } finally {
      setPreviewBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <NotesSettingsSaveBar count={dirtyCount} section="Sleeve Notes" busy={busy} invalid={loading || !!settingsError || !notesSettingsSchema.safeParse(draft).success} onSave={()=>void save()} onDiscard={()=>{form.reset();setPreviewOutput(null);setPreviewError('');onDiscard();}} />
      {message && (!dirtyCount || saveError) && <p role={saveError?'alert':'status'} className="text-[13px] text-muted">{message}</p>}
      <Card headingLevel={2} title="Feature switch">
        <p className="text-[13px] text-muted">Manage the master switch in Settings → DJ Behaviour. Turning it off hides Sleeve Notes and stops processing while keeping saved research.</p>
        <Link href="/admin/settings?section=behaviour#extended-sleeve-notes" className="mt-3 inline-block text-[13px] text-primary hover:underline">Open DJ Behaviour settings →</Link>
      </Card>
      <Card headingLevel={2} title="Background collection" right={<NotesHelp text="Pause research without stopping the DJ from using stories already saved. Resume it here when you want collection to continue." />} sub="Keep saved Sparks on air while research is paused">
        <Seg aria-label="Background collection" value={draft.collectionPaused?'paused':'running'} disabled={busy||loading||!!settingsError} options={[{id:'running',label:'Collect stories'},{id:'paused',label:'Pause collection'}]} onChange={value=>set('collectionPaused',value==='paused')} />
        <p className="mt-3 text-[13px] text-muted">Pauses background matching, source collection and extraction. Saved jobs are kept for resumption. On-air links and segments retain access to cached Sparks while Sleeve Notes is enabled.</p>
      </Card>
      <SleeveNotesSegmentSettings form={form} personas={values?.personas??[]} busy={busy||loading||!!settingsError} />
            <Card headingLevel={2} title="Genius connections (optional)" right={<NotesHelp text="Genius adds credits and connections between recordings. It needs a Client Access Token; Subwave does not collect lyrics." />} sub={savedInSettings ? 'saved in Settings' : status?.providerConfigured ? 'using a server environment token' : 'not configured'}>
            <div className="field">
              <Label>Genius metadata collection</Label>
              <Seg aria-label="Genius metadata collection" value={geniusEnabled ? 'on' : 'off'} options={[
                { id: 'off', label: 'Off', title: 'Do not queue Genius metadata research' },
                { id: 'on', label: 'On', title: 'Collect Genius recording credits and musical connections when configured' },
              ]} disabled={busy || loading || !!settingsError} onChange={value=>set('geniusEnabled',value==='on')} />
              <p className="mt-2 text-[13px] leading-[1.55] text-muted">Collect structured producer, writer and musical connection metadata only. Lyrics are not fetched or retained. The station-wide master switch must also be on.</p>
            </div>
        <p className="max-w-4xl text-[13px] leading-[1.55] text-muted">Create a Genius API client, then generate its Client Access Token. The saved token is masked and never returned to the browser. Saving one here makes it the station’s Settings-backed token.</p>
        <a href="https://genius.com/api-clients" target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-[13px] font-medium text-primary hover:underline">
          Open Genius API Clients <ExternalLink className="size-3.5" aria-hidden="true" />
        </a>
        <div className="mt-4 max-w-2xl">
          <Label htmlFor="genius-access-token">Genius Client Access Token</Label>
          <Input id="genius-access-token" type="password" autoComplete="new-password" value={tokenDraft} disabled={busy||loading||!!settingsError} onChange={event=>{set('token',event.target.value);set('clearToken',false);}} placeholder={savedInSettings ? 'Saved token is hidden; enter a replacement' : 'Paste Client Access Token'} />
        </div>
        <div className="mt-3 flex flex-wrap gap-2 [&>button]:max-w-full [&>button]:text-left [&>button]:whitespace-normal">
          {savedInSettings && <Btn type="button" disabled={busy || loading || !!settingsError} onClick={()=>{set('token','');set('clearToken',!draft.clearToken);}}>{draft.clearToken?'Keep saved token':'Clear saved token'}</Btn>}
          {draft.clearToken && <p className="text-xs text-muted">The saved token will be cleared when you save.</p>}

        </div>
        {status?.providerTokenSource === 'environment' && <p className="mt-3 text-xs text-muted">A server environment token is currently available. A token saved here takes priority over it.</p>}

      </Card>
      <MusicBrainzLists adminFetch={adminFetch} hydrated={hydrated} />
      <Card headingLevel={2} title="Collection preferences" right={<NotesHelp text="Allow research when the station has no listeners. Broadcast and other higher-priority work still come first." />} sub="Save or discard pending changes above">
        {loading ? <p className="text-[13px] text-muted">Loading Settings…</p> : settingsError ? (
          <p className="text-[13px] text-muted">Could not read saved settings: {settingsError}</p>
        ) : (
          <div className="space-y-5">
            <div className="field">
              <Label>Research while the station is empty</Label>
              <Seg aria-label="Research while the station is empty" value={researchWhenEmpty ? 'on' : 'off'} options={[
                { id: 'off', label: 'Off', title: 'Pause non-airing Sleeve Notes research while the station is empty' },
                { id: 'on', label: 'On', title: 'Allow low-priority backfill while Icecast confirms zero listeners' },
              ]} disabled={busy || loading || !!settingsError} onChange={value=>set('researchWhenEmpty',value==='on')} />
              <p className="mt-2 text-[13px] leading-[1.55] text-muted">This controls background research only. It does not resume DJ speech or picks, and work still yields to higher-priority station tasks.</p>
            </div>
          </div>
        )}
      </Card>
      <details onToggle={(event) => setAdvancedOpen(event.currentTarget.open)} className="border border-border p-3"><summary className="cursor-pointer text-[13px] font-medium">Advanced · research prompt and limits</summary><div className="mt-3"><Card headingLevel={2} title="Wikipedia research prompt" right={<NotesHelp text="These instructions tell the model which facts to save from source articles. Save changes to use them for future research. Preview tests the draft without saving any facts." />} sub={status?.wikipediaPromptIsCustom ? 'custom prompt active' : 'default prompt active'}>
        <p className="mb-3 max-w-4xl text-[13px] leading-[1.55] text-muted">Set the instructions used to choose and rank facts. Use <code>{'{wikiNumber}'}</code> where the prompt should state how many facts this article section may return. The code shares your Artist or Album limit across sections according to their text length; source checks may retain fewer. A refresh uses the saved Wikipedia text.</p>
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <TextField control={form.control} name="artistClaimLimit" label="Facts per artist article" numeric min={1} max={20} step={1} disabled={busy||loading||!!settingsError} />
          <TextField control={form.control} name="albumClaimLimit" label="Facts per album article" numeric min={1} max={20} step={1} disabled={busy||loading||!!settingsError} />
        </div>
        <textarea
          aria-label="Wikipedia research prompt"
          maxLength={8000}
          disabled={busy || loading || !!settingsError}
          value={wikiPromptDraft}
          onChange={(event) => { set('prompt',event.target.value); setPreviewOutput(null); setPreviewError(''); }}
          className="min-h-48 w-full border border-border bg-bg p-3 text-[13px] leading-[1.55]"
          placeholder={status?.wikipediaDefaultPrompt}
        />
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3 text-xs text-muted">
          <span>{wikiPromptDraft.length.toLocaleString('en-GB')} / 8,000 characters · {wikiPromptDraft === (status?.wikipediaDefaultPrompt ?? '') && !prompt ? 'Default prompt is active.' : 'Custom instructions are active after saving.'}</span>
          <div className="flex gap-2">
            <Btn type="button" disabled={busy || loading || !!settingsError || wikiPromptDraft === status?.wikipediaDefaultPrompt} onClick={()=>{set('prompt',status?.wikipediaDefaultPrompt ?? '');setPreviewOutput(null);setPreviewError('');}}>Restore default</Btn>
          </div>
        </div>
        {effectivePrompt && <details className="mt-3"><summary className="cursor-pointer text-xs font-medium">Preview active prompt</summary><pre className="mt-2 bg-muted/20 p-3 text-xs leading-[1.5] whitespace-pre-wrap">{effectivePrompt}</pre></details>}
        <div className="mt-5 border-t border-border/70 pt-4">
          {!status?.enabled && <p className="mb-3 text-xs text-muted">Enable Sleeve Notes before running a prompt test.</p>}
          <Label htmlFor="wikipedia-prompt-preview-artist">Test prompt against an encountered artist or album</Label>
          <p className="mt-1 mb-3 text-xs leading-[1.5] text-muted">Choose an artist, then preview either their artist article or one of their cached album articles. It runs one call on the first article chunk using the prompt currently in the editor; the result is not saved as facts.</p>
          <div className="flex flex-wrap gap-2">
            <select id="wikipedia-prompt-preview-artist" value={previewArtistId}
              onChange={(event) => { setPreviewArtistId(event.target.value); setPreviewAlbumId(''); setPreviewOutput(null); setPreviewError(''); }}
              className="w-full max-w-full min-w-0 border border-border bg-bg px-3 py-2 text-[13px]">
              <option value="">Choose an artist…</option>
              {(previewArtists.data?.artists ?? []).map((artist) => <option key={artist.id} value={artist.id} disabled={!artist.hasCachedArticle}>{artist.name}{artist.hasCachedArticle ? '' : ' · no cached Wikipedia article'}</option>)}
            </select>
            <select aria-label="Choose an artist or album article to preview" value={previewAlbumId}
              disabled={!previewArtistId || previewAlbums.isLoading}
              onChange={(event) => { setPreviewAlbumId(event.target.value); setPreviewOutput(null); setPreviewError(''); }}
              className="w-full max-w-full min-w-0 border border-border bg-bg px-3 py-2 text-[13px]">
              <option value="">Artist article</option>
              {(previewAlbums.data?.albums ?? []).map((album) => <option key={album.id} value={album.id} disabled={!album.hasCachedArticle}>{album.name}{album.hasCachedArticle ? '' : ' · no cached Wikipedia article'}</option>)}
            </select>
            <Btn type="button" disabled={!status?.enabled || previewBusy || !previewArtistId || wikiPromptDraft.length> 8000}
              onClick={() => void previewWikipediaPrompt()}
             >
              {previewBusy ? 'Generating preview…' : 'Preview changes'}
            </Btn>
          </div>
          {previewArtists.error && <p className="mt-2 text-xs text-ink">Could not load encountered artists.</p>}
          {previewAlbums.error && <p className="mt-2 text-xs text-ink">Could not load albums for this artist.</p>}
          {!previewArtists.isLoading && !previewArtists.error && !(previewArtists.data?.artists.length)
            && <p className="mt-2 text-xs text-muted">No artists encountered by Extended Sleeve Notes are available.</p>}
          {previewError && <p role="alert" className="mt-3 text-[13px] text-ink">{previewError}</p>}
          {previewOutput && <div className="mt-4 border border-border p-3">
            <div className="text-xs text-muted">{previewOutput.subject} · {previewOutput.entityType === 'artist' ? 'artist' : 'album'} article · {previewOutput.section} · up to {previewOutput.wikiNumber} facts in this section · {(previewOutput.elapsedMs / 1000).toFixed(1)}s · {previewOutput.inputCharacters.toLocaleString('en-GB')} article characters</div>
            <pre className="mt-3 text-[13px] leading-[1.6] whitespace-pre-wrap">{previewOutput.output || '(The model returned no text.)'}</pre>
          </div>}
        </div>
      </Card>
      </div></details>
      <details className="border border-border p-3"><summary className="cursor-pointer text-[13px] font-medium">Maintenance · refresh saved Wikipedia facts</summary><div className="mt-3"><Card headingLevel={2} title="Refresh Wikipedia facts" right={<NotesHelp text="Keep facts leaves current stories available while replacement research waits for the next play. Disable automatic facts stops using those stories immediately. Manually reviewed facts are kept." />} sub="keeps existing facts and queues each refresh on that artist or album’s next play">
        {!status?.enabled && <p className="mb-3 text-[13px] text-muted">Enable Sleeve Notes to use maintenance actions.</p>}
        <p className="max-w-4xl text-[13px] leading-[1.55] text-muted">Research is extracted from the cached article text. The keep-facts option adds work only as each artist or album is encountered; manually reviewed facts are preserved in both modes.</p>
        <div className="mt-3 flex flex-wrap gap-2 [&>button]:max-w-full [&>button]:text-left [&>button]:whitespace-normal">
          <Btn type="button" disabled={wikiRefreshBusy || !status?.enabled} onClick={() => onWikiRefresh('replace')}>{wikiRefreshBusy ? 'Working…' : 'Keep facts; refresh on next play'}</Btn>
          <Btn type="button" disabled={wikiRefreshBusy || !status?.enabled} onClick={() => onWikiRefresh('clear')}>Disable automatic facts and refresh</Btn>
        </div>
        {wikiRefreshMessage && <p role="status" className="mt-3 text-[13px] text-muted">{wikiRefreshMessage}</p>}
      </Card>

      </div></details>
    </div>
  );
}

function SourcesView({
  data, status,
}: {
  data: NotesReadout;
  status: NotesStatus | undefined;
}) {
  const cachedSeries = data.musicBrainzSeries.filter((series) => series.fetchedAt && !series.lastError).length;
  const totalMembers = data.musicBrainzSeries.reduce((sum, series) => sum + series.members, 0);
  const localClaims = data.musicBrainzSeries.reduce((sum, series) => sum + series.localClaims, 0);
  const geniusCoverage = status?.coverage ?? {};
  const seriesRows = data.musicBrainzSeries.map((series) => {
    const state = seriesState(series);
    const label = series.editionYear ? `${series.name} · ${series.editionYear}` : series.name;
    return (
      <tr key={series.id} className="border-t border-border/60 align-top">
        <td className="px-3 py-2 font-medium">{label}<span className="block text-[10px] text-muted">{series.ranked ? 'Ranked list' : 'Additions list'}</span></td>
        <td className="px-3 py-2">{series.entityType === 'recording' ? 'Track' : 'Album'}</td>
        <td className="px-3 py-2"><Pill tone={state.tone}>{state.label}</Pill>{series.lastError && <span className="mt-1 block max-w-64 text-[10px] text-muted">{series.lastError}</span>}</td>
        <td className="px-3 py-2 tabular-nums">{series.members.toLocaleString('en-GB')}</td>
        <td className="px-3 py-2 tabular-nums">{series.localClaims.toLocaleString('en-GB')}</td>
        <td className="px-3 py-2 tabular-nums" title={`${series.libraryTracks.toLocaleString('en-GB')} local tracks linked`}>{series.libraryAlbums.toLocaleString('en-GB')}</td>
        <td className="px-3 py-2 whitespace-nowrap">{formatNotesDate(series.fetchedAt,status?.timezone)}</td>
      </tr>
    );
  });
  const requestRows = data.providerSummary.map((request) => (
    <tr key={`${request.provider}-${request.capability}-${request.outcome}-${request.status ?? 'none'}`} className="border-t border-border/60">
      <td className="px-3 py-2 font-medium">{providerName(request.provider)}</td>
      <td className="px-3 py-2">{request.capability}</td>
      <td className="px-3 py-2">{request.outcome}{request.status ? ` · ${request.status}` : ''}</td>
      <td className="px-3 py-2 tabular-nums">{request.requests.toLocaleString('en-GB')}</td>
      <td className="px-3 py-2 whitespace-nowrap">{formatNotesDate(request.lastRequestedAt,status?.timezone)}</td>
    </tr>
  ));

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="MusicBrainz lists cached" value={cachedSeries} detail={`of ${data.musicBrainzSeries.length} curated lists`} />
        <Metric label="Series members" value={totalMembers} detail="track and album entries retained" />
        <Metric label="Saved recognition facts" value={localClaims} detail="matched by canonical identity or library scan" />
        <Metric label="Genius items processed" value={geniusCoverage.processed ?? 0} detail={`${geniusCoverage.queued ?? 0} queued · ${geniusCoverage['retry-at'] ?? 0} retrying · ${geniusCoverage.failed ?? 0} failed`} />
      </div>

      <ReadoutTable title="MusicBrainz curated lists" sub="Curated list snapshots and matches in this library" empty="The Series catalogue has not been initialized yet." headings={['List', 'Level', 'Cache', 'Members', 'Local facts', 'Library albums', 'Last refreshed']} rows={seriesRows} />

      <div className="grid items-start gap-5 xl:grid-cols-2">
        <ReadoutTable title="Provider activity" sub="Request outcomes grouped by source" empty="No provider requests have been recorded." headings={['Source', 'Work', 'Outcome', 'Calls', 'Latest']} rows={requestRows} />
      </div>

      <Card headingLevel={2} title="Genius collection" sub={!status?.enabled ? 'collection paused' : status?.providerEnabled ? (status.providerConfigured ? 'provider enabled and configured' : 'server token missing') : 'provider disabled'}>
        <p className="text-[13px] leading-[1.55] text-muted">Genius collection requires both its provider switch and a server-held access token. It stores approved metadata and relationships; lyric text is never collected.</p>
      </Card>

    </div>
  );
}
