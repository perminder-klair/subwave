import {createTempDir, removeTempDir} from './test-utils/temp-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const root=createTempDir(join(tmpdir(),'subwave-notes-segment-'));
process.env.STATE_DIR=root;
process.env.ADMIN_USER='operator';process.env.ADMIN_PASS='secret';
const settings=await import('../src/settings.js');
const store=await import('../src/settings/store.js');
const {migrate,open,close}=await import('../src/sleeve-notes/db.js');
const {prepareSleeveNotesSegmentInDatabase,runSleeveNotesSegment:runSegment,sleeveNotesSegmentOutputSchema,sleeveNotesSegmentPrompt,sleeveNotesSegmentWinsSlot}=await import('../src/sleeve-notes/segment.js');
const runSleeveNotesSegment=runSegment;
const {confirmedDayConnections,stationDayStart}=await import('../src/sleeve-notes/segment-connections.js');
const {setStationTimezone}=await import('../src/time.js');
const {admitLocalEncounterInDatabase}=await import('../src/sleeve-notes/research-repository.js');
const {recordSleeveNotesSegmentAir}=await import('../src/sleeve-notes/segment-ledger.js');
const {recordExtendedSleeveNoteSupplied}=await import('../src/sleeve-notes/link-selection.js');
const {heardOnAir}=await import('../src/sleeve-notes/heard-on-air.js');
const {sleeveNotesSegmentSchema,DEFAULT_SLEEVE_NOTES_SEGMENT}=await import('../src/schemas/settings.js');
await settings.load();
const host=settings.getOnAirRoster().host!;
const guest={...host,id:'guest',name:'Guest'};
const config={...DEFAULT_SLEEVE_NOTES_SEGMENT,enabled:true};
const now=Date.now(),at=new Date(now).toISOString();
const track={id:'local',title:'Song',artist:'Band',album:'Album'};
const first='Band recorded the album in a converted barn using a mobile studio.';
const second='Band built a tape loop from coins and cash registers to shape the song’s rhythm.';
function fixture(db=new Database(':memory:')) {
 migrate(db);
 db.prepare(`INSERT INTO sleeve_artists(id,name,musicbrainz_id,created_at,updated_at) VALUES ('artist','Band','artist',?,?)`).run(at,at);
 db.prepare(`INSERT INTO sleeve_recordings(id,title,artist_id,match_state,created_at,updated_at) VALUES ('recording','Song','artist','matched',?,?)`).run(at,at);
 db.prepare(`INSERT INTO sleeve_local_attachments(local_track_id,title,artist,release_title,recording_id,match_state,first_encountered_at,last_encountered_at,updated_at)
 VALUES ('local','Song','Band','Album','recording','matched',?,?,?)`).run(at,at,at);
 db.prepare(`INSERT INTO sleeve_source_documents(id,entity_type,entity_id,provider,source_url,content_hash,content_kind,content,attribution,retrieved_at)
 VALUES ('source','artist','artist','wikipedia','https://en.wikipedia.org/wiki/Band','hash','bounded-text',?,'Wikipedia',?)`).run(`${first} ${second}`,at);
 for(const [index,wording] of [first,second].entries()) db.prepare(`INSERT INTO sleeve_claims(id,entity_type,entity_id,category,topic,wording,source_document_id,evidence,extraction_rank,created_at,updated_at)
 VALUES (?,'artist','artist','artist-stories',?,?,'source',?,?,?,?)`).run('claim'+index,'topic'+index,wording,wording,index+1,at,at);
 return db;
}
const prepare=(db:Database.Database,c=config,guests:typeof guest[]=[])=>prepareSleeveNotesSegmentInDatabase(db,track,c,host,guests,now);

test('segment configuration is opt-in, validates boundaries and persists partial updates through a cold load',async()=>{
 assert.equal(settings.get().sleeveNotes.segment.enabled,false);
 assert.ok(!sleeveNotesSegmentSchema.safeParse({...config,cooldownMinutes:0}).success);
 assert.ok(!sleeveNotesSegmentSchema.safeParse({...config,cooldownMinutes:5.5}).success);
 assert.ok(!sleeveNotesSegmentSchema.safeParse({...config,cohosts:'yes'}).success);
 await settings.update({sleeveNotes:{segment:{enabled:true,cooldownMinutes:45,cohosts:false,personaIds:[host.id]}}});
 await settings.update({sleeveNotes:{segment:{cooldownMinutes:60}}});
 store.setCache(null);await settings.load();
 assert.deepEqual(settings.get().sleeveNotes.segment,{enabled:true,cooldownMinutes:60,cohosts:false,personaIds:[host.id]});
 assert.equal(settings.get().sleeveNotes.wikipedia.albumClaimLimit,5);
 await settings.update({djBehaviour:{extendedSleeveNotes:true},sleeveNotes:{segment:{cohosts:true,personaIds:null}}});
});

test('eligibility requires two scoped, enabled, unused stories and an allowed host',()=>{
 const db=fixture();assert.equal(prepare(db)?.notes.length,2);
 assert.equal(prepare(db,{...config,enabled:false}),null);
 assert.equal(prepare(db,{...config,personaIds:[]}),null);
 assert.equal(prepare(db,{...config,personaIds:['other-host']}),null);
 assert.ok(prepare(db,{...config,personaIds:[host.id]}));
 db.prepare("UPDATE sleeve_claims SET enabled=0 WHERE id='claim1'").run();assert.equal(prepare(db),null);
 db.prepare("UPDATE sleeve_claims SET enabled=1,airtime_scope='matching-release-only',matching_release_title='Another Album' WHERE id='claim1'").run();assert.equal(prepare(db),null);
 db.prepare("UPDATE sleeve_claims SET airtime_scope='general',wording=?,evidence=? WHERE id='claim1'").run(first,first);assert.equal(prepare(db),null);
 assert.equal((db.prepare('SELECT COUNT(*) AS n FROM sleeve_encounters').get() as {n:number}).n,0);db.close();
});

test('rankings alone cannot qualify automatically or crowd out an actual story',()=>{
 const db=fixture();
 const ranking0='Album was ranked number 115 in Rolling Stone’s 500 Greatest Albums.';
 const ranking1='Album was ranked number 18 in Pitchfork’s Best Albums of the 2010s.';
 const update=db.prepare("UPDATE sleeve_claims SET category='recognition',wording=?,evidence=? WHERE id=?");
 update.run(ranking0,ranking0,'claim0');update.run(ranking1,ranking1,'claim1');
 assert.equal(prepare(db),null);
 const manual=prepareSleeveNotesSegmentInDatabase(db,track,config,host,[],now,true)!;
 assert.equal(manual.notes.length,1);assert.equal(manual.notes[0].category,'recognition');
 // Several highly ranked list entries must not exclude a lower-ranked real story.
 for(let i=2;i<=5;i++)db.prepare(`INSERT INTO sleeve_claims(id,entity_type,entity_id,category,topic,wording,source_document_id,evidence,extraction_rank,created_at,updated_at)
 VALUES (?,'artist','artist',?,?,?,'source',?,?,?,?)`).run('extra'+i,i===5?'release-stories':'recognition',
  'extra-topic'+i,i===5?first:'Another publication ranked Album '+i,i===5?first:'Another publication ranked Album '+i,i===5?99:i+1,at,at);
 const brief=prepare(db)!;assert.equal(brief.notes.length,2);assert.equal(brief.notes[0].claimId,'extra5');
 assert.equal(brief.notes.filter(note=>note.category==='recognition').length,1);db.close();
});

test('the conversation prompt scopes Breeze tags to text and keeps one immutable cast and one house-rules block',()=>{
 const db=fixture();const saved=settings.get();
 const house='Start every speech block with exactly one [Tone: warm] tag. Tag and speech must share a line.';
 store.setCache({...saved,djHouseRules:house});
 try {
 const brief=prepare(db,config,[guest])!;
 const {system}=sleeveNotesSegmentPrompt(brief);
 assert.equal(system.split(house).length-1,1);
 assert.doesNotMatch(system,/You are .*the on-air DJ/);
 assert.match(system,/exactly two fields, speaker and text/);
 assert.match(system,/inside text on the same line/);
 assert.match(system,/never to reason, air, lines or speaker IDs/);
 assert.match(system,/Voice notes describe personality only/);
 assert.match(system,/Broad musical observations and critical judgements from general musical knowledge are welcome/);
 assert.match(system,/Specific claims about credits, dates, biography, recording events, awards, quotations or artist intentions must come from the supplied evidence/);
 assert.doesNotMatch(system,/no permission to supply facts from memory/);
 assert.match(system,/No greetings, show openings, guest introductions/);
 assert.match(system,/already-established show/);
 assert.match(system,/off-the-cuff, two-way discussion/);
 assert.match(system,/Follow one worthwhile thread/);
 assert.match(system,/rather than just interview the host or agree/);
 assert.match(system,/Do not simulate spontaneity by adding filler/);
 const multilingual=sleeveNotesSegmentPrompt({...brief,cast:[{...host,language:'French'},{...guest,language:'German'}]}).system;
 assert.equal(multilingual.split('LANGUAGE —').length-1,1);
 assert.match(multilingual,/you speak French/);
 assert.match(multilingual,/every spoken text field for the host and all guests entirely in French/);
 assert.doesNotMatch(multilingual,/you speak German/);
 const schema=sleeveNotesSegmentOutputSchema(brief.cast);
 const valid={air:true,reason:'Recording detail.',lines:[
  {speaker:host.id,text:'[Tone: warm] '+first},
  {speaker:guest.id,text:'[Tone: curious] '+second}]};
 assert.deepEqual(schema.parse(valid),valid);
 assert.equal(schema.safeParse({...valid,lines:[{speaker:host.id,tone:'[Tone: warm]',dialogue:first},valid.lines[1]]}).success,false);
 assert.equal(schema.safeParse({...valid,lines:[{...valid.lines[0],tone:'warm'},valid.lines[1]]}).success,false);
 } finally {store.setCache(saved);db.close();}
});

test('the segment receives full configured Souls, individual musical leanings and a captured show brief',()=>{
 const db=fixture();
 const hostSoul='h'.repeat(1950)+'HOST_SOUL_END',guestSoul='g'.repeat(1950)+'GUEST_SOUL_END';
 const hostLean='l'.repeat(460)+'HOST_LEAN_END',guestLean='m'.repeat(460)+'GUEST_LEAN_END';
 const show={id:'show',name:'Record Room',topic:'b'.repeat(1950)+'SHOW_BRIEF_END'};
 const brief=prepareSleeveNotesSegmentInDatabase(db,track,config,{...host,soul:hostSoul,musicLean:hostLean},
  [{...guest,soul:guestSoul,musicLean:guestLean}],now,false,show)!;
 show.topic='Changed after preparation';
 const {system,prompt}=sleeveNotesSegmentPrompt(brief);
 for(const text of [hostSoul,guestSoul,hostLean,guestLean])assert.ok(system.includes(text));
 assert.equal(system.split('LANGUAGE —').length-1,1);
 assert.match(system,/creative direction, not factual evidence/);
 assert.deepEqual(JSON.parse(prompt).show,{id:'show',name:'Record Room',brief:'b'.repeat(1950)+'SHOW_BRIEF_END'});
 assert.ok(!prompt.includes('Changed after preparation'));
 assert.deepEqual(JSON.parse(prompt).stories.map((story:{story:string})=>story.story),[first,second]);
 db.close();
});

test('unset musical leanings and show context stay absent while defensive prompt bounds match configuration limits',()=>{
 const db=fixture();
 const bare=prepareSleeveNotesSegmentInDatabase(db,track,config,{...host,musicLean:''},[{...guest,musicLean:undefined}],now)!;
 const plain=sleeveNotesSegmentPrompt(bare);
 assert.doesNotMatch(plain.system,/Musical leanings:/);assert.equal(JSON.parse(plain.prompt).show,null);
 const bounded=prepareSleeveNotesSegmentInDatabase(db,track,config,{...host,soul:'s'.repeat(2000)+'SOUL_OVERFLOW',musicLean:'l'.repeat(500)+'LEAN_OVERFLOW'},[],now,false,
  {id:'show',name:'Show',topic:'t'.repeat(2000)+'BRIEF_OVERFLOW'})!;
 const prompt=sleeveNotesSegmentPrompt(bounded);
 assert.ok(prompt.system.includes('s'.repeat(2000)));assert.ok(prompt.system.includes('l'.repeat(500)));
 assert.doesNotMatch(prompt.system,/SOUL_OVERFLOW|LEAN_OVERFLOW/);
 assert.equal(JSON.parse(prompt.prompt).show.brief,'t'.repeat(2000));db.close();
});

test('a one-fact manual run stays solo and no-history prompts contain no invented callback examples',()=>{
 const db=fixture();const saved=settings.get();
 store.setCache({...saved,djHouseRules:'Start each line with [Tone: friendly] and keep tag and speech on the same line.'});
 try {
 db.prepare("UPDATE sleeve_claims SET enabled=0 WHERE id='claim1'").run();
 assert.equal(prepare(db,config,[guest]),null);
 const brief=prepareSleeveNotesSegmentInDatabase(db,track,config,host,[guest],now,true)!;
 assert.deepEqual(brief.cast.map(persona=>persona.id),[host.id]);
 const system=sleeveNotesSegmentPrompt(brief).system;
 assert.match(system,/1–2 sentences/);assert.doesNotMatch(system,/Alex|When .* played that earlier today/);
 assert.match(system,/no verified earlier-day connections/);
 assert.ok(system.includes(JSON.stringify({speaker:host.id,text:'[Tone: friendly] A complete spoken contribution.'})));
 assert.match(system,/opening double quote must come BEFORE/);
 } finally {store.setCache(saved);db.close();}
});

test('a recent short artist link does not block different unused topics in the long-form segment',()=>{
 const db=fixture();
 db.prepare(`INSERT INTO sleeve_claims(id,entity_type,entity_id,category,topic,wording,source_document_id,evidence,created_at,updated_at)
 VALUES ('old','artist','artist','artist-stories','old-topic','An older story.','source','An older story.',?,?)`).run(at,at);
 db.prepare(`INSERT INTO sleeve_claim_uses(id,claim_id,entity_type,entity_id,category,topic,local_track_id,consumer,supplied_at,aired_at,detection_status)
 VALUES ('old-air','old','artist','artist','artist-stories','old-topic','local','generateLink',?,?,'detected')`).run(at,at);
 const brief=prepare(db)!;assert.equal(brief.notes.length,2);assert.ok(!brief.notes.some(note=>note.claimId==='old'));db.close();
});

test('the optional slot keeps a fair chance alongside skills, with changed weather retaining priority',()=>{
 assert.equal(sleeveNotesSegmentWinsSlot(['weather'],true,()=>0),false);
 assert.equal(sleeveNotesSegmentWinsSlot(['weather'],false,()=>0.99),true);
 assert.equal(sleeveNotesSegmentWinsSlot([],false,()=>0.99),true);
 assert.equal(sleeveNotesSegmentWinsSlot(['long-unfired-skill'],false,()=>0.4),true);
 assert.equal(sleeveNotesSegmentWinsSlot(['long-unfired-skill'],false,()=>0.6),false);
});

test('co-hosting follows the roster and validates a real conversation without invented speakers',()=>{
 const db=fixture();assert.equal(prepare(db)?.cast.length,1);
 const brief=prepare(db,config,[guest])!;assert.deepEqual(brief.cast.map(p=>p.id),[host.id,guest.id]);
 assert.equal(prepare(db,{...config,cohosts:false},[guest])?.cast.length,1);
 const schema=sleeveNotesSegmentOutputSchema(brief.cast);
 assert.ok(schema.safeParse({air:true,reason:'Discussion',lines:[{speaker:host.id,text:first},{speaker:guest.id,text:second},{speaker:host.id,text:'Those choices give the recording a distinct character.'}]}).success);
 assert.ok(!schema.safeParse({air:true,reason:'Missing guest',lines:[{speaker:host.id,text:first}]}).success);
 assert.ok(!schema.safeParse({air:true,reason:'Invented DJ',lines:[{speaker:'invented',text:first},{speaker:guest.id,text:second}]}).success);
 assert.match(sleeveNotesSegmentPrompt(brief).system,/two-way discussion/);
 assert.match(sleeveNotesSegmentPrompt(brief).system,/no verified earlier-day connections/);
 assert.deepEqual(brief.earlierToday,[]);db.close();
});

test('a valid two-voice reply to a three-DJ brief identifies the missing guest rather than blaming JSON or the host',()=>{
 const db=fixture();const third={...guest,id:'third',name:'Terry'};
 const brief=prepare(db,config,[guest,third])!;
 const schema=sleeveNotesSegmentOutputSchema(brief.cast);
 const reply=JSON.parse(JSON.stringify({reason:'Discuss the recording.',air:true,lines:[
  {speaker:host.id,text:'[Tone: friendly] '+first},
  {speaker:guest.id,text:'[Tone: curious] '+second},
  {speaker:host.id,text:'The recording choices are the interesting detail here.'}]}));
 const result=schema.safeParse(reply);assert.equal(result.success,false);
 if(!result.success)assert.deepEqual(result.error.issues.map(issue=>issue.message),['Missing contributions from: Terry (third)']);
 const system=sleeveNotesSegmentPrompt(brief).system;
 assert.ok(system.includes(`the first line must have speaker ${host.id}`));
 assert.match(system,/third \(Terry\)/);assert.match(system,/3 distinct speakers/);
 assert.match(system,/A second host contribution does not replace a missing guest/);
 reply.lines.splice(2,0,{speaker:third.id,text:'[Tone: thoughtful] '+first});
 assert.equal(schema.safeParse(reply).success,true);
 // A complete cast that opens with a guest has its own separate explanation.
 [reply.lines[0],reply.lines[1]]=[reply.lines[1],reply.lines[0]];
 const wrongOpener=schema.safeParse(reply);assert.equal(wrongOpener.success,false);
 if(!wrongOpener.success)assert.match(wrongOpener.error.issues[0].message,/must open the segment/);
 db.close();
});

test('callbacks span shows within the station day and carry only the host recorded on the earlier play',()=>{
 setStationTimezone('Europe/London');
 try {
 const db=fixture();const brief=prepare(db)!;
 const clock=Date.parse('2026-10-15T15:00:00Z');
 db.prepare(`INSERT INTO sleeve_local_attachments(local_track_id,title,artist,match_state,first_encountered_at,last_encountered_at,updated_at)
 VALUES ('peer','Earlier Song','Other Band','unmatched',?,?,?)`).run(at,at,at);
 const note={...brief.notes[0],connection:{id:'connection',claimId:'claim0',sourceRecordingId:'recording',type:'samples' as const,
   targetKind:'recording' as const,targetProviderId:'peer',targetTitle:'Earlier Song',targetArtist:'Other Band',targetUrl:null,matchState:'matched' as const,
   tracks:[{id:'peer',title:'Earlier Song',artist:'Other Band',recordingId:null,matchBasis:'fixture'}]}};
 const encounter=db.prepare('INSERT INTO sleeve_encounters(id,local_track_id,source,encountered_at,host_id,host_name) VALUES (?,?,?,?,?,?)');
 const earlier='2026-10-15T07:00:00.000Z', current='2026-10-15T14:55:00.000Z';
 encounter.run('queued','peer','queue',earlier,'old-host','Alex');
 assert.deepEqual(confirmedDayConnections(db,[note],'local',clock),[]);
 encounter.run('peer-play','peer','played',earlier,'old-host','Alex');
 assert.deepEqual(confirmedDayConnections(db,[note],'local',clock),[]);
 encounter.run('current-play','local','played',current,host.id,host.name);
 const callbacks=confirmedDayConnections(db,[note,note],'local',clock);
 assert.equal(callbacks.length,1);assert.deepEqual(callbacks[0].host,{id:'old-host',name:'Alex'});
 assert.equal(callbacks[0].stationTime,'08:00');assert.equal(callbacks[0].playedAt,earlier);
 encounter.run('late','peer','played','2026-10-15T14:58:00.000Z','later','Later');
 encounter.run('future','peer','played','2026-10-16T07:00:00.000Z','future','Future');
 assert.equal(confirmedDayConnections(db,[note],'local',clock)[0].host?.name,'Alex');
 db.prepare("UPDATE sleeve_encounters SET host_id=NULL,host_name=NULL WHERE id='peer-play'").run();
 const legacy=confirmedDayConnections(db,[note],'local',clock);assert.equal(legacy[0].host,null);
 const prompt=sleeveNotesSegmentPrompt({...brief,earlierToday:legacy});
 assert.match(prompt.system,/do not guess the DJ/);assert.match(prompt.system,/Do not invent anything the earlier DJ said/);
 assert.deepEqual(JSON.parse(prompt.prompt).earlierToday,legacy);
 db.prepare("UPDATE sleeve_encounters SET encountered_at='2026-10-14T23:30:00.000Z' WHERE id='peer-play'").run();
 assert.equal(confirmedDayConnections(db,[note],'local',clock).length,1);
 db.prepare("UPDATE sleeve_encounters SET encountered_at='2026-10-14T22:59:59.999Z' WHERE id='peer-play'").run();
 assert.deepEqual(confirmedDayConnections(db,[note],'local',clock),[]);
 assert.deepEqual(confirmedDayConnections(db,[note],'local',Date.parse('2026-10-16T12:00:00Z')),[]);
 db.close();
 } finally {setStationTimezone(settings.get().timezone);}
});

test('station-local day boundaries handle daylight saving and half-hour offsets',()=>{
 try {
 for(const [zone,clock,start] of [
  ['Europe/London','2026-03-29T20:00:00Z','2026-03-29T00:00:00.000Z'],
  ['Europe/London','2026-10-25T20:00:00Z','2026-10-24T23:00:00.000Z'],
  ['Asia/Kolkata','2026-10-15T03:00:00Z','2026-10-14T18:30:00.000Z'],
  ['America/New_York','2026-10-15T02:00:00Z','2026-10-14T04:00:00.000Z'],
 ]) {setStationTimezone(zone);assert.equal(new Date(stationDayStart(Date.parse(clock))).toISOString(),start);}
 } finally {setStationTimezone(settings.get().timezone);}
});

test('play admission snapshots host attribution while queued encounters keep an unknown host',()=>{
 const db=fixture();
 const input={localTrackId:'local',title:'Song',artist:'Band',releaseTitle:'Album',musicbrainzRecordingId:null,
  priority:1,source:'played' as const,host:{id:'earlier-dj',name:'Earlier DJ'},encounteredAt:'2026-10-15T07:00:00.000Z'};
 admitLocalEncounterInDatabase(db,input);
 assert.deepEqual(db.prepare("SELECT host_id,host_name,encountered_at FROM sleeve_encounters WHERE source='played'").get(),
  {host_id:'earlier-dj',host_name:'Earlier DJ',encountered_at:input.encounteredAt});
 admitLocalEncounterInDatabase(db,{...input,source:'queue'});
 assert.deepEqual(db.prepare("SELECT host_id,host_name FROM sleeve_encounters WHERE source='queue'").get(),{host_id:null,host_name:null});
 db.close();
});

test('publication failure releases reservations; confirmed air alone populates the shelf and persistent cooldown',async()=>{
 const db=fixture(open());const brief=prepare(db)!;
 const output={air:true,reason:'A musical connection between recording choices.',lines:[{speaker:host.id,text:`${first} ${second}`} ]};
 const generate=async()=>output;
 assert.equal(await runSleeveNotesSegment(brief,async()=>false,generate),false);
 assert.equal((db.prepare('SELECT COUNT(*) AS n FROM sleeve_claim_uses WHERE released_at IS NOT NULL').get() as {n:number}).n,2);
 assert.ok(prepare(db));
 let ids:string[]=[];
 assert.equal(await runSleeveNotesSegment(brief,async lines=>{ids=lines[0].meta.sleeveNotesSegmentUseIds;return true;},generate),true);
 assert.equal(ids.length,2);assert.equal(heardOnAir().total,0);assert.equal(prepare(db),null);
 const meta={sleeveNotesSegmentUseIds:ids};
 recordSleeveNotesSegmentAir(meta,output.lines[0].text,now);
 // Both aired offers belong on the shelf; wording detection is informational.
 assert.equal(heardOnAir().total,2);
 assert.equal((db.prepare("SELECT COUNT(*) AS n FROM sleeve_claim_uses WHERE consumer='sleeveNotesSegment' AND aired_at IS NOT NULL").get() as {n:number}).n,2);
 const {queue}=await import('../src/broadcast/queue.js');
 // Exercise the actual queue callback too, without TTS or mixer side effects.
 await queue.onSpoken({aired:Promise.resolve(now),voiceId:'segment-test',clipMs:1000},
   {kind:'sleeve-notes',channel:'say',text:output.lines[0].text,meta,persona:host});
 assert.equal(heardOnAir().total,2);
});

test('a model pass creates no reservations; accepted wording is not editorially vetoed',async()=>{
 const db=open();db.prepare('DELETE FROM sleeve_claim_uses').run();const brief=prepare(db)!;
 let published=false;
 assert.equal(await runSleeveNotesSegment(brief,async()=>{published=true;return true;},async()=>({air:false,reason:'Not enough to say.',lines:[]})),false);
 assert.equal(await runSleeveNotesSegment(brief,async()=>{published=true;return true;},async()=>({air:true,reason:'Filler',lines:[{speaker:host.id,text:'There is plenty to enjoy as we continue with more music.'}]})),true);
 assert.equal(published,true);assert.ok((db.prepare('SELECT COUNT(*) AS n FROM sleeve_claim_uses').get() as {n:number}).n>0);
 db.prepare('DELETE FROM sleeve_claim_uses').run();
});

test('a failed live-edge confirmation releases reservations without recording an airing',async()=>{
 const db=open();const brief=prepare(db)!;let ids:string[]=[];
 await runSleeveNotesSegment(brief,async lines=>{ids=lines[0].meta.sleeveNotesSegmentUseIds;return true;},async()=>({air:true,reason:'A recording story.',lines:[{speaker:host.id,text:first}]}));
 const {queue}=await import('../src/broadcast/queue.js');
 await queue.onSpoken({aired:Promise.resolve(null),voiceId:'not-aired',clipMs:1000},
   {kind:'sleeve-notes',channel:'say',text:first,meta:{sleeveNotesSegmentUseIds:ids},persona:host});
 assert.equal(heardOnAir().total,0);assert.ok(prepare(db));
});
test('co-hosted deferred speech preserves per-speaker facts and releases them when the pending segment is dropped',async t=>{
 const db=open();db.prepare('DELETE FROM sleeve_claim_uses').run();const brief=prepare(db)!;
 const {queue}=await import('../src/broadcast/queue.js');
 const {withTalkAir}=await import('../src/broadcast/talk-air.js');
 const speechQueue=queue as unknown as {_speak:()=>Promise<string>;_airVoice:()=>Promise<never>};
 t.mock.method(speechQueue,'_speak',async()=>'/tmp/sleeve-notes-conversation.wav');
 const air=t.mock.method(speechQueue,'_airVoice',async()=>{throw new Error('Deferred speech must not publish immediately');});
 const ids=brief.notes.map((note,index)=>recordExtendedSleeveNoteSupplied(note,index===0?first:second,'sleeveNotesSegment'));
 const lines=[{persona:host,text:first,meta:{sleeveNotesSegmentUseIds:[ids[0]]}},{persona:guest,text:second,meta:{sleeveNotesSegmentUseIds:[ids[1]]}}];
 assert.equal(await withTalkAir('next-track',()=>queue.announceExchange(lines,'sleeve-notes')),true);
 assert.equal(air.mock.callCount(),0);assert.equal(heardOnAir().total,0);
 assert.deepEqual(queue._pendingVoice?.clips.map(clip=>clip.meta.sleeveNotesSegmentUseIds),[[ids[0]],[ids[1]]]);
 queue.dropPendingVoice('test cancellation');
 assert.equal((db.prepare('SELECT COUNT(*) AS n FROM sleeve_claim_uses WHERE released_at IS NOT NULL').get() as {n:number}).n,2);
});

test('the ordinary segment tick offers the native segment only with on-air material and honours its cooldown',async t=>{
 const db=open();db.prepare('DELETE FROM sleeve_claim_uses').run();
 const saved=settings.get();
 store.setCache({...saved,personas:saved.personas.map(p=>({...p,frequency:'aggressive'})),
   llm:{...saved.llm,provider:'openai',model:'segment-test',fallback:{...saved.llm.fallback,enabled:false}}});
 const {replaceLoadedCapabilities}=await import('../src/skills/registry.js');replaceLoadedCapabilities([]);
 t.mock.method(globalThis,'fetch',async()=>{throw new Error('Unexpected live provider request');});
 const {primaryLeg}=await import('../src/llm/internal/provider/legs.js');
 let calls=0;const leg=primaryLeg();
 const output={air:true,reason:'Two recording observations.',lines:[{speaker:host.id,text:first+' '+second}]};
 for(const model of new Set([leg.model,leg.noThinkModel])) t.mock.method(model,'doGenerate',async(options:{tools?:Array<{name:string}>})=>{
   calls++;const emit=options.tools?.some(tool=>tool.name==='emit');
   return {content:emit?[{type:'tool-call',toolCallId:'segment',toolName:'emit',input:JSON.stringify(output)}]:[{type:'text',text:JSON.stringify(output)}],
     finishReason:{unified:emit?'tool-calls':'stop',raw:emit?'tool_calls':'stop'},usage:{inputTokens:{total:100,noCache:100,cacheRead:0,cacheWrite:0},outputTokens:{total:50,text:50,reasoning:0}},warnings:[]};
 });
 const {queue}=await import('../src/broadcast/queue.js');
 let playing=false;
 t.mock.method(queue,'getNowPlaying',async()=>playing?{subsonic_id:'local',title:'Song',artist:'Band',album:'Album'}:null);
 t.mock.method(queue,'getLastVoiceAt',()=>0);
 const announce=t.mock.method(queue,'announce',async()=>({accepted:true,deferred:false,completed:Promise.resolve(false)}));
 const {agenticTick}=await import('../src/skills/_agent.js');
 await agenticTick({time:{},clock:{}});assert.equal(calls,0);
 playing=true;await agenticTick({time:{},clock:{}});assert.equal(calls,1);assert.equal(announce.mock.callCount(),1);
 assert.equal(announce.mock.calls[0].arguments[1],'sleeve-notes');
 await agenticTick({time:{},clock:{}});assert.equal(calls,1);
 store.setCache(saved);
});

test('a concurrent track link reserving a story makes the segment stand down before publication',async()=>{
 const db=open();db.prepare('DELETE FROM sleeve_claim_uses').run();const brief=prepare(db)!;let published=false;
 const result=await runSleeveNotesSegment(brief,async()=>{published=true;return true;},async()=>{
   recordExtendedSleeveNoteSupplied(brief.notes[0],first);
   return {air:true,reason:'Recording observations.',lines:[{speaker:host.id,text:first+' '+second}]};
 });
 assert.equal(result,false);assert.equal(published,false);
 assert.equal((db.prepare("SELECT COUNT(*) AS n FROM sleeve_claim_uses WHERE consumer='sleeveNotesSegment'").get() as {n:number}).n,0);
});

test('operator preparation bypasses automatic enablement, assignment, segment and story cooldowns',()=>{
 const db=fixture();
 db.prepare(`INSERT INTO sleeve_claim_uses(id,claim_id,entity_type,entity_id,category,topic,local_track_id,consumer,supplied_at,aired_at,detection_status)
 VALUES ('used','claim0','artist','artist','artist-stories','topic0','local','sleeveNotesSegment',?,?,'detected')`).run(at,at);
 const disabled={...config,enabled:false,personaIds:[]};
 assert.equal(prepareSleeveNotesSegmentInDatabase(db,track,disabled,host,[],now),null);
 const brief=prepareSleeveNotesSegmentInDatabase(db,track,disabled,host,[],now,true)!;
 assert.equal(brief.notes.length,2);assert.equal(brief.manual,true);
 db.prepare("UPDATE sleeve_claims SET enabled=0 WHERE id='claim1'").run();
 const solo=prepareSleeveNotesSegmentInDatabase(db,track,disabled,host,[],now,true)!;
 assert.equal(solo.notes.length,1);assert.match(sleeveNotesSegmentPrompt(solo).system,/1–2 sentences/);
 // Holds, scope and current reservations still protect the retained evidence.
 db.prepare("UPDATE sleeve_claims SET airtime_scope='matching-release-only',matching_release_title='Wrong Album' WHERE id='claim0'").run();
 assert.equal(prepareSleeveNotesSegmentInDatabase(db,track,disabled,host,[],now,true),null);
 db.prepare("UPDATE sleeve_claims SET airtime_scope='general' WHERE id='claim0'").run();
 db.prepare("UPDATE sleeve_claim_uses SET aired_at=NULL,detection_status='not-detected' WHERE id='used'").run();
 assert.equal(prepareSleeveNotesSegmentInDatabase(db,track,disabled,host,[],now,true),null);
 db.close();
});

test('the master switch blocks manual segment preparation and generation without spending tokens',async()=>{
 const saved=settings.get();
 const brief=prepareSleeveNotesSegmentInDatabase(open(),track,config,host,[],Date.now(),true)!;
 store.setCache({...saved,djBehaviour:{...saved.djBehaviour,extendedSleeveNotes:false}});
 try {
  assert.equal((await import('../src/sleeve-notes/segment.js')).prepareSleeveNotesSegment(track,true),null);
  let called=false;
  assert.equal(await runSleeveNotesSegment(brief,async()=>true,async()=>{called=true;return {};}),false);
  assert.equal(called,false);
 }finally{store.setCache(saved);}
});

test('an operator script can publish with automatic segment settings off; overlapping runs stand down',async()=>{
 const db=open();db.prepare('DELETE FROM sleeve_claim_uses').run();
 const saved=settings.get();
 store.setCache({...saved,djBehaviour:{...saved.djBehaviour,extendedSleeveNotes:true},
  sleeveNotes:{...saved.sleeveNotes,segment:{...config,enabled:false,personaIds:[]}}});
 try {
 const brief=prepareSleeveNotesSegmentInDatabase(db,track,settings.get().sleeveNotes.segment,host,[],Date.now(),true)!;
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let entered!:()=>void;
 const ready=new Promise<void>(resolve=>{entered=resolve;});
 const running=runSleeveNotesSegment(brief,async()=>true,async()=>{entered();await gate;
  return {air:true,reason:'Recording detail.',lines:[{speaker:host.id,text:first}]};});
 await ready;let reason='';let calls=0;
 assert.equal(await runSleeveNotesSegment(brief,async()=>true,async()=>{calls++;},why=>{reason=why;}),false);
 assert.equal(calls,0);assert.match(reason,/already being prepared/);release();assert.equal(await running,true);
 db.prepare('DELETE FROM sleeve_claim_uses').run();
 assert.equal(await runSleeveNotesSegment(brief,async()=>true,async()=>({air:false,reason:'No worthwhile observation.',lines:[]}),why=>{reason=why;}),false);
 assert.equal(reason,'No worthwhile observation.');
 } finally {store.setCache(saved);}
});

test('Run Now route is admin-only, reads the live track, bypasses automatic segment switches and records the ordinary air path',async t=>{
 const express=(await import('express')).default;
 const {router}=await import('../src/routes/sleeve-notes.js');
 const {queue}=await import('../src/broadcast/queue.js');
 const db=open();db.prepare('DELETE FROM sleeve_claim_uses').run();
 const saved=settings.get();
 store.setCache({...saved,djBehaviour:{...saved.djBehaviour,extendedSleeveNotes:true},
  sleeveNotes:{...saved.sleeveNotes,segment:{...config,enabled:false,cohosts:false,personaIds:[]}},
  llm:{...saved.llm,provider:'openai',model:'manual-segment-test',fallback:{...saved.llm.fallback,enabled:false}}});
 const {primaryLeg}=await import('../src/llm/internal/provider/legs.js');
 const leg=primaryLeg();let modelCalls=0,decline=false,fail=false;
 const output=()=>decline?{air:false,reason:'Nothing worth adding.',lines:[]}:
  {air:true,reason:'Recording detail.',lines:[{speaker:host.id,text:first}]};
 for(const model of new Set([leg.model,leg.noThinkModel])) t.mock.method(model,'doGenerate',async(options:{tools?:Array<{name:string}>})=>{
   modelCalls++;if(fail)throw new Error('Test model unavailable');const emit=options.tools?.some(tool=>tool.name==='emit');
   return {content:emit?[{type:'tool-call',toolCallId:'manual',toolName:'emit',input:JSON.stringify(output())}]:[{type:'text',text:JSON.stringify(output())}],
    finishReason:{unified:emit?'tool-calls':'stop',raw:emit?'tool_calls':'stop'},usage:{inputTokens:{total:100,noCache:100,cacheRead:0,cacheWrite:0},outputTokens:{total:50,text:50,reasoning:0}},warnings:[]};
 });
 let playing=true;
 const nowPlaying=t.mock.method(queue,'getNowPlaying',async()=>playing?{subsonic_id:'local',title:'Song',artist:'Band',album:'Album'}:null);
 const announce=t.mock.method(queue,'announce',async()=>({accepted:true,deferred:true,completed:Promise.resolve(false)}));
 const app=express();app.use(express.json(),router);const server=app.listen(0,'127.0.0.1');
 await new Promise<void>(resolve=>server.once('listening',resolve));
 const address=server.address();if(!address||typeof address==='string')throw new Error('Missing test address');
 const url=`http://127.0.0.1:${address.port}/sleeve-notes/segment/run`;
 const headers={Authorization:`Basic ${Buffer.from('operator:secret').toString('base64')}`};
 try {
 assert.equal((await fetch(url,{method:'POST'})).status,401);assert.equal(nowPlaying.mock.callCount(),0);
 playing=false;let response=await fetch(url,{method:'POST',headers});assert.equal(response.status,200);
 let body=await response.json() as {queued:boolean;reason:string;deferred:boolean};assert.equal(body.queued,false);assert.match(body.reason,/no library track/);assert.equal(modelCalls,0);
 playing=true;response=await fetch(url,{method:'POST',headers});assert.equal(response.status,200);
 body=await response.json() as typeof body;assert.equal(body.queued,true);assert.equal(body.deferred,true);assert.equal(modelCalls,1);
 const options=announce.mock.calls[0].arguments[2] as {hostSpeech?:unknown;meta:{sleeveNotesSegmentUseIds:string[]}};
 assert.ok('hostSpeech' in options);assert.equal(options.meta.sleeveNotesSegmentUseIds.length,2);
 assert.equal(heardOnAir().total,0);
 db.prepare('DELETE FROM sleeve_claim_uses').run();decline=true;
 response=await fetch(url,{method:'POST',headers});body=await response.json() as typeof body;
 assert.equal(body.queued,false);assert.equal(body.reason,'Nothing worth adding.');assert.equal(announce.mock.callCount(),1);
 fail=true;response=await fetch(url,{method:'POST',headers});assert.equal(response.status,500);
 assert.equal(announce.mock.callCount(),1);
 store.setCache({...settings.get(),djBehaviour:{...settings.get().djBehaviour,extendedSleeveNotes:false}});
 response=await fetch(url,{method:'POST',headers});assert.equal(response.status,409);
 assert.equal(announce.mock.callCount(),1);
 } finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));store.setCache(saved);}
});

test('a short solo observation combines valid host blocks without a wording veto',async()=>{
 const db=open();db.prepare('DELETE FROM sleeve_claim_uses').run();
 db.prepare("UPDATE sleeve_claims SET enabled=0 WHERE id='claim1'").run();
 try {
 const brief=prepareSleeveNotesSegmentInDatabase(db,track,config,host,[guest],Date.now(),true)!;
 assert.equal(brief.cast.length,1);
 const lines=[{speaker:host.id,text:'[Tone: warm] '+first},
  {speaker:host.id,text:'[Tone: thoughtful] That is an unusual place to make a record.'}];
 const schema=sleeveNotesSegmentOutputSchema(brief.cast);
 assert.equal(schema.safeParse({reason:'Recording detail.',air:true,lines}).success,true);
 assert.equal(schema.safeParse({reason:'Too long.',air:true,lines:[...lines,lines[0]]}).success,false);
 assert.equal(schema.safeParse({reason:'Too long.',air:true,lines:[{speaker:host.id,text:'x'.repeat(350)},{speaker:host.id,text:'y'.repeat(350)}]}).success,false);
 let publishedText='';let publishedCount=0;
 assert.equal(await runSleeveNotesSegment(brief,async published=>{publishedCount=published.length;publishedText=published[0].text;return true;},
  async()=>({reason:'Recording detail.',air:true,lines})),true);
 assert.equal(publishedCount,1);assert.equal(publishedText,lines.map(line=>line.text).join('\n\n'));
 db.prepare('DELETE FROM sleeve_claim_uses').run();
 assert.equal(await runSleeveNotesSegment(brief,async()=>true,async()=>({reason:'Recording detail.',air:true,
  lines:[{speaker:host.id,text:'[Tone: friendly] A curious story for you.'},lines[0]]})),true);
 } finally {db.prepare("UPDATE sleeve_claims SET enabled=1 WHERE id='claim1'").run();}
});

test('the shelf keeps the complete confirmed conversation, including turns without a matching claim',async()=>{
 const db=open();db.prepare('DELETE FROM sleeve_claim_uses').run();
 const brief=prepareSleeveNotesSegmentInDatabase(db,track,config,host,[guest],Date.now(),true)!;
 const output={air:true,reason:'Recording detail.',lines:[{speaker:host.id,text:first},
  {speaker:guest.id,text:'How would that change the recording?'},{speaker:host.id,text:second}]};
 let published:import('../src/sleeve-notes/segment.js').SleeveNotesSegmentLine[]=[];
 assert.equal(await runSleeveNotesSegment(brief,async lines=>{published=lines;return true;},async()=>output),true);
 assert.equal(published.length,3);assert.equal(published[1].meta.sleeveNotesSegmentUseIds.length,0);
 const id=published[0].meta.sleeveNotesSegment!.id;
 assert.ok(published.every(line=>line.meta.sleeveNotesSegment?.id===id));
 assert.equal(heardOnAir().total,0);
 recordSleeveNotesSegmentAir(published[0].meta,published[0].text,now);
 let conversation=heardOnAir().items[0].conversation as {complete:boolean;expectedLines:number;lines:Array<{speakerName:string;text:string}>};
 assert.equal(conversation.complete,false);assert.equal(conversation.lines.length,1);assert.equal(conversation.expectedLines,3);
 // A later host callback can arrive before the guest callback without changing editorial order.
 recordSleeveNotesSegmentAir(published[2].meta,published[2].text,now+2000);
 conversation=heardOnAir().items[0].conversation as typeof conversation;
 assert.equal(conversation.complete,false);assert.equal(conversation.lines.length,2);
 const actualGuest='Those surroundings are quite a contrast to a studio.';
 recordSleeveNotesSegmentAir(published[1].meta,actualGuest,now+1000);
 conversation=heardOnAir().items[0].conversation as typeof conversation;
 assert.equal(conversation.complete,true);assert.deepEqual(conversation.lines.map(line=>line.speakerName),[host.name,guest.name,host.name]);
 assert.deepEqual(conversation.lines.map(line=>line.text),[first,actualGuest,second]);
 recordSleeveNotesSegmentAir(published[1].meta,actualGuest,now+1000);
 assert.equal((heardOnAir().items[0].conversation as typeof conversation).lines.length,3);
 // Another manual run on the same track has its own transcript. A failed line is never displayed.
 const next=prepareSleeveNotesSegmentInDatabase(db,track,config,host,[guest],Date.now(),true)!;
 assert.equal(await runSleeveNotesSegment(next,async lines=>{published=lines;return true;},async()=>output),true);
 const nextId=published[0].meta.sleeveNotesSegment!.id;assert.notEqual(nextId,id);
 recordSleeveNotesSegmentAir(published[0].meta,published[0].text,now+3000);
 recordSleeveNotesSegmentAir(published[1].meta,published[1].text,null);
 recordSleeveNotesSegmentAir(published[2].meta,published[2].text,now+5000);
 const partial=heardOnAir().items.find(item=>item.segmentId===nextId)!.conversation as typeof conversation;
 assert.equal(partial.complete,false);assert.equal(partial.lines.length,2);
 assert.ok(!partial.lines.some(line=>line.speakerName===guest.name));
});

test('malformed tone-and-dialogue output recovers through the shared SDK with tags preserved in each text field',async t=>{
 const db=open();db.prepare('DELETE FROM sleeve_claim_uses').run();
 const saved=settings.get();const house='Start every speech block with exactly one [Tone: warm] tag. Keep tag and speech on the same line.';
 store.setCache({...saved,djHouseRules:house,
  llm:{...saved.llm,provider:'openai',model:'segment-format-test',fallback:{...saved.llm.fallback,enabled:false}}});
 try {
 const brief=prepareSleeveNotesSegmentInDatabase(db,track,config,host,[guest],Date.now(),true)!;
 const valid={air:true,reason:'Recording detail.',lines:[{speaker:host.id,text:'[Tone: warm] '+first},{speaker:guest.id,text:'[Tone: curious] '+second}]};
 // The failure observed at 17:21:43 BST: bare strings in place of a text property.
 const malformed=`{"reason":"Recording detail","air":true,"lines":[{"speaker":"${host.id}","[Tone: warm]","${first}"}]}`;
 const {primaryLeg}=await import('../src/llm/internal/provider/legs.js');const leg=primaryLeg();let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{throw new Error('Unexpected live provider request');});
 for(const model of new Set([leg.model,leg.noThinkModel]))t.mock.method(model,'doGenerate',async(options:{prompt:unknown})=>{
  calls++;assert.match(JSON.stringify(options.prompt),/exactly two fields, speaker and text/);
  return {content:[{type:'text',text:calls===1?malformed:JSON.stringify(valid)}],finishReason:{unified:'stop',raw:'stop'},
   usage:{inputTokens:{total:100,noCache:100,cacheRead:0,cacheWrite:0},outputTokens:{total:50,text:50,reasoning:0}},warnings:[]};
 });
 let spoken:string[]=[];
 assert.equal(await runSleeveNotesSegment(brief,async lines=>{spoken=lines.map(line=>line.text);return true;}),true);
 assert.equal(calls,2);assert.deepEqual(spoken,valid.lines.map(line=>line.text));
 assert.equal((db.prepare("SELECT COUNT(*) AS n FROM sleeve_claim_uses WHERE consumer='sleeveNotesSegment' AND aired_at IS NOT NULL").get() as {n:number}).n,0);
 } finally {store.setCache(saved);}
});

test('automatic banter prefers Sleeve Notes in a produced episode and falls back without changing manual banter', async t => {
 const {weekFor}=await import('./test-utils/fixtures.js');
 const {queue}=await import('../src/broadcast/queue.js');
 const {withTalkAir,currentTalkAir}=await import('../src/broadcast/talk-air.js');
 const db=open();db.prepare('DELETE FROM sleeve_claim_uses').run();
 const saved=settings.get();
 const show={id:'notes-banter',name:'Produced Show',topic:'Recording stories',personaId:host.id,guestPersonaIds:[guest.id],programme:true,banter:true};
 store.setCache({...saved,personas:[host,guest],shows:[show],schedule:weekFor(show.id),scheduleOverride:null,
  djBehaviour:{...saved.djBehaviour,extendedSleeveNotes:true},sleeveNotes:{...saved.sleeveNotes,segment:config},
  llm:{...saved.llm,provider:'openai',model:'notes-banter-test',fallback:{...saved.llm.fallback,enabled:false}}});
 let clock=Date.now()+24*60*60_000;
 t.mock.method(Date,'now',()=>clock);
 let playing=true, mode='supported', rejectDelivery=false;
 t.mock.method(queue,'getNowPlaying',async()=>playing?{subsonic_id:'local',title:'Song',artist:'Band',album:'Album'}:null);
 t.mock.method(globalThis,'fetch',async()=>{throw new Error('Unexpected live provider request');});
 const {runBanter,refreshAutoPlaylist}=await import('../src/broadcast/scheduler.js');
 const {primaryLeg}=await import('../src/llm/internal/provider/legs.js');const leg=primaryLeg();
 const calls:string[]=[], delivered:string[]=[];
 for(const model of new Set([leg.model,leg.noThinkModel]))t.mock.method(model,'doGenerate',async(options:{prompt:unknown;tools?:Array<{name:string}>})=>{
  const banter=JSON.stringify(options.prompt).includes('You write short on-air exchanges');
  calls.push(banter?'banter':'sleeve-notes');
  if(!banter && mode==='error')throw new SyntaxError('Invalid segment response');
  const lines=[{speaker:host.id,text:first},{speaker:guest.id,text:second},{speaker:host.id,text:'That gives it a different feel.'}];
  const output=banter?{lines}:mode==='silent'?{air:false,reason:'Nothing worth adding.',lines:[]}:
   mode==='unsupported'?{air:true,reason:'An aside.',lines:lines.map(l=>({...l,text:'There is plenty to enjoy in the music.'}))}:
   {air:true,reason:'Recording stories.',lines};
  const emit=options.tools?.some(tool=>tool.name==='emit');
  return {content:emit?[{type:'tool-call',toolCallId:'banter-test',toolName:'emit',input:JSON.stringify(output)}]:[{type:'text',text:JSON.stringify(output)}],
   finishReason:{unified:emit?'tool-calls':'stop',raw:emit?'tool_calls':'stop'},
   usage:{inputTokens:{total:100,noCache:100,cacheRead:0,cacheWrite:0},outputTokens:{total:50,text:50,reasoning:0}},warnings:[]};
 });
 const exchange=t.mock.method(queue,'announceExchange',async(lines,kind)=>{
  delivered.push(kind!);
  if(kind==='sleeve-notes') {
   assert.equal(currentTalkAir(),'next-track');
   assert.deepEqual(lines.map(l=>l.persona.id),[host.id,guest.id,host.id]);
   assert.ok(lines.every(l=>l.meta?.sleeveNotesSegment));
   return !rejectDelivery;
  }
  return true;
 });
 const run=()=>withTalkAir('next-track',()=>runBanter({automatic:true}));
 const reset=()=>{clock+=65*60_000;db.prepare('DELETE FROM sleeve_claim_uses').run();calls.length=0;delivered.length=0;};
 try {
  await run();assert.deepEqual(calls,['sleeve-notes']);assert.deepEqual(delivered,['sleeve-notes']);
  assert.equal(heardOnAir().total,0,'queued speech is not heard speech');
  // Reservation writers use new Date(), whereas this test advances Date.now()
  // to exercise the shared retry window without sleeping.
  db.prepare('UPDATE sleeve_claim_uses SET supplied_at=?').run(new Date(clock).toISOString());
  calls.length=0;delivered.length=0;
  await run();assert.deepEqual(calls,['banter']);assert.deepEqual(delivered,['banter'],'shared ledger cooldown sends the next slot to banter');
  reset();mode='unsupported';await run();assert.deepEqual(calls,['sleeve-notes']);assert.deepEqual(delivered,['sleeve-notes'],'wording is not vetoed');
  for(const outcome of ['silent','error']) {
   reset();mode=outcome;await run();
   assert.ok(calls.includes('sleeve-notes'));assert.equal(calls.at(-1),'banter');assert.deepEqual(delivered,['banter']);
   calls.length=0;await run();assert.deepEqual(calls,['banter'],'unavailable material backs off across slots');
  }
  reset();mode='supported';rejectDelivery=true;await run();
  assert.deepEqual(delivered,['sleeve-notes','banter']);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM sleeve_claim_uses WHERE released_at IS NULL").get() as {n:number}).n,0);
  rejectDelivery=false;
  reset();playing=false;await run();assert.deepEqual(calls,['banter']);playing=true;
  reset();db.prepare("UPDATE sleeve_claims SET enabled=0 WHERE id='claim1'").run();
  await run();assert.deepEqual(calls,['banter']);db.prepare("UPDATE sleeve_claims SET enabled=1 WHERE id='claim1'").run();
  const active=settings.get();
  for(const patch of [
   {...active,djBehaviour:{...active.djBehaviour,extendedSleeveNotes:false}},
   {...active,sleeveNotes:{...active.sleeveNotes,segment:{...config,enabled:false}}},
   {...active,sleeveNotes:{...active.sleeveNotes,segment:{...config,personaIds:[]}}},
  ]) {reset();store.setCache(patch);await run();assert.deepEqual(calls,['banter']);}
  store.setCache(active);reset();await runBanter();assert.deepEqual(calls,['banter'],'manual Banter remains an explicit Banter request');
  const priorCurrent = queue.current;
  const shortTrack = t.mock.method(queue, 'remainingSecOnAir', () => 0);
  const oldLog = queue.djLog;
  try {
   store.setCache({...active, djBehaviour: {...active.djBehaviour, extendedSleeveNotes: false}});
   queue.current = {...priorCurrent, track: {id: 'short-track'}, startedAt: new Date().toISOString()} as typeof queue.current;
   queue.djLog = [];
   reset();
   assert.equal(await runBanter({automatic: true}), null);
   assert.deepEqual(calls, [], 'automatic Banter skips before spending LLM tokens');
   assert.ok(queue.djLog.some(entry => entry.message.includes('Banter skipped')));
   await runBanter();
   assert.deepEqual(calls, ['banter'], 'manual Banter bypasses the automatic speech budget');
  } finally { queue.current = priorCurrent; queue.djLog = oldLog; shortTrack.mock.restore(); store.setCache(active); }
  assert.ok(exchange.mock.callCount()>0);
  const logs=queue.djLog;
  try {queue.djLog=[];queue.log('sleeve-notes','Confirmed exchange');assert.equal(queue.getLastTalkBreakAt(),Date.parse(queue.djLog[0].t));}
  finally {queue.djLog=logs;}
 } finally {store.setCache(saved);await refreshAutoPlaylist();}
});

test('a translated segment publishes with one generation and retains confirmed-air records',async()=>{
 const db=open();db.prepare('DELETE FROM sleeve_claim_uses').run();
 const brief=prepareSleeveNotesSegmentInDatabase(db,track,config,{...host,language:'French'},[],Date.now(),true)!;
 const text='Ils ont enregistré leur album dans une grange aménagée.';
 let calls=0;let delivered:Parameters<Parameters<typeof runSegment>[1]>[0]=[];
 assert.equal(await runSegment(brief,async lines=>{delivered=lines;return true;},async()=>{
  calls++;return {air:true,reason:'Recording story',lines:[{speaker:host.id,text}]};
 }),true);
 assert.equal(calls,1);assert.ok(delivered[0].meta.sleeveNotesSegmentUseIds.length);
 assert.equal(heardOnAir().total,0);
 recordSleeveNotesSegmentAir(delivered[0].meta,text,Date.now());
 const use=db.prepare('SELECT aired_at,final_text FROM sleeve_claim_uses WHERE id=?').get(delivered[0].meta.sleeveNotesSegmentUseIds[0]) as {aired_at:string|null;final_text:string};
 assert.ok(use.aired_at);assert.equal(use.final_text,text);
});

test('timing targets enter the prompt and slow writing stands down before reservations',async t=>{
 const {planSpeechBudget}=await import('../src/broadcast/speech-budget.js');
 const db=open();db.prepare('DELETE FROM sleeve_claim_uses').run();
 const brief=prepareSleeveNotesSegmentInDatabase(db,track,config,host,[],Date.now(),true)!;
 let clock=Date.now();const start=clock;t.mock.method(Date,'now',()=>clock);
 brief.speechBudget=planSpeechBudget({nowMs:start,remainingSeconds:60,crossfadeSeconds:0,writingSeconds:5,
  generationWps:3.12,spokenWps:3.49,castSize:1,maxWords:100,trackId:'local',startedAt:'start'});
 assert.match(sleeveNotesSegmentPrompt(brief).system,/74 spoken words TOTAL/);
 let calls=0,published=false;
 assert.equal(await runSegment(brief,async()=>{published=true;return true;},async()=>{
  calls++;clock+=48_000;return {air:true,reason:'Recording story',lines:[{speaker:host.id,text:first}]};
 }),false);
 assert.equal(calls,1);assert.equal(published,false);
 assert.equal((db.prepare('SELECT COUNT(*) AS n FROM sleeve_claim_uses').get() as {n:number}).n,0);
 brief.speechBudget.maxWords=0;
 assert.equal(await runSegment(brief,async()=>true,async()=>{calls++;}),false);
 assert.equal(calls,1,'a known insufficient window never calls the writer');
});

test.after(async ()=>{close();await removeTempDir(root);});

test('disable during generation cancels late output without reservations or publication',async()=>{
 const saved=settings.get();const db=open();db.prepare('DELETE FROM sleeve_claim_uses').run();
 store.setCache({...saved,djBehaviour:{...saved.djBehaviour,extendedSleeveNotes:true}});
 const brief=prepareSleeveNotesSegmentInDatabase(db,track,config,host,[],Date.now(),true)!;
 let release:()=>void=()=>{};let entered:()=>void=()=>{};let signal:AbortSignal|undefined;let published=false;
 const started=new Promise<void>(resolve=>{entered=resolve;});
 try {
  const running=runSleeveNotesSegment(brief,async()=>{published=true;return true;},async options=>{
   signal=options.signal;entered();await new Promise<void>(resolve=>{release=resolve;});
   return {air:true,reason:'A source-backed story.',lines:[{speaker:host.id,text:first}]};
  });
  await started;store.setCache({...settings.get(),djBehaviour:{...settings.get().djBehaviour,extendedSleeveNotes:false}});
  assert.equal(signal?.aborted,true);store.setCache({...settings.get(),djBehaviour:{...settings.get().djBehaviour,extendedSleeveNotes:true}});
  release();assert.equal(await running,false);
  assert.equal(published,false);assert.equal((db.prepare('SELECT COUNT(*) AS n FROM sleeve_claim_uses').get() as {n:number}).n,0);
 }finally{release();store.setCache(saved);}
});


test('disabling Sleeve Notes before or during TTS releases reservations without publishing', async t => {
 const {queue} = await import('../src/broadcast/queue.js');
 const saved = settings.get();
 const db = open();
 const speechQueue = queue as unknown as {_speak: () => Promise<string>; _airVoice: () => Promise<never>};
 const speak = t.mock.method(speechQueue, '_speak', async () => '/tmp/not-aired.wav');
 const air = t.mock.method(speechQueue, '_airVoice', async () => {throw new Error('Disabled speech must not air');});
 try {
  for (const duringRender of [false, true]) {
   db.prepare('DELETE FROM sleeve_claim_uses').run();
   store.setCache({...saved, djBehaviour: {...saved.djBehaviour, extendedSleeveNotes: true}});
   const note = prepare(db)!.notes[0]!;
   const id = recordExtendedSleeveNoteSupplied(note, first, 'sleeveNotesSegment');
   if (duringRender) speak.mock.mockImplementation(async () => {
    store.setCache({...saved, djBehaviour: {...saved.djBehaviour, extendedSleeveNotes: false}});
    return '/tmp/not-aired.wav';
   });
   else store.setCache({...saved, djBehaviour: {...saved.djBehaviour, extendedSleeveNotes: false}});
   const before = speak.mock.callCount();
   const outcome = await queue.announce(first, 'sleeve-notes', {sleeveClaimUseId: id});
   assert.equal(outcome.accepted, false);
   assert.equal(speak.mock.callCount() - before, duringRender ? 1 : 0);
   assert.equal(air.mock.callCount(), 0);
   assert.ok((db.prepare('SELECT released_at FROM sleeve_claim_uses WHERE id=?').get(id) as {released_at: string|null}).released_at);
  }
 } finally {store.setCache(saved);}
});
