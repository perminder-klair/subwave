'use client';

import Link from 'next/link';
import {useEffect,useRef,useState} from 'react';
import {adminJson,useAdminQuery,type AdminFetch} from '../../lib/admin-query';
import {Card} from './ui';
import {formatNotesDate,groupAiredStories} from './sleeve-notes-view';
import {FlagAiring} from './HeardOnAir';

type AiredItem={id:string;consumer?:string;segmentId?:string|null;artist:string|null;title:string|null;airedAt:string;spokenText:string;review?:{id:string;state:string}|null;
  conversation?:{id:string;lines:Array<{speakerName:string;text:string}>}|null};

export default function NotesRecentlyAired({adminFetch,timezone}:{adminFetch:AdminFetch;timezone?:string}) {
  const shelf=useAdminQuery<{items:AiredItem[];readOnly?:boolean}>({
    key:['sleeve-notes','heard-on-air',0,'','','','sleeve-notes'],adminFetch,
    request:(fetcher,signal)=>adminJson(fetcher,'/sleeve-notes/heard-on-air?offset=0&usage=sleeve-notes',undefined,signal),
    staleTime:10_000,refetchInterval:15_000,
  });
  const exchanges=[...groupAiredStories(shelf.data?.items??[]).entries()].slice(0,2);
  return <Card headingLevel={2} title="Recently aired" right={<Link href="/admin/notes?tab=heard" className="text-xs text-primary hover:underline">Heard on Air</Link>}>
    {shelf.isLoading&&<p role="status" className="text-[13px] text-muted">Loading recent airings…</p>}
    {shelf.error&&<p role="alert" className="text-[13px] text-muted">Recent airings could not be refreshed. <button type="button" className="text-primary hover:underline" onClick={()=>void shelf.refetch()}>Retry</button></p>}
    {shelf.data&&!exchanges.length&&<p className="text-[13px] text-muted">No confirmed Sleeve Notes segments or links with detected Spark use yet.</p>}
    <div className="divide-y divide-border/60">{exchanges.map(([id,items])=>{
      const item=items[0]!;
      const speech=item.conversation?.lines.map(line=>`${line.speakerName}: ${line.text}`).join('\n\n')
        || [...new Set(items.map(item=>item.spokenText))].join('\n\n');
      return <article key={id} className="py-3 first:pt-0 last:pb-0">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="truncate text-[13px] font-semibold" title={`${item.artist??''} · ${item.title??''}`}>{item.artist||'Unknown artist'} · {item.title||'Saved track'}</h3>
            <p className="mt-1 text-xs text-muted">{`${item.consumer==='sleeveNotesSegment'?'Sleeve Notes segment':'DJ link'} · ${formatNotesDate(item.airedAt,timezone)}`}</p>
          </div>
          <FlagAiring item={item} readOnly={shelf.data?.readOnly===true} adminFetch={adminFetch} iconOnly />
        </div>
        <AiredExcerpt text={speech} />
      </article>;
    })}</div>
  </Card>;
}

function AiredExcerpt({text}:{text:string}) {
  const [expanded,setExpanded]=useState(false),[overflowing,setOverflowing]=useState(false);
  const element=useRef<HTMLParagraphElement>(null);
  useEffect(()=>{
    const node=element.current;
    if (!node||expanded) return;
    const measure=()=>setOverflowing(node.scrollHeight>node.clientHeight);
    measure();
    const observer=new ResizeObserver(measure);observer.observe(node);
    return ()=>observer.disconnect();
  },[text,expanded]);
  return <div className="mt-2">
    <p ref={element} className={`text-[13px] leading-relaxed break-words whitespace-pre-wrap ${expanded?'':'line-clamp-2'}`}>{text}</p>
    {(overflowing||expanded)&&<button type="button" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)} className="mt-1 text-xs font-medium text-primary hover:underline">{expanded?'Read less':'Read more'}</button>}
  </div>;
}
