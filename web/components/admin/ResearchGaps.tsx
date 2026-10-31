'use client';

import { useMemo, useState } from 'react';
import type { ResearchGapSnapshot, ResearchGapStatus, ResearchVerification } from '../../lib/schemas.generated';
import { adminJson, useAdminMutation, useAdminQuery, type AdminFetch } from '../../lib/admin-query';
import { Input } from '../ui/input';
import { formatNotesDate } from './sleeve-notes-view';
import ResearchArtistSource from './ResearchArtistSource';
import NotesHelp from './NotesHelp';
import { Btn, Card, Seg } from './ui';

export const RESEARCH_GAPS_KEY = ['sleeve-notes','research-gaps'] as const;
const LABELS: Record<ResearchGapStatus,string> = {
  'source-available':'Biography available to research',
  'source-missing':'Source scan found no biography', 'source-error':'Source scan could not finish',
  'source-not-found':'Biography not found', 'partial-coverage':'Recording matches need checking',
  'extraction-failed':'Research incomplete', 'identity-unresolved':'Identity unresolved',
  pending:'Research pending', unexplored:'Not researched yet', covered:'Stories saved', 'related-credit':'Related recording credit', empty:'No active stories', stopped:'Research cancelled',
};
const DETAILS: Record<ResearchGapStatus,string> = {
  'source-available':'The source scan found an article that has not been collected yet. Check that it belongs to this artist, then choose Rescan artist to collect and research it.',
  'source-missing':'The latest external check found no usable English biography through the saved artist match or custom source link. An article may exist without a source link.',
  'source-error':'The source check could not finish after retries. This is a service or request failure, not proof that the artist has no biography.',
  'source-not-found':'The biography lookup could not find a linked English Wikipedia article for this artist. You can supply a biography link you have checked.',
  'partial-coverage':'A biography is saved for only part of this artist’s matched recordings. Check the recording matches before editing a research source.',
  'extraction-failed':'An artist article is saved, but its research failed. Existing facts are kept.',
  'identity-unresolved':'MusicBrainz matching failed for an encountered recording. A confident artist match is needed before biography collection.',
  pending:'Matching, collection or extraction is pending. Work uses the normal broadcast checks and source limits.',
  unexplored:'No completed artist research was found. This is normal for artists the station has not encountered yet.',
  covered:'Narrative facts are saved for this artist, their recordings or their albums. Relevance, holds and cooldowns still determine which Sparks the DJ can use.',
  'related-credit':'Matched recordings use another artist credit. Its research is listed separately; this is not a failed biography lookup for this library name.',
  stopped:'Research was cancelled. Saved articles and facts are kept. Open the artist in Station Brain if you want to request research again.',
  empty:'Research completed, but no active story facts are available. It may have retained none, or saved facts may be withdrawn. This is not automatically a fault.',
};
const attention = (status: ResearchGapStatus) => ['source-not-found','partial-coverage','extraction-failed','identity-unresolved','source-missing','source-error','source-available'].includes(status);

export function useResearchGapsQuery(adminFetch: AdminFetch) {
  return useAdminQuery<ResearchGapSnapshot>({key:RESEARCH_GAPS_KEY,adminFetch,
    request:(fetcher,signal)=>adminJson(fetcher,'/sleeve-notes/research-gaps',undefined,signal),
    staleTime:5*60_000,refetchInterval:5*60_000,
  });
}

export default function ResearchGaps({adminFetch,timezone,readOnly}: {adminFetch: AdminFetch; timezone?: string; readOnly: boolean}) {
  const [filter,setFilter] = useState('attention'), [search,setSearch] = useState(''), [offset,setOffset] = useState(0);
  const shelf = useResearchGapsQuery(adminFetch);
  const verify = useAdminMutation<ResearchGapSnapshot,void>({adminFetch,
    request:(_value,fetcher)=>adminJson(fetcher,'/sleeve-notes/research-gaps/verify',{method:'POST'}),
    onDone:(data,_value,client)=>{client.setQueryData(RESEARCH_GAPS_KEY,data);},
  });
  const scan=useAdminQuery<ResearchVerification>({key:['sleeve-notes','research-source-scan'],adminFetch,
    request:(fetcher,signal)=>adminJson(fetcher,'/sleeve-notes/research-gaps/scan',undefined,signal),
    staleTime:30_000,refetchInterval:30_000,
  });
  const scanAction=useAdminMutation<ResearchVerification,'start'|'cancel'>({adminFetch,
    request:(action,fetcher)=>adminJson(fetcher,'/sleeve-notes/research-gaps/scan',{method:action==='start'?'POST':'DELETE'}),
    onDone:(value,_action,client)=>{client.setQueryData(['sleeve-notes','research-source-scan'],value);},
  });
  const data = shelf.data;
  const filtered = useMemo(()=>data?.items.filter(item=>
    (filter==='all'||filter==='attention'&&attention(item.status)||filter==='pending'&&item.status==='pending'||filter==='unexplored'&&item.status==='unexplored')
    && item.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) ?? [],[data,filter,search]);
  const page = filtered.slice(offset,offset+30);
  const busy = verify.isPending;
  return <Card headingLevel={2} title="Research gaps" right={<NotesHelp text="Checks saved identities, artist biographies and story facts across the cached library index and matched recording credits. Same-name records are compared without merging them. This local check cannot establish whether Wikipedia has an article or confirm a MusicBrainz identity against the source service." />}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <p className="max-w-3xl text-[13px] text-muted">Find incomplete research without watching the logs. Existing biographies and album stories are checked before a gap is shown. Unplayed artists awaiting research are listed separately.</p>
      <Btn sm disabled={readOnly||busy||shelf.isFetching} onClick={()=>verify.mutate()}>{verify.isPending?'Checking saved data…':'Refresh saved coverage'}</Btn>
    </div>
    <p className="mt-3 text-xs text-muted">Saved coverage checks local data. The source scan below checks external links without starting LLM research.</p>
    {readOnly&&<p className="mt-2 text-xs text-muted">Saved research is available to inspect. Enable Extended Sleeve Notes to verify again or queue research.</p>}
    <section aria-label="Library source verification" className="mt-4 space-y-3 border-y border-border py-4">
      <h3 className="text-sm font-semibold">Verify library sources</h3>
      <p className="max-w-3xl text-[13px] text-muted">Checks known artist matches across the cached library, at most one per quiet minute. Artists without a match are left unchecked; request their research through Station Brain first. The scan follows collection pauses and broadcast safeguards. Finding an article does not confirm that it belongs to the right artist.</p>
      <div className="flex flex-wrap gap-3"><Btn sm disabled={readOnly||scanAction.isPending||scan.data?.state==='running'||scan.isLoading||!!scan.error} onClick={()=>scanAction.mutate('start')}>{scanAction.isPending?'Updating scan…':'Scan library sources'}</Btn>
        {scan.data?.state==='running'&&<Btn sm disabled={readOnly||scanAction.isPending} onClick={()=>scanAction.mutate('cancel')}>Cancel source scan</Btn>}</div>
      {scan.data&&scan.data.state!=='idle'&&<p role="status" className="text-xs text-muted">{scan.data.state==='running'?'Scanning':scan.data.state==='cancelled'?'Scan cancelled':'Scan complete'} · {scan.data.checked} of {scan.data.total} source records checked · {scan.data.found} sources found · {scan.data.missing} not found · {scan.data.failed} checks failed · {scan.data.skipped} artist entries without a match to check. Results appear below when saved coverage refreshes.</p>}
      {(scan.error||scanAction.error)&&<p role="alert" className="text-xs text-vermilion">{(scanAction.error??scan.error)?.message}</p>}
    </section>
    {data&&<div className="mt-3 space-y-1 text-xs text-muted" aria-live="polite">
      <p>{data.counts.attention.toLocaleString()} need attention · {data.counts.pending.toLocaleString()} pending · {data.counts.unexplored.toLocaleString()} not researched · {data.counts.covered.toLocaleString()} with stories · {data.counts.empty.toLocaleString()} without active stories · {data.counts.related.toLocaleString()} related credits</p>
      <p>Last local check: {formatNotesDate(data.checkedAt,timezone)} · {data.libraryArtists.toLocaleString()} indexed library artists</p>
      <p>{data.libraryIndexedAt?`Library index updated ${formatNotesDate(data.libraryIndexedAt,timezone)}.`:'The library artist index has not finished populating. Encountered recording credits are still checked.'} Findings refresh every five minutes while this section is open.</p>
    </div>}
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <Seg aria-label="Research coverage filter" value={filter} options={[{id:'attention',label:'Needs attention'},{id:'pending',label:'Pending'},{id:'unexplored',label:'Not researched'},{id:'all',label:'All'}]} onChange={value=>{setFilter(value);setOffset(0);}} />
      <label className="min-w-0 flex-1 sm:max-w-xs"><span className="sr-only">Search research coverage by artist</span><Input value={search} placeholder="Find an artist" onChange={event=>{setSearch(event.target.value);setOffset(0);}} /></label>
    </div>
    {shelf.isLoading&&<p role="status" className="mt-4 text-sm">Checking saved research…</p>}
    {(shelf.error||verify.error)&&<p role="alert" className="mt-3 text-sm text-vermilion">{(verify.error??shelf.error)?.message}</p>}
    {data&&!filtered.length&&<p className="mt-4 text-sm text-muted">{search?'No matching artists in this view.':filter==='attention'?'No gaps needing attention were found in the saved data. This local check does not verify external source links.':'No artists in this view.'}</p>}
    <div className="mt-4 divide-y divide-border">{page.map(item=><article key={item.id} className="space-y-3 py-4 first:pt-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2"><h3 className="text-sm font-semibold">{item.name}</h3><span className="text-xs text-muted">{LABELS[item.status]}</span></div>
      <p className="max-w-4xl text-[13px]">{DETAILS[item.status]}</p>
      <p className="text-xs text-muted">{item.storyCount.toLocaleString()} saved story {item.storyCount===1?'fact':'facts'} from artist, recording and album research. Credits and musical connections are counted separately.</p>
      <ResearchArtistSource artist={item} adminFetch={adminFetch} timezone={timezone} readOnly={readOnly} onSaved={()=>verify.mutateAsync()} />
    </article>)}</div>
    {!!filtered.length&&<div className="mt-4 flex flex-wrap items-center gap-3 text-xs"><span>{Math.min(offset+1,filtered.length)}–{Math.min(offset+30,filtered.length)} of {filtered.length} artists</span><Btn sm disabled={offset===0||busy} onClick={()=>setOffset(Math.max(0,offset-30))}>Previous</Btn><Btn sm disabled={offset+30>=filtered.length||busy} onClick={()=>setOffset(offset+30)}>Next</Btn></div>}
  </Card>;
}
