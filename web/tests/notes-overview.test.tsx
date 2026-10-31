import assert from 'node:assert/strict';
import test from 'node:test';
import {renderToStaticMarkup} from 'react-dom/server';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {BookOpen} from 'lucide-react';
import NotesRecentlyAired from '../components/admin/NotesRecentlyAired';
import NotesLiveSummary from '../components/admin/NotesLiveSummary';
import {SectionTabs} from '../components/admin/SectionTabs';
import ReviewCount from '../components/admin/ReviewCount';
import {Card} from '../components/admin/ui';
import type {ComponentProps} from 'react';
import {OverviewView,ResearchActivity,ResearchDetailsView,ResearchQueueActions} from '../components/admin/NotesPanel';

const fetcher=async()=>{throw new Error('No network in render checks');};

test('Recently aired shows the last two exchanges once with full confirmed speaker turns',()=>{
  const client=new QueryClient();
  const item={id:'one',segmentId:'segment',artist:'Example Band',title:'Recent track',airedAt:'2026-10-17T12:00:00Z',spokenText:'An excerpt.',
    conversation:{id:'segment',lines:[{speakerName:'Host',text:'A confirmed introduction.'},{speakerName:'Guest',text:'A confirmed reply.'}]}};
  client.setQueryData(['sleeve-notes','heard-on-air',0,'','','','sleeve-notes'],{items:[item,{...item,id:'two'},
    {...item,id:'three',segmentId:null,title:'Previous track',conversation:null,review:{id:'review',state:'queued'}},
    {...item,id:'four',segmentId:null,title:'Older track',conversation:null}]});
  const html=renderToStaticMarkup(<QueryClientProvider client={client}><NotesRecentlyAired adminFetch={fetcher}/></QueryClientProvider>);
  assert.equal(html.split('Recent track').length-1,2,'one visible heading and its title attribute');
  assert.match(html,/Previous track/);assert.doesNotMatch(html,/Older track/);
  assert.match(html,/Host: A confirmed introduction/);assert.match(html,/Guest: A confirmed reply/);
  assert.match(html,/line-clamp-2/);assert.match(html,/tab=heard/);assert.doesNotMatch(html,/Offered Spark|Source passage/);
  assert.equal((html.match(/aria-pressed="false"/g)||[]).length,1);
  assert.equal((html.match(/aria-pressed="true"/g)||[]).length,1);
  assert.match(html,/aria-label="Flag for review"/);assert.match(html,/aria-label="Flagged for review: Queued for review"/);
  assert.match(html,/fill="currentColor"/);
  client.clear();
});

test('the Overview uses one responsive grid for all four boxes',()=>{
  const client=new QueryClient();client.setQueryData(['sleeve-notes','live-summary'],{onAir:null,nextUp:null});
  const html=renderToStaticMarkup(<QueryClientProvider client={client}><NotesLiveSummary adminFetch={fetcher} enabled>
    <Card title="Recently aired"/><Card title="Research activity"/>
  </NotesLiveSummary></QueryClientProvider>);
  assert.equal((html.match(/data-card=/g)||[]).length,4);assert.match(html,/md:grid-cols-2/);
  assert.match(html,/Run Segment/);assert.doesNotMatch(html,/Run now/);
  assert.match(html,/Recently aired/);assert.match(html,/Research activity/);client.clear();
});

test('a ready review count uses the theme accent whether its tab is active or inactive',()=>{
  for(const value of ['overview','review']) {
    const html=renderToStaticMarkup(<SectionTabs tabs={[{id:'review',label:'Review',icon:BookOpen,count:2,attention:true}]}
      value={value} onChange={()=>{}} label="Sleeve Notes sections"/>);
    assert.match(html,/A review is ready/);assert.match(html,/02/);assert.match(html,/ready for your input/);
    assert.match(html,/border-primary bg-primary/);assert.match(html,/text-primary-foreground/);
  }
});

test('the shared sidebar and tab badge hides empty counts and labels positive counts',()=>{
  assert.equal(renderToStaticMarkup(<ReviewCount count={0}/>),'');
  const html=renderToStaticMarkup(<ReviewCount count={3}/>);
  assert.match(html,/03/);assert.match(html,/ready for your input/);
  assert.match(html,/bg-primary/);assert.match(html,/text-primary-foreground/);
});


test('Research activity separates controller and LLM queues with one visible job each',()=>{
  const jobs=['First job','Second job','Third job'].map((title,index)=>({id:String(index),subjectTitle:title,subjectArtist:'Artist',
    phase:'ready' as const,provider:index===2?'wikipedia':'researcher',capability:index===2?'biography':'extract-wikipedia',subjectType:'artist',priority:300-index,
    attempts:0,runAfter:null,wikiNextChunk:0,researchNextSection:0}));
  const data={workQueueItems:jobs,retainedClaims:12,localAttachments:2,musicBrainzSeries:[],providerSummary:[]} as unknown as ComponentProps<typeof ResearchActivity>['data'];
  const status={enabled:true} as ComponentProps<typeof ResearchActivity>['status'];
  const html=renderToStaticMarkup(<ResearchActivity data={data} status={status}/>);
  const llm=html.match(/<section aria-label="LLM Research"[\s\S]*?<\/section>/)?.[0]??'';
  const compact=llm.split('<details')[0]??'';
  assert.match(compact,/First job/);assert.doesNotMatch(compact,/Second job|Third job/);
  assert.doesNotMatch(llm,/Second job/);assert.match(llm,/Show queue/);
  assert.match(html,/Controller Research/);assert.match(html,/Third job/);
  assert.doesNotMatch(html,/<details[^>]* open|Background collection|Oldest ready|Track lookups/);
  const details=renderToStaticMarkup(<ResearchDetailsView data={data} status={status}/>);
  assert.match(details,/Saved facts/);assert.match(details,/Tracks encountered/);
});

test('Genius overview keeps minute usage and waiting reason while daily usage lives in Research Details',()=>{
  const queue={minuteRequests:3,minuteLimit:3,dayRequests:598,dayLimit:4320,waitReason:'allowance',retryAt:'2026-10-18T13:01:00Z',
    pending:{encountered:1,albums:0,samples:0},ready:1,readyRequests:1,deferred:0,running:0,oldestReadyAt:null,oldestReadyAgeSeconds:null,
    enabled:true,configured:true,worker:{running:false,quiet:true}};
  const data={geniusQueue:queue,workQueueItems:[{id:'g',provider:'genius',capability:'connections',phase:'ready',priority:110,
    subjectTitle:'Track',subjectArtist:'Artist'}],musicBrainzSeries:[],providerSummary:[]} as unknown as ComponentProps<typeof ResearchActivity>['data'];
  const status={enabled:true,timezone:'Europe/London'} as ComponentProps<typeof ResearchActivity>['status'];
  const render=()=>renderToStaticMarkup(<ResearchActivity data={data} status={status}/>);
  const html=render();assert.match(html,/Genius: 3 \/ 3 requests this minute/);assert.match(html,/Waiting for request allowance/);
  assert.doesNotMatch(html,/24 hours|598|Oldest ready|Sample exploration/);
  queue.worker.quiet=false;assert.match(render(),/Yielding to broadcast work/);
  queue.worker.quiet=true;queue.waitReason='backoff';assert.match(render(),/Backing off after an error/);
  const details=renderToStaticMarkup(<ResearchDetailsView data={data} status={status}/>);
  assert.match(details,/Genius requests · last 24 hours/);assert.match(details,/598/);
  data.geniusQueue!.dayLimit=null;
  const unlimited=renderToStaticMarkup(<ResearchDetailsView data={data} status={status}/>);
  assert.match(unlimited,/598/);assert.doesNotMatch(unlimited,/4,320/);
});


test('live overview links artist, album and track using library identities',()=>{
 const client=new QueryClient();
 const item={track:{id:'song-id',artistId:'artist-id',albumId:'album-id',artist:'Band',title:'Song',album:'Album'},spark:null,djLine:null};
 client.setQueryData(['sleeve-notes','live-summary'],{onAir:item,nextUp:item});
 const html=renderToStaticMarkup(<QueryClientProvider client={client}><NotesLiveSummary adminFetch={fetcher} enabled/></QueryClientProvider>);
 assert.equal((html.match(/title="Open artist in Station Brain"/g)??[]).length,2);
 assert.match(html,/focusType=library-artist&amp;focusId=artist-id/);
 assert.match(html,/focusType=library-album&amp;focusId=album-id/);
 assert.match(html,/brainTrack=song-id/);
 client.clear();
});

test('paused Genius work is explained and does not take the visible slot from runnable Wikipedia work',()=>{
 const status={enabled:true,providerEnabled:false,providerConfigured:true} as ComponentProps<typeof ResearchActivity>['status'];
 const data={workQueueItems:[{id:'g',provider:'genius',capability:'connections',phase:'ready',priority:999,subjectTitle:'Genius track'},
  {id:'w',provider:'wikipedia',capability:'biography',phase:'ready',priority:1,subjectTitle:'Wikipedia artist'}]} as ComponentProps<typeof ResearchActivity>['data'];
 const html=renderToStaticMarkup(<ResearchActivity data={data} status={status}/>);
 assert.match(html,/Wikipedia artist/);assert.doesNotMatch(html,/Genius track/);
 const paused=renderToStaticMarkup(<ResearchActivity data={{...data,workQueueItems:data.workQueueItems?.slice(0,1)}} status={status}/>);
 assert.match(paused,/Paused — Genius capture is off/);
 const missing=renderToStaticMarkup(<ResearchActivity data={{...data,workQueueItems:data.workQueueItems?.slice(0,1)}} status={{...status,providerEnabled:true,providerConfigured:false}}/>);
 assert.match(missing,/Waiting for a Genius API key/);
});


test('Saved knowledge links Stories to its facts and connections and credits to Station Brain',()=>{
 const client=new QueryClient();
 const readout={storyClaims:12,libraryConnections:2,connectionClaims:900,creditClaims:7,musicBrainzSeries:[],providerSummary:[],workQueueItems:[]} as unknown as ComponentProps<typeof OverviewView>['readout'];
 const status={enabled:true,reviewReady:0} as ComponentProps<typeof OverviewView>['status'];
 const html=renderToStaticMarkup(<QueryClientProvider client={client}><OverviewView enabled status={status} statusLoading={false} statusError={false} readout={readout} onRetryStatus={()=>{}} adminFetch={fetcher}/></QueryClientProvider>);
 assert.match(html,/href="\/admin\/notes\?tab=stories&amp;category=stories-only"/);
 assert.equal((html.match(/href="\/admin\/notes\?tab=connections"/g)??[]).length,2);
 assert.doesNotMatch(html,/href="[^"]*category=(?:library-connections|credits)"/);
 assert.match(html,/>2<!-- --> Library connections|>2 Library connections/);
 assert.doesNotMatch(html,/900/);
 assert.match(html,/Each relationship is counted once/);
 client.clear();
});


test('queue actions are absent when Show queue is closed; running jobs cannot be changed',()=>{
 const client=new QueryClient();
 const data={workQueueItems:[{id:'job',provider:'researcher',capability:'extract-wikipedia',phase:'ready',priority:1,subjectTitle:'Artist'}]} as ComponentProps<typeof ResearchActivity>['data'];
 const status={enabled:true} as ComponentProps<typeof ResearchActivity>['status'];
 const html=renderToStaticMarkup(<QueryClientProvider client={client}><ResearchActivity data={data} status={status} adminFetch={fetcher}/></QueryClientProvider>);
 assert.match(html,/Show queue/);assert.doesNotMatch(html,/Send to top|Cancel job/);
 for(const running of [false,true]){
  const actions=renderToStaticMarkup(<QueryClientProvider client={client}><ResearchQueueActions id="job" running={running} enabled adminFetch={fetcher}/></QueryClientProvider>);
  assert.match(actions,/Send to top/);assert.match(actions,/Cancel job/);
  assert.equal((actions.match(/disabled=""/g)||[]).length,running?2:0);
 }
 client.clear();
});
