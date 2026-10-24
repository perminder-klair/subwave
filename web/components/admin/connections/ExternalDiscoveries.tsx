'use client';
import {useState} from 'react';
import Link from 'next/link';
import type { GeniusCaptureState } from './GeniusCaptureNotice';
import {adminJson,useAdminQuery,type AdminFetch} from '../../../lib/admin-query';
import {Card,Btn,Seg} from '../ui';
import {formatNotesDate} from '../sleeve-notes-view';

type Entry={artist:string;references:number;libraryArtists:number;sources:number;users:number;examples:Array<{artist:string;track:string;targetTrack:string;type:string}>};
type Discoveries={allSavedRelationships?:number;calculatedAt:string;externalArtists:number;mostConnected:Entry[];sampleSources:Entry[];sampleUsers:Entry[]};
const labels:Record<string,string>={samples:'samples',sampled_in:'is sampled in',cover_of:'covers',covered_by:'is covered by'};
export default function ExternalDiscoveries({adminFetch,timezone,genius}:{adminFetch:AdminFetch;timezone?:string;genius?:GeniusCaptureState}){
  const [view,setView]=useState('mostConnected');
  const query=useAdminQuery<Discoveries>({key:['sleeve-notes','external-discoveries'],adminFetch,
    request:(fetcher,signal)=>adminJson(fetcher,'/sleeve-notes/connections/discoveries',undefined,signal),
    staleTime:0,refetchOnMount:'always',refetchInterval:false});
  const [refreshing,setRefreshing]=useState(false),[error,setError]=useState('');
  async function refresh(){
    setRefreshing(true);setError('');
    try{
      // admin-query-imperative: explicit-discoveries-refresh
      await adminJson(adminFetch,'/sleeve-notes/connections/discoveries?refresh=1');
      await query.refetch();
    }catch{setError('Could not refresh discoveries. Please try again.');}finally{setRefreshing(false);}
  }
  const entries=query.data?.[view as 'mostConnected'|'sampleSources'|'sampleUsers']??[];
  return <Card headingLevel={2} title="External discoveries" right={<Btn disabled={refreshing||query.isFetching} onClick={()=>void refresh()}>{refreshing?'Refreshing…':'Refresh'}</Btn>}>
    <p className="text-[13px] text-muted">Artists outside your library, connected to music you own. These rankings use saved evidence and make no external requests.</p>
    {query.data&&<p className="mt-2 text-xs text-muted">{query.data.externalArtists.toLocaleString()} external artists · Calculated {formatNotesDate(query.data.calculatedAt,timezone)}</p>}
    {query.data?.allSavedRelationships!==undefined&&<p className="mt-2 text-xs text-muted"><Link className="text-primary hover:underline" href="/admin/notes?tab=stories&category=musical-connections">All saved relationships: {query.data.allSavedRelationships.toLocaleString()}</Link> · Includes recordings outside your library and facts saved from either direction.</p>}
    <div className="my-4"><Seg aria-label="External artist rankings" value={view} onChange={setView} options={[{id:'mostConnected',label:'Most connected'},{id:'sampleSources',label:'Sample sources'},{id:'sampleUsers',label:'Sample users'}]}/></div>
    <p className="mb-3 text-xs text-muted">{view==='mostConnected'?'Ranked by the number of distinct library artists with a saved sample or cover connection.':view==='sampleSources'?'Outside artists whose recordings are sampled by your library artists.':'Outside artists who sample recordings by your library artists.'} Showing up to 20 artists. Names are grouped as supplied by the source.</p>
    {query.isLoading&&<p role="status">Calculating discoveries…</p>}
    {(query.error||error)&&<p role="alert">{error||'Could not load discoveries. Use Refresh to try again.'}</p>}
    {query.data&&!entries.length&&<p className="text-[13px] text-muted">{genius && !genius.enabled ? 'No saved connections for this ranking. Enable Genius capture in Notes Settings to start collecting connections.' : genius && !genius.configured ? 'No saved connections for this ranking. Add a Genius API key in Notes Settings to start collecting connections.' : 'No saved connections match this ranking yet.'}</p>}
    <ol className="divide-y divide-border/60">{entries.map(entry=><li key={entry.artist} className="py-3">
      <div className="flex flex-wrap justify-between gap-2"><h3 className="text-sm font-semibold">{entry.artist}</h3><p className="text-xs text-muted">{view==='mostConnected'?`${entry.libraryArtists.toLocaleString()} library artists · ${entry.references.toLocaleString()} references`:`${(view==='sampleSources'?entry.sources:entry.users).toLocaleString()} sample references`}</p></div>
      <details className="mt-2 text-[13px]"><summary className="cursor-pointer text-primary">Example connections</summary><ul className="mt-2 space-y-2">{entry.examples.filter(example=>view==='mostConnected'||example.type===(view==='sampleSources'?'samples':'sampled_in')).slice(0,3).map((example,index)=><li key={index}><Link className="text-primary hover:underline" href={`/admin/notes?tab=stories&q=${encodeURIComponent(example.artist)}`}>{example.track} · {example.artist}</Link> {labels[example.type]??example.type} {example.targetTrack} · {entry.artist}</li>)}</ul></details>
    </li>)}</ol>
  </Card>;
}
