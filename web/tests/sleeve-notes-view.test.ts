import test from 'node:test';
import assert from 'node:assert/strict';
import {brainQueueChoice,groupAiredStories,storiesHref} from '../components/admin/sleeve-notes-view';

test('grouped transcripts retain separate story IDs and independent DJ links',()=>{
 const groups=groupAiredStories([{id:'one',segmentId:'segment'},{id:'two',segmentId:'segment'},{id:'link-one'},{id:'link-two'}]);
 assert.equal(groups.size,3);assert.deepEqual(groups.get('segment')?.map(item=>item.id),['one','two']);
});

test('a dossier link preserves the selected subject and map location for return',()=>{
 const href=storiesHref({id:'release-group:album',entityType:'release-group',entityId:'album',title:'An Album'},'tab=connections&focusType=artist&focusId=artist&edge=writer');
 const params=new URL(href,'https://example.test').searchParams;
 assert.equal(params.get('storyType'),'release-group');assert.equal(params.get('storyId'),'album');
 assert.equal(params.get('focusId'),'artist');assert.equal(params.get('brainSelected'),'release-group:album');
 assert.equal(params.get('from'),'brain');
 const library=new URL(storiesHref({id:'library-album:local',entityType:'library-album',entityId:'local',title:'Local Album'},params.toString()),'https://example.test');
 assert.equal(library.searchParams.get('q'),'Local Album');assert.equal(library.searchParams.has('storyId'),false);
});


test('Notes dates use an explicit station timezone and omit diagnostic seconds',async()=>{
  const {formatNotesDate}=await import('../components/admin/sleeve-notes-view');
  assert.equal(formatNotesDate('2026-10-18T23:30:45Z','Europe/London'),'19 Oct 2026, 00:30');
  assert.equal(formatNotesDate('2026-10-18T23:30:45Z','UTC'),'18 Oct 2026, 23:30');
  assert.equal(formatNotesDate('invalid','UTC'),'—');
});


test('Station Brain queue scope follows the layer and narrows to a selected child',()=>{
  const artist={id:'artist:a',entityType:'library-artist',entityId:'a',kind:'artist',title:'Artist',subtitle:null,
    local:true,expandable:true,sourceUrl:null} as const;
  const album={...artist,id:'album:b',entityType:'library-album',entityId:'b',kind:'release',title:'Album'} as const;
  const track={...artist,id:'track:c',entityType:'library-track',entityId:'c',kind:'recording',title:'Track'} as const;
  assert.deepEqual(brainQueueChoice(true,null,null),{node:null,label:'Choose a Track and Queue'});
  assert.deepEqual(brainQueueChoice(true,null,artist),{node:artist,label:'Choose a Track and Queue'});
  assert.deepEqual(brainQueueChoice(false,artist,null),{node:artist,label:'Choose Artist Track and Queue'});
  assert.deepEqual(brainQueueChoice(false,artist,album),{node:album,label:'Choose Album Track and Queue'});
  assert.deepEqual(brainQueueChoice(false,album,null),{node:album,label:'Choose Any Album Track and Queue'});
  assert.deepEqual(brainQueueChoice(false,album,track),{node:track,label:'Queue This Track'});
  assert.equal(brainQueueChoice(true,null,{...artist,local:false}).node,null);
  assert.equal(brainQueueChoice(false,album,null).node,album,'clearing a track selection restores the album default');
});

test('artist research chooses the library-linked record over provisional and unused same-name records',async()=>{
  const {artistResearchSource}=await import('../components/admin/sleeve-notes-view');
  const provisional={id:'genius',name:'Antony Szmierek',mbid:null,matchedTracks:0,articleUrl:null,storyCount:0,canRetry:false};
  const matched={...provisional,id:'matched',mbid:'musicbrainz-artist',matchedTracks:3};
  const unused={...matched,id:'unused',mbid:'another-musicbrainz-artist',matchedTracks:0};
  for(const identities of [[provisional,matched],[matched,provisional],[unused,provisional,matched]]) {
    assert.equal(artistResearchSource({name:'Antony Szmierek',identities})?.id,'matched');
  }
});
test('multiple matched artist records need an explicit choice, regardless of which has more stories',async()=>{
  const {artistResearchSource}=await import('../components/admin/sleeve-notes-view');
  const first={id:'a',name:'Artist',mbid:'mb-a',matchedTracks:20,articleUrl:null,storyCount:40,canRetry:false};
  const second={...first,id:'b',mbid:'mb-b',matchedTracks:1,storyCount:0};
  assert.equal(artistResearchSource({name:'Artist',identities:[first,second]}),null);
});
test('without matched recordings, only an unambiguous artist record is chosen',async()=>{
  const {artistResearchSource}=await import('../components/admin/sleeve-notes-view');
  const provisional={id:'provisional',name:'Artist',mbid:null,matchedTracks:0,articleUrl:null,storyCount:0,canRetry:false};
  const canonical={...provisional,id:'canonical',mbid:'mb-a'};
  assert.equal(artistResearchSource({name:'Artist',identities:[provisional,canonical]})?.id,'canonical');
  assert.equal(artistResearchSource({name:'Artist',identities:[provisional]})?.id,'provisional');
  assert.equal(artistResearchSource({name:'Artist',identities:[canonical,{...canonical,id:'other',mbid:'mb-b'}]}),null);
  assert.equal(artistResearchSource({name:'Artist',identities:[]}),null);
});
test('a composer credit cannot silently select a different performer for biography editing',async()=>{
  const {artistResearchSource}=await import('../components/admin/sleeve-notes-view');
  const performer={id:'performer',name:'Example Performer',mbid:'mb',matchedTracks:2,articleUrl:null,storyCount:4,canRetry:false};
  assert.equal(artistResearchSource({name:'Example Composer',identities:[performer]}),null);
  assert.equal(artistResearchSource({name:'Example Performer',identities:[performer]})?.id,'performer');
});
test('artist editor comparisons tolerate typography without merging distinct names',async()=>{
  const {artistResearchSource}=await import('../components/admin/sleeve-notes-view');
  const artist={id:'artist',name:"Youssou N'Dour",mbid:'mb',matchedTracks:2,articleUrl:null,storyCount:4,canRetry:false};
  assert.equal(artistResearchSource({name:'  Youssou  N’Dour ',identities:[artist]})?.id,'artist');
  assert.equal(artistResearchSource({name:'Youssou N’Dour & Le Super Étoile',identities:[artist]}),null);
});
