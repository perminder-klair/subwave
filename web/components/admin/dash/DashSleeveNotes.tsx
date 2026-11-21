'use client';
import {useEffect,useRef,useState} from 'react';
import Link from 'next/link';
import {Flag} from 'lucide-react';
import {useReducedMotion} from 'motion/react';
import {useLiteMode} from '../../../hooks/useLiteMode';
import {adminJson,useAdminQuery,useAdminMutation,type AdminFetch} from '../../../lib/admin-query';
import {Card} from '../ui';

type Item={id:string;category:string;text:string;sourceUrl:string;entityType:string;entityId:string;review?:{id:string;state:string}|null};
const EMPTY:Item[]=[];
type Shelf={enabled:boolean;trackId:string|null;artistId?:string|null;items:Item[]};
export function shuffled<T>(items:readonly T[]):T[]{
 const result=[...items];
 for(let i=result.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[result[i],result[j]]=[result[j]!,result[i]!];}
 return result;
}
export default function DashSleeveNotes({adminFetch,trackId}:{adminFetch:AdminFetch;trackId:string|null}){
 const shelf=useAdminQuery<Shelf>({key:['sleeve-notes','dash-stories',trackId],adminFetch,
 request:(fetcher,signal)=>adminJson(fetcher,'/sleeve-notes/dash-stories',undefined,signal),staleTime:10_000,refetchInterval:30_000,placeholderData:previous=>previous});
 const [hovered,setHovered]=useState(false),[focused,setFocused]=useState(false);
 if(!shelf.data?.enabled)return null;
 const items=shelf.data.trackId===trackId?shelf.data.items:EMPTY;
 const artistId=shelf.data.trackId===trackId?shelf.data.artistId:null;
 const brainHref=artistId?`/admin/notes?tab=connections&focusType=library-artist&focusId=${encodeURIComponent(artistId)}`:'/admin/notes?tab=connections';
 return <div onMouseEnter={()=>setHovered(true)} onMouseLeave={()=>setHovered(false)} onFocusCapture={()=>setFocused(true)} onBlurCapture={event=>{if(!event.currentTarget.contains(event.relatedTarget))setFocused(false);}}><Card title="Sleeve Notes" right={<Link href={brainHref} title="Open the on-air artist in Station Brain" className="text-xs text-primary hover:underline">Station Brain</Link>}>
  <div className="h-[82px]" title="Rotates automatically. Hover or move keyboard focus inside to pause.">
   {shelf.error?<p role="status" className="text-[11px] text-muted">Sleeve Notes could not be refreshed.</p>
    :shelf.data.trackId!==trackId&&shelf.isFetching?<p role="status" className="text-[11px] text-muted">Loading Sleeve Notes…</p>
    :<Rotation key={trackId??'silent'} items={items} adminFetch={adminFetch} trackId={trackId} paused={hovered||focused}/>}
  </div>
 </Card></div>;
}
function Rotation({items,adminFetch,trackId,paused}:{items:Item[];adminFetch:AdminFetch;trackId:string|null;paused:boolean}){
 const [order,setOrder]=useState<string[]>([]),[index,setIndex]=useState(0);

 const initial=useRef(false);
 useEffect(()=>{
  setOrder(previous=>{
   const retained=previous.filter(id=>items.some(item=>item.id===id));
   const added=shuffled(items.filter(item=>!previous.includes(item.id)).map(item=>item.id));
   if(!initial.current){initial.current=true;return shuffled(items.map(item=>item.id));}
   return [...retained,...added];
  });
 },[items]);
 const item=items.find(item=>item.id===order[index%Math.max(1,order.length)]);
 const reduced=useReducedMotion();const {lite}=useLiteMode();
 const instant=!!reduced||lite||paused;
 const [revealed,setRevealed]=useState(0);
 useEffect(()=>{setRevealed(0);},[item?.id]);
 useEffect(()=>{if(paused)setRevealed(item?.text.length??0);},[paused,item?.text]);
 useEffect(()=>{
  if(instant||!item||revealed>=item.text.length)return;
  const timer=setTimeout(()=>setRevealed(value=>value+3),50);
  return ()=>clearTimeout(timer);
 },[instant,item,revealed]);
 const complete=instant||revealed>=(item?.text.length??0);
 useEffect(()=>{
  if(paused||!complete||order.length<2)return;
  const timer=setTimeout(()=>{
   if(index+1>=order.length){setOrder(previous=>{
    const next=shuffled(previous);
    if(next[0]===item?.id&&next.length>1)[next[0],next[1]]=[next[1]!,next[0]!];
    return next;
   });setIndex(0);}else setIndex(value=>value+1);
  },15_000);
  return ()=>clearTimeout(timer);
 },[paused,complete,index,order.length,item?.id]);
 const flag=useAdminMutation<{id:string;state:string},string>({adminFetch,
 request:(id,fetcher)=>adminJson(fetcher,`/sleeve-notes/claims/${encodeURIComponent(id)}/review`,{method:'POST'}),
 onDone:async(_data,_vars,client)=>{await client.invalidateQueries({queryKey:['sleeve-notes']});}});
 const flagged=!!item?.review||flag.data&&flag.variables===item?.id;
 return <div className="flex h-full flex-col">
  {!item?<p className="text-[11px] text-muted">{items.length?'Loading Sleeve Notes…':trackId?'No Sleeve Notes saved for this track yet.':'No track is currently on air.'}</p>:<>
   <div className="mb-2 flex items-center justify-between gap-2"><span className="text-xs text-muted">{item.category==='credits'?'Credits':item.category==='musical-connections'?'Connection':'Spark'} · {index%order.length+1} / {order.length}</span>
   {!['credits','musical-connections'].includes(item.category)&&<button type="button" disabled={!!flagged||flag.isPending} onClick={()=>flag.mutate(item.id)} title={flagged?'Flagged for review':'Flag this saved Spark for review'} aria-label={flagged?'Flagged for review':'Flag this saved Spark for review'} className="p-1 text-primary disabled:opacity-50"><Flag className="size-4" fill={flagged?'currentColor':'none'}/></button>}</div>
   <div className="min-h-0 flex-1 overflow-y-auto text-[11px] leading-relaxed" tabIndex={0} role="region" aria-label={item.text}>
    <span aria-hidden="true">{instant?item.text:item.text.slice(0,revealed)}{!reduced&&!lite&&<span className="v3-blink text-primary">▌</span>}</span>
   </div>

   {flag.error&&<p role="alert" className="text-xs">Could not flag this Spark. Try again.</p>}
  </>}
 </div>;
}
