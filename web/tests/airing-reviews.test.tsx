import assert from 'node:assert/strict';
import test from 'node:test';
import {renderToStaticMarkup} from 'react-dom/server';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import HeardOnAir from '../components/admin/HeardOnAir';
import AiringReviews from '../components/admin/AiringReviews';
import {ClaimCard} from '../components/admin/NotesPanel';

const fetcher=async()=>{throw new Error('No network in render tests');};
test('a multi-Spark conversation offers one Flag action without a mandatory feedback form',()=>{
  const client=new QueryClient();
  const first={id:'one',segmentId:'segment',consumer:'sleeveNotesSegment',claimId:'claim',artist:'Killing Joke',title:'Song',airedAt:'2026-10-17T10:00:00Z',
    offeredWording:'The founding members reunited.',currentWording:'The founding members reunited.',wordingAtOffer:'The founding members reunited.',
    spokenText:'Even in death we find closure.',enabled:1,operatorState:'auto',sourceUrl:'https://example.test',provider:'wikipedia',attribution:'Source',sparkDetected:0,
    story:null,delivery:null,note:null,feedbackAt:null};
  client.setQueryData(['sleeve-notes','heard-on-air',0,'','','','sleeve-notes'],{items:[first,{...first,id:'two'}],total:2,conversationTotal:1,readOnly:false,feedbackTotals:{story:[],delivery:[]}});
  const html=renderToStaticMarkup(<QueryClientProvider client={client}><HeardOnAir adminFetch={fetcher}/></QueryClientProvider>);
  assert.match(html,/type="search"/);assert.match(html,/Exchange type/);assert.match(html,/Last 24 hours/);assert.match(html,/<option value="sleeve-notes" selected="">Segments and used Sparks/);
  assert.equal(html.split('Flag for review').length-1,1);assert.match(html,/use not detected/);
  assert.doesNotMatch(html,/<form|Specific story problem|Leave feedback/);client.clear();
});
test('the Review panel separates proposed speech and guidance from explicit approval actions',()=>{
  const client=new QueryClient();
  client.setQueryData(['sleeve-notes','airing-reviews','active',0],{items:[{id:'review',state:'ready',guidanceApproved:0,lastError:null,
    context:{artist:'Killing Joke',title:'Song',airedAt:'2026-10-17T10:00:00Z',speech:['Aired speech.'],sparks:[{claimId:'claim',wording:'Stored wording.',offered:'Offered wording.',evidence:'A supporting passage.',source:'https://example.test'}]},
    result:{finding:'presentation',summary:'An invented emotional conclusion.',explanation:'The Spark does not describe closure.',suggestedSpeech:'After Raven’s death in 2007…',proposedGuidance:'Preserve date context.',sparkCorrection:null}}],total:1,readOnly:false});
  const html=renderToStaticMarkup(<QueryClientProvider client={client}><AiringReviews adminFetch={fetcher}/></QueryClientProvider>);
  assert.match(html,/Offered Spark/);assert.match(html,/Offered wording/);assert.match(html,/Source passage/);assert.match(html,/A supporting passage/);
  assert.match(html,/Ready for your decision/);assert.match(html,/draft only/);assert.match(html,/Apply guidance and resolve/);
  assert.match(html,/Keep Sparks and resolve/);assert.doesNotMatch(html,/Apply Spark correction and resolve/);
  const key=['sleeve-notes','airing-reviews','active',0];
  const data=client.getQueryData<{items:Array<{state:string}>}>(key)!;
  client.setQueryData(key,{...data,items:data.items.map(item=>({...item,state:'dismissed'}))});
  const dismissed=renderToStaticMarkup(<QueryClientProvider client={client}><AiringReviews adminFetch={fetcher}/></QueryClientProvider>);
  assert.match(dismissed,/Retry review/);assert.doesNotMatch(dismissed,/Apply guidance and resolve/);client.clear();
});


test('stored-fact review has no invented airing or speech and keeps withdrawal explicit',()=>{
  const client=new QueryClient();
  const review={id:'fact-review',state:'ready',guidanceApproved:0,lastError:null,createdAt:'2026-10-17T12:00:00Z',
    context:{kind:'fact',artist:'The Libertines',title:null,airedAt:null,speech:[],sparks:[{claimId:'fact',wording:'The Libertines are an English rock band.',
      source:'https://example.test',evidence:'A supporting source passage.',enabled:0,operatorState:'auto'}]},
    result:{finding:'no-issue',summary:'The fact is supported.',explanation:'Source and wording agree.',suggestedSpeech:'',proposedGuidance:null,sparkCorrection:null}};
  client.setQueryData(['sleeve-notes','airing-reviews','active',0],{items:[review],total:1,readOnly:false});
  const html=renderToStaticMarkup(<QueryClientProvider client={client}><AiringReviews adminFetch={fetcher}/></QueryClientProvider>);
  assert.match(html,/Withdrawn from DJ use/);assert.match(html,/Restore unchanged and resolve/);assert.match(html,/Keep withdrawn and resolve/);
  assert.match(html,/Delete fact and resolve/);assert.match(html,/Saved fact and source/);
  assert.doesNotMatch(html,/Aired speech|Invalid Date|draft only|Proposed generation guidance/);
  client.clear();
});

test('Stories flags facts without withdrawing them and provides separate availability controls',()=>{
  const client=new QueryClient();
  const claim={id:'fact',artist:'The Libertines',recording:null,provider:'wikipedia',category:'artist-stories',topic:'formation',
    wording:'The Libertines are an English rock band.',shortWording:'',sourceUrl:'https://example.test',evidence:'A supporting source passage.',enabled:1};
  const render=(enabled:number)=>renderToStaticMarkup(<QueryClientProvider client={client}><ClaimCard claim={{...claim,enabled}} adminFetch={fetcher}/></QueryClientProvider>);
  const active=render(1);assert.match(active,/Flag for review/);assert.match(active,/Withdraw from DJ use/);assert.doesNotMatch(active,/Send to Review|Restore unchanged/);
  const withdrawn=render(0);assert.match(withdrawn,/Flag for review/);assert.match(withdrawn,/Restore unchanged/);assert.match(withdrawn,/Delete fact/);
  assert.match(withdrawn,/Dismissing a review will not restore it/);client.clear();
});


test('proposed corrections have editable wording and evidence; saved and read-only reviews do not',()=>{
  const client=new QueryClient(),key=['sleeve-notes','airing-reviews','active',0];
  const correction={claimId:'claim',wording:'The band formed in London in 1997.',evidence:'The source says the band formed in London in 1997.'};
  const review={id:'editable',state:'ready',guidanceApproved:0,lastError:null,createdAt:'2026-10-17T12:00:00Z',
    context:{artist:'The Libertines',title:'Song',airedAt:'2026-10-17T12:00:00Z',speech:['Aired speech.'],sparks:[]},
    result:{finding:'spark',summary:'A correction is proposed.',explanation:'Check the wording.',suggestedSpeech:'',proposedGuidance:null,sparkCorrection:correction}};
  const render=()=>renderToStaticMarkup(<QueryClientProvider client={client}><AiringReviews adminFetch={fetcher}/></QueryClientProvider>);
  client.setQueryData(key,{items:[review],total:1,readOnly:false});
  const editable=render();assert.equal((editable.match(/<textarea/g)||[]).length,2);
  assert.match(editable,/Wording/);assert.match(editable,/Supporting passage/);assert.match(editable,/maxLength="360"/i);
  assert.match(editable,/The band formed in London in 1997/);assert.match(editable,/Apply Spark correction and resolve/);
  client.setQueryData(key,{items:[review],total:1,readOnly:true});
  assert.doesNotMatch(render(),/<textarea|Apply Spark correction and resolve/);
  const applied={...correction,wording:'The Libertines formed in London in 1997.'};
  client.setQueryData(key,{items:[{...review,state:'resolved',context:{...review.context,appliedCorrection:applied}}],total:1,readOnly:false});
  const saved=render();assert.match(saved,/Saved Spark correction/);assert.match(saved,/The Libertines formed in London in 1997/);assert.doesNotMatch(saved,/<textarea/);
  client.clear();
});


test('Stories shows the persisted review after the card is mounted again',()=>{
  const client=new QueryClient();
  const claim={id:'fact',artist:'The Libertines',recording:null,provider:'wikipedia',category:'artist-stories',topic:'formation',
    wording:'The band formed in London.',shortWording:'',sourceUrl:'https://example.test',evidence:'The band formed in London.',enabled:1,
    review:{id:'existing-review',state:'ready'}};
  const html=renderToStaticMarkup(<QueryClientProvider client={client}><ClaimCard claim={claim} adminFetch={fetcher}/></QueryClientProvider>);
  assert.match(html,/Flagged for review/);assert.match(html,/Ready for your decision/);
  assert.match(html,/disabled=""/);assert.match(html,/tab=moderation/);client.clear();
});

test('Heard on air defaults to confirmed segments and detected-use links',()=>{
  const client=new QueryClient();
  client.setQueryData(['sleeve-notes','heard-on-air',0,'','','','sleeve-notes'],{items:[],total:0,readOnly:false,feedbackTotals:{story:[],delivery:[]}});
  const html=renderToStaticMarkup(<QueryClientProvider client={client}><HeardOnAir adminFetch={fetcher}/></QueryClientProvider>);
  assert.doesNotMatch(html,/Reset filters/);
  assert.match(html,/<option value="sleeve-notes" selected="">Segments and used Sparks/);client.clear();
});

test('ready facts without model corrections offer manual editing; resolved and read-only reviews retain the saved correction',()=>{
  const client=new QueryClient(),key=['sleeve-notes','airing-reviews','active',0];
  const spark={claimId:'claim',wording:'On 20 March 2026, the band announced a temporary guitarist.',evidence:'On 20 March 2026, the band announced a temporary guitarist.',source:'https://example.test',enabled:1,operatorState:'auto'};
  const review={id:'manual',state:'ready',guidanceApproved:0,lastError:null,createdAt:'2026-10-21T14:00:00Z',
    context:{kind:'fact',artist:'Band',title:null,airedAt:null,speech:[],sparks:[spark]},
    result:{finding:'spark',summary:'A wording issue.',explanation:'No correction was supplied.',suggestedSpeech:'',proposedGuidance:null,sparkCorrection:null}};
  const render=()=>renderToStaticMarkup(<QueryClientProvider client={client}><AiringReviews adminFetch={fetcher}/></QueryClientProvider>);
  client.setQueryData(key,{items:[review],total:1,readOnly:false});
  assert.match(render(),/No replacement wording was suggested/);assert.match(render(),/Edit saved fact/);
  assert.doesNotMatch(render(),/Save correction and resolve|<textarea/,'manual editing must be explicitly opened');
  client.setQueryData(key,{items:[review],total:1,readOnly:true});assert.doesNotMatch(render(),/Edit saved fact|<textarea/);
  const appliedCorrection={claimId:'claim',wording:'The band announced a temporary guitarist on 20 March 2026.',evidence:spark.evidence};
  client.setQueryData(key,{items:[{...review,state:'resolved',context:{...review.context,appliedCorrection}}],total:1,readOnly:false});
  assert.match(render(),/Saved Spark correction/);assert.match(render(),/The band announced a temporary guitarist on 20 March 2026/);
  assert.doesNotMatch(render(),/Edit saved fact|<textarea/);client.clear();
});
