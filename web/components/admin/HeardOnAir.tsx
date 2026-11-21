'use client';

import Link from 'next/link';
import { useDebounceValue } from 'usehooks-ts';
import NotesHelp from './NotesHelp';
import { Input } from '../ui/input';
import {Flag} from 'lucide-react';
import {formatNotesDate,groupAiredStories} from './sleeve-notes-view';
import { useState } from 'react';
import { Card, Btn } from './ui';
import { adminJson, useAdminMutation, useAdminQuery, type AdminFetch } from '../../lib/admin-query';

type AiredStory = {
  id: string; segmentId?: string|null; consumer?: string; claimId: string; localTrackId: string | null; entityType: string; entityId: string;
  airedAt: string; artist: string | null; title: string | null; offeredWording: string;
  spokenText: string; currentWording: string; wordingAtOffer: string; enabled: number; operatorState: string; sourceUrl: string; attribution: string; provider: string;
  story: string | null; delivery: string | null; note: string | null; feedbackAt: string | null;
  sparkDetected: number; review?: {id:string;state:string}|null;
  conversation?: {id:string;expectedLines:number|null;complete:boolean|null;
    lines:Array<{lineIndex:number;speakerId:string;speakerName:string;text:string;airedAt:string}>} | null;
};
type Shelf = { items: AiredStory[]; total: number; conversationTotal?: number; limit: number; offset: number; readOnly: boolean;
  feedbackTotals: { story: Array<{ value: string; count: number }>; delivery: Array<{ value: string; count: number }> } };
const STORY_LABELS: Record<string, string> = {
  good: 'Good story', routine: 'Too routine', unclear: 'Unclear wording', incorrect: 'Factually wrong', 'wrong-subject': 'Wrong story scope',
};
const DELIVERY_LABELS: Record<string, string> = { worked: 'Worked well', forced: 'Felt forced', 'wrong-subject': 'Wrong subject in speech' };

export default function HeardOnAir({ adminFetch, timezone }: { adminFetch: AdminFetch; timezone?: string }) {
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState(''), [kind, setKind] = useState(''), [period, setPeriod] = useState(''), [usage, setUsage] = useState('sleeve-notes');
  const [debouncedSearch] = useDebounceValue(search,250);
  const filtered = !!(search.trim() || kind || period || usage !== 'sleeve-notes');
  const shelf = useAdminQuery<Shelf>({
    key: ['sleeve-notes', 'heard-on-air', offset, debouncedSearch, kind, period, usage], adminFetch,
    request: (fetcher, signal) => adminJson(fetcher, `/sleeve-notes/heard-on-air?${new URLSearchParams({offset: String(offset), search:debouncedSearch, kind, period, usage})}`, undefined, signal),
    staleTime: 10_000, refetchInterval: 30_000, placeholderData: previous => previous,
  });
  const groups=groupAiredStories(shelf.data?.items??[]);
  return <div className="space-y-4">
    <Card headingLevel={2} title="Heard on air" right={<NotesHelp text="Shows every confirmed Sleeve Notes segment and links with detected Spark use by default. Spark-use detection can miss paraphrases; All aired exchanges includes those links too." />} sub="Confirmed DJ links and Sleeve Notes segments with offered Sparks">
      <p className="text-[13px] text-muted">Revisit the words spoken and their offered Sparks. Flag an exchange for a background review; the model investigates and proposes a resolution for you to approve.</p>
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label className="min-w-0 flex-1 basis-64 text-xs">Search
          <Input type="search" value={search} maxLength={120} placeholder="Artist, track, speech or Spark"
            onChange={event=>{setSearch(event.target.value);setOffset(0);}}
            className="mt-1" />
        </label>
        <label className="text-xs">Exchange type
          <select value={kind} onChange={event=>{setKind(event.target.value);setOffset(0);}}
            className="mt-1 block max-w-full border border-border bg-field px-3 py-[9px] text-[13px] text-ink">
            <option value="">All exchanges</option><option value="link">DJ links</option><option value="segment">Sleeve Notes segments</option>
          </select>
        </label>
        <label className="text-xs">Show
          <select value={usage} onChange={event=>{setUsage(event.target.value);setOffset(0);}}
            className="mt-1 block max-w-full border border-border bg-field px-3 py-[9px] text-[13px] text-ink">
            <option value="sleeve-notes">Segments and used Sparks</option><option value="detected">Use detected</option><option value="not-detected">Use not detected</option><option value="">All aired exchanges</option>
          </select>
        </label>
        <label className="text-xs">Aired
          <select value={period} onChange={event=>{setPeriod(event.target.value);setOffset(0);}}
            className="mt-1 block max-w-full border border-border bg-field px-3 py-[9px] text-[13px] text-ink">
            <option value="">All time</option><option value="24h">Last 24 hours</option><option value="7d">Last 7 days</option><option value="30d">Last 30 days</option>
          </select>
        </label>
        {filtered&&<Btn sm onClick={()=>{setSearch('');setKind('');setPeriod('');setUsage('sleeve-notes');setOffset(0);}}>Reset filters</Btn>}
      </div>
      <p className="mt-2 text-xs text-muted">All confirmed Sleeve Notes segments appear by default. Choose All aired exchanges to also include links without detected Spark use.</p>
      {shelf.data?.readOnly && <p className="mt-2 text-[13px] text-muted">Saved airings remain available. Enable Sleeve Notes in Settings to flag speech for review.</p>}
      {shelf.error && <p role="alert" className="mt-3 text-sm">{shelf.error instanceof Error ? shelf.error.message : 'Could not load aired stories'}</p>}
      {shelf.isLoading && <p role="status" className="mt-3 text-sm">Loading aired stories…</p>}
      {shelf.data && shelf.data.total === 0 && <p className="mt-3 text-sm">{filtered?'No aired exchanges match these filters. Try a broader search or clear the filters.':'No confirmed Sleeve Notes segments or links with detected Spark use yet. Drafts and unconfirmed broadcasts do not appear here.'}</p>}
      {shelf.data && <div className="mt-4 flex flex-wrap items-center gap-3 text-xs">
        <span role="status">{shelf.isFetching||search!==debouncedSearch?'Updating airings…':(shelf.data.conversationTotal??shelf.data.total)?`${offset+1}–${Math.min(offset+20,shelf.data.conversationTotal??shelf.data.total)} of ${shelf.data.conversationTotal??shelf.data.total} aired exchanges`:'0 aired exchanges'}</span>
        <Btn sm onClick={() => setOffset(Math.max(0, offset - 20))} disabled={offset === 0}>Previous</Btn>
        <Btn sm onClick={() => setOffset(offset + 20)} disabled={offset + 20 >= (shelf.data.conversationTotal??shelf.data.total)}>Next</Btn>
      </div>}
    </Card>
    {[...groups.entries()].map(([id,items]) => <Card headingLevel={2} key={id} title={`${items[0]!.artist || 'Unknown artist'} · ${items[0]!.title || 'Saved track'}`} sub={formatNotesDate(items[0]!.airedAt,timezone)}>
      <p className="text-[13px] font-medium">{items[0]!.consumer === 'sleeveNotesSegment' ? 'Sleeve Notes segment' : 'The DJ link'}</p>
      <SpokenConversation item={items[0]!} />
      <FlagAiring item={items[0]!} readOnly={shelf.data!.readOnly} adminFetch={adminFetch} />
      <div className="mt-4 space-y-4">{items.map(item=><AiredStoryCard key={item.id} item={item} />)}</div>
    </Card>)}
    {shelf.data && (shelf.data.feedbackTotals.story.length > 0 || shelf.data.feedbackTotals.delivery.length > 0) && <Card headingLevel={2} title="Feedback so far">
      <div className="grid gap-3 sm:grid-cols-2">{(['story', 'delivery'] as const).map(kind => <div key={kind}>
        <p className="text-sm font-medium">{kind === 'story' ? 'Story quality' : 'DJ delivery'}</p>
        <ul className="mt-2 space-y-1 text-[13px]">{shelf.data.feedbackTotals[kind].map(row => <li key={row.value}>{(kind === 'story' ? STORY_LABELS : DELIVERY_LABELS)[row.value]}: {row.count}</li>)}</ul>
      </div>)}</div>
      <p className="mt-3 text-xs text-muted">These previously saved ratings remain available for reference. They do not automatically change research prompts or story preferences.</p>
    </Card>}
  </div>;
}

function SpokenConversation({item}:{item:AiredStory}) {
  return <>{item.conversation ? <div className="mt-2 space-y-3 border-l-2 border-primary/40 pl-3">
      {item.conversation.lines.map(line=><div key={line.lineIndex}>
        <p className="text-xs font-semibold">{line.speakerName}</p>
        <p className="mt-1 text-[13px] leading-relaxed break-words whitespace-pre-wrap">{line.text}</p>
      </div>)}
      {item.conversation.complete===false && <p className="text-xs text-muted">{item.conversation.lines.length} of {item.conversation.expectedLines} contributions confirmed on air.</p>}
    </div> : <blockquote className="mt-2 border-l-2 border-primary/40 pl-3 text-[13px] leading-relaxed break-words whitespace-pre-wrap">{item.spokenText}</blockquote>}</>;
}

export function FlagAiring({item,readOnly,adminFetch,iconOnly=false}:{item:Pick<AiredStory,'id'|'review'>;readOnly:boolean;adminFetch:AdminFetch;iconOnly?:boolean}) {
  const flag=useAdminMutation<{id:string;state:string},void>({
    adminFetch,
    request:(_vars,fetcher)=>adminJson(fetcher,`/sleeve-notes/heard-on-air/${encodeURIComponent(item.id)}/flag`,{method:'POST'}),
    onDone:async(_data,_vars,client)=>{await client.invalidateQueries({queryKey:['sleeve-notes']});},
  });
  const review=item.review??flag.data;
  const label=review?.state==='queued'?'Queued for review':review?.state==='running'?'Reviewing':review?.state==='ready'?'Ready for your decision':review?'Review completed':null;
  if (iconOnly) return <div className="flex shrink-0 flex-col items-end gap-1">
    <button type="button" aria-label={review?`Flagged for review: ${label}`:'Flag for review'} aria-pressed={!!review}
      title={review?'Flagged for review':readOnly?'Enable Sleeve Notes to flag speech':'Flag for review'}
      disabled={readOnly||flag.isPending||!!review} aria-busy={flag.isPending}
      onClick={()=>flag.mutate()} className="inline-flex size-11 items-center justify-center text-primary hover:bg-[var(--ink-soft)] disabled:cursor-default">
      <Flag size={16} fill={review?'currentColor':'none'} aria-hidden="true" />
    </button>
    {review&&<Link href="/admin/notes?tab=moderation" className="max-w-40 text-right text-xs text-primary hover:underline">{label} →</Link>}
    {flag.error&&<p role="alert" className="max-w-48 text-xs text-muted">{flag.error.message}</p>}
  </div>;
  return <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
    {!readOnly&&!review&&<Btn sm title="Ask the model to review this exchange and its offered Sparks. Nothing changes until you approve a suggestion." disabled={flag.isPending} onClick={()=>flag.mutate()}>{flag.isPending?'Flagging…':'Flag for review'}</Btn>}
    {label&&<Link href="/admin/notes?tab=moderation" className="text-primary hover:underline">{label} →</Link>}
    {flag.error&&<p role="alert">{flag.error.message}</p>}
  </div>;
}

function AiredStoryCard({ item }: { item: AiredStory }) {
  return <details className="border-t border-border pt-3">
    <summary className="cursor-pointer text-xs text-muted">Offered Spark · {item.sparkDetected?'use detected':'use not detected'}</summary>
    <p className="mt-1 text-[13px]">{item.offeredWording}</p>
    <div className="mt-2 text-[13px]">
      {item.currentWording !== (item.wordingAtOffer ?? item.offeredWording) && <p className="mt-2 text-muted">The saved story has since changed: {item.currentWording}</p>}
      <div className="mt-2 flex flex-wrap gap-3 text-primary">
        <a href={item.sourceUrl} target="_blank" rel="noreferrer">{item.attribution || item.provider} ↗</a>
        <Link href={`/admin/notes?tab=stories&storyType=${encodeURIComponent(item.entityType)}&storyId=${encodeURIComponent(item.entityId)}`}>Saved story context</Link>
      </div>
    </div>
    {!item.enabled && <p className="mt-3 text-xs text-muted">This story is currently withdrawn from Sparks. <Link href="/admin/notes?tab=moderation" className="text-primary">Open Review</Link></p>}
    {(item.story||item.delivery||item.note)&&<details className="mt-3 text-xs"><summary className="cursor-pointer">Previously saved feedback</summary>
      {item.story&&<p>Story: {STORY_LABELS[item.story]}</p>}{item.delivery&&<p>Delivery: {DELIVERY_LABELS[item.delivery]}</p>}
      {item.note&&<p className="mt-2 whitespace-pre-wrap text-muted">{item.note}</p>}
    </details>}
  </details>;
}
