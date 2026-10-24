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
