'use client';

import { V3AlertDialog } from '../ui/alert-dialog';

import Link from 'next/link';
import NotesHelp from './NotesHelp';
import {formatNotesDate} from './sleeve-notes-view';
import {notify} from '../../lib/notify';
import { useState } from 'react';
import type { z } from 'zod';
import type { airingReviewResultSchema } from '../../lib/schemas.generated';
import { adminJson, useAdminMutation, useAdminQuery, type AdminFetch } from '../../lib/admin-query';
import { Card, Btn, Seg } from './ui';
import {Textarea} from '../ui/textarea';

type Result=z.infer<typeof airingReviewResultSchema>;
type Correction=NonNullable<Result['sparkCorrection']>;
type Review={id:string;state:string;guidanceApproved:number;context:{appliedCorrection?:Correction;kind?:'fact';artist:string|null;title:string|null;airedAt:string|null;speech:unknown;
  sparks:Array<{claimId:string;wording:string;offered?:string;evidence:string;source:string;enabled?:number;operatorState?:string}>};
  result:Result|null;lastError:string|null;createdAt:string};
const LABELS:Record<string,string>={queued:'Queued for review',running:'Reviewing',ready:'Ready for your decision',resolved:'Resolved',dismissed:'Dismissed'};

export default function AiringReviews({adminFetch,timezone}:{adminFetch:AdminFetch;timezone?:string}) {
  const [status,setStatus]=useState('active'),[offset,setOffset]=useState(0);
  const [drafts,setDrafts]=useState<Record<string,Correction>>({});
  const [deleteReview, setDeleteReview] = useState<string|null>(null);
  const shelf=useAdminQuery<{items:Review[];total:number;readOnly:boolean}>({
    key:['sleeve-notes','airing-reviews',status,offset],adminFetch,
    request:(fetcher,signal)=>adminJson(fetcher,`/sleeve-notes/airing-reviews?status=${status}&offset=${offset}`,undefined,signal),
    staleTime:5000,refetchInterval:15000,
  });
  const decide=useAdminMutation<unknown,{id:string;action:string;correction?:Correction}>({
    adminFetch,request:({id,action,correction},fetcher)=>adminJson(fetcher,`/sleeve-notes/airing-reviews/${encodeURIComponent(id)}/decision`,{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,correction}),
    }),onDone:async(_data,vars,client)=>{notify.ok(vars.action==='withdraw-fact'?'Fact withdrawn from DJ use.':vars.action==='revoke-guidance'?'Approved guidance removed.':'Review decision saved.');setDrafts(current=>{const next={...current};delete next[vars.id];return next;});await client.invalidateQueries({queryKey:['sleeve-notes']});},
  });
  return <Card headingLevel={2} title="Flagged reviews" right={<NotesHelp text="Flagging asks the model to investigate. Keep leaves the fact unchanged; dismiss sets the finding aside. Apply saves the proposal you approve. Withdrawal stops DJ use without deleting the fact." />} sub="Saved facts, aired DJ links and Sleeve Notes segments">
    <p className="mb-3 text-[13px] text-muted">Reviews wait behind ready research jobs and use the same quiet-time checks and token budget. Flagging leaves availability unchanged. Withdrawn facts stay off air until you explicitly restore them. Suggestions change nothing until you approve them.</p>
    <div className="flex flex-wrap items-center gap-3">
    <Seg aria-label="Review status" value={status} options={[{id:'active',label:'Needs review'},{id:'resolved',label:'Resolved'},{id:'dismissed',label:'Dismissed'}]}
      onChange={value=>{setStatus(value);setOffset(0);}} />
    <Link href="/admin/notes?tab=stories&storiesView=withdrawn" className="ml-auto shrink-0 text-xs text-primary hover:underline">Manage withdrawn facts</Link>
    </div>
    {shelf.isLoading&&<p role="status" className="mt-3 text-sm">Loading reviews…</p>}
    {shelf.error&&<p role="alert" className="mt-3 text-sm">{shelf.error.message}</p>}
    {shelf.data?.items.length===0&&<p className="mt-3 text-sm text-muted">No {status==='active'?'pending':status} reviews. Flag a fact in Stories or an exchange in Heard on Air to request one.</p>}
    <div className="mt-4 space-y-4">{shelf.data?.items.map(item=>{
      const pending=decide.isPending&&decide.variables?.id===item.id;
      const action=decide.variables?.id===item.id?decide.variables.action:null;
      const fact=item.context.kind==='fact',spark=item.context.sparks[0];
      const withdrawn=fact&&spark?.enabled===0&&spark.operatorState!=='deleted';
      const correction=item.result?.sparkCorrection??item.context.appliedCorrection;
      const draft=correction?(drafts[item.id]?.claimId===correction.claimId?drafts[item.id]:correction):drafts[item.id];
      const original=item.context.sparks.find(spark=>spark.claimId===draft?.claimId);
      const changed=!!draft&&(!original||draft.wording.trim()!==original.wording.trim()||draft.evidence.trim()!==original.evidence.trim());
      return <article key={item.id} className="min-w-0 space-y-3 border border-border p-3">
      <div className="flex flex-wrap justify-between gap-2"><h3 className="text-sm font-semibold">{fact?[item.context.artist,item.context.title].filter(Boolean).join(' · ')||'Saved fact':`${item.context.artist||'Unknown artist'} · ${item.context.title||'Saved track'}`}</h3>
        <span className="text-xs text-muted" title={item.state==='queued'?'Waiting for a quiet moment after research work.':item.state==='ready'?'The model has finished. Read its suggestions and choose what to keep or change.':undefined}>{LABELS[item.state]}</span></div>
      <p className="text-xs text-muted">{fact?`Saved fact · flagged ${formatNotesDate(item.createdAt,timezone)}`:`Aired ${formatNotesDate(item.context.airedAt,timezone)}`}</p>
      {fact&&<p className="text-xs text-muted">{spark?.operatorState==='deleted'?'Deleted · kept off air':withdrawn?'Withdrawn from DJ use':'Available for DJ selection'}</p>}
      {fact&&spark?.enabled===1&&!shelf.data?.readOnly&&<Btn sm disabled={decide.isPending} onClick={()=>decide.mutate({id:item.id,action:'withdraw-fact'})}>Withdraw from DJ use</Btn>}
      <details className="text-[13px]"><summary className="cursor-pointer">{fact?'Saved fact and source':'Aired speech and offered Sparks'}</summary>
        {!fact&&<><p className="mt-3 font-medium">Aired speech</p>
        <pre className="mt-2 font-sans break-words whitespace-pre-wrap">{Array.isArray(item.context.speech)?item.context.speech.map(line=>typeof line==='string'?line:
          `${(line as {speakerName?:string}).speakerName??'DJ'}: ${(line as {text?:string}).text??''}`).join('\n\n'):''}</pre></>}
        {item.context.sparks.map(spark=><div key={spark.claimId} className="mt-3 border-t border-border/60 pt-2"><p className="font-medium">{fact?'Saved fact':'Offered Spark'}</p><p className="mt-1">{spark.offered??spark.wording}</p>
          <p className="mt-3 font-medium">Source passage</p><p className="mt-1 text-xs text-muted">{spark.evidence}</p><a href={spark.source} target="_blank" rel="noreferrer" className="text-xs text-primary">Source ↗</a></div>)}
      </details>
      {item.lastError&&item.state==='queued'&&<p className="text-xs text-muted">Waiting to retry: {item.lastError}</p>}
      {item.state==='dismissed'&&!shelf.data?.readOnly&&<Btn sm disabled={decide.isPending}
        onClick={()=>decide.mutate({id:item.id,action:'retry'})}>Retry review</Btn>}
      {item.result&&<>
        <p className="text-[13px] font-medium">{item.result.summary}</p><p className="text-[13px] whitespace-pre-wrap">{item.result.explanation}</p>
        {!!item.result.suggestedSpeech&&<details className="text-[13px]"><summary className="cursor-pointer">Suggested speech · draft only</summary><p className="mt-2 whitespace-pre-wrap">{item.result.suggestedSpeech}</p></details>}
        {item.result.proposedGuidance&&<div className="border border-border/60 p-3 text-[13px]"><p className="font-medium">Proposed generation guidance</p><p className="mt-1">{item.result.proposedGuidance}</p>
          <p className="mt-2 text-xs text-muted">The latest five approved guidance notes inform future Sleeve Notes links, segments and reviews. Station House Rules are unchanged; approved guidance can be removed in Resolved.</p></div>}
        {!correction&&!draft&&item.state==='ready'&&!shelf.data?.readOnly&&<div className="space-y-2 text-[13px]">
          <p className="text-muted">No replacement wording was suggested. You can edit a saved fact and its supporting passage yourself.</p>
          <div className="flex flex-wrap gap-2">{item.context.sparks.filter(spark=>spark.operatorState!=='deleted').map((spark,index)=><Btn key={spark.claimId} sm disabled={decide.isPending}
            onClick={()=>setDrafts(current=>({...current,[item.id]:{claimId:spark.claimId,wording:spark.wording,evidence:spark.evidence}}))}>
            {item.context.sparks.length===1?'Edit saved fact':`Edit Spark ${index+1}`}
          </Btn>)}</div>
        </div>}
        {draft&&<div className="space-y-3 border border-border/60 p-3 text-[13px]">
          <p className="flex items-center gap-1 font-medium"><NotesHelp text="Edit the wording and its supporting passage before applying. The passage must be an exact excerpt from the saved source; applying saves your edited version." />{item.context.appliedCorrection?'Saved Spark correction':correction?'Proposed Spark correction':'Manual fact correction'}</p>
          {item.state==='ready'&&!shelf.data?.readOnly?<>
            <label className="block space-y-1"><span>Wording</span><Textarea value={draft.wording} rows={3} maxLength={360} disabled={decide.isPending}
              onChange={event=>setDrafts(current=>({...current,[item.id]:{...draft,wording:event.target.value}}))}/></label>
            <label className="block space-y-1"><span>Supporting passage</span><Textarea value={draft.evidence} rows={4} maxLength={900} disabled={decide.isPending}
              onChange={event=>setDrafts(current=>({...current,[item.id]:{...draft,evidence:event.target.value}}))}/></label>
            {!correction&&<Btn sm disabled={decide.isPending} onClick={()=>setDrafts(current=>{const next={...current};delete next[item.id];return next;})}>Cancel edit</Btn>}
            <p className="text-xs text-muted">Edit before applying. Wording must be a complete sentence (8–360 characters); the supporting passage must be an exact excerpt from the saved source (24–900 characters).</p>
          </>:<><p>{item.context.appliedCorrection?.wording??draft.wording}</p>
            <p className="text-xs text-muted">Supporting passage: {item.context.appliedCorrection?.evidence??draft.evidence}</p></>}
        </div>}
        {!!item.guidanceApproved&&!shelf.data?.readOnly&&<Btn sm disabled={decide.isPending} onClick={()=>decide.mutate({id:item.id,action:'revoke-guidance'})}>Remove approved guidance</Btn>}
        {item.state==='ready'&&!shelf.data?.readOnly&&<div className="flex flex-wrap gap-2 [&>button]:max-w-full [&>button]:text-left [&>button]:whitespace-normal">
          <Btn sm title="Keep the current fact and close this review. Withdrawn facts stay withdrawn." disabled={decide.isPending} onClick={()=>decide.mutate({id:item.id,action:'resolve'})}>{fact?(withdrawn?'Keep withdrawn and resolve':'Keep fact and resolve'):'Keep Sparks and resolve'}</Btn>
          <Btn sm title="Set this finding aside without changing the fact, guidance or availability." disabled={decide.isPending} onClick={()=>decide.mutate({id:item.id,action:'dismiss'})}>Dismiss finding</Btn>
          {withdrawn&&<Btn sm title="Make this unchanged fact available to the DJ again and close the review." disabled={decide.isPending} onClick={()=>decide.mutate({id:item.id,action:'restore-fact'})}>Restore unchanged and resolve</Btn>}
          {fact&&spark?.operatorState!=='deleted'&&<Btn sm tone="danger" title="Delete this fact from future DJ use and close the review. Airing history is kept." disabled={decide.isPending} onClick={()=>setDeleteReview(item.id)}>Delete fact and resolve</Btn>}
          {item.result.proposedGuidance&&<Btn sm tone="solid" title="Save this advice for future Sleeve Notes speech and reviews, then close this review." disabled={decide.isPending} onClick={()=>decide.mutate({id:item.id,action:'apply-guidance'})}>Apply guidance and resolve</Btn>}
          {draft&&<Btn sm tone="solid" title="Save the wording and supporting passage shown above, make the fact available to the DJ and close the review." disabled={decide.isPending||!changed} onClick={()=>decide.mutate({id:item.id,action:'apply-correction',correction:draft??undefined})}>{withdrawn?'Correct and restore':fact?'Save correction and resolve':'Apply Spark correction and resolve'}</Btn>}
        </div>}
      </>}
      {pending&&<p role="status" className="text-[13px] text-muted">{action==='apply-correction'?'Applying your Spark correction…':action==='apply-guidance'?'Saving guidance…':action==='delete-fact'?'Deleting fact…':'Saving your decision…'}</p>}
      {decide.variables?.id===item.id&&decide.error&&<p role="alert" className="text-[13px] text-vermilion">{decide.error.message}</p>}
    </article>;})}</div>
    {shelf.data&&<div className="mt-4 flex flex-wrap items-center gap-3 text-xs"><span>{shelf.data.total?`${offset+1}–${Math.min(offset+20,shelf.data.total)} of ${shelf.data.total} reviews`:'0 reviews'}</span>
      <Btn sm disabled={!offset} onClick={()=>setOffset(Math.max(0,offset-20))}>Previous</Btn>
      <Btn sm disabled={offset+20>=shelf.data.total} onClick={()=>setOffset(offset+20)}>Next</Btn></div>}
    <V3AlertDialog open={!!deleteReview && !shelf.data?.readOnly} onOpenChange={open=>{if(!open) setDeleteReview(null);}}
      title="Delete fact and resolve review?" description="The fact will no longer be available to the DJ and its review will be resolved. Saved airing history is kept."
      confirmLabel="Delete fact and resolve" cancelLabel="Cancel" danger
      onConfirm={()=>{if(deleteReview && !decide.isPending && !shelf.data?.readOnly) decide.mutate({id:deleteReview,action:'delete-fact'});}} />
  </Card>;
}
