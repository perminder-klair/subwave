import {createTempDir, removeTempDir} from './test-utils/temp-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = createTempDir(join(tmpdir(), 'subwave-live-notes-'));
process.env.STATE_DIR = root;
const { open, close, withCachedRead, DB_PATH } = await import('../src/sleeve-notes/db.js');
const { liveNotesSummary } = await import('../src/sleeve-notes/live-summary.js');
const db = open(); const now = new Date().toISOString();
db.prepare(`INSERT INTO sleeve_source_documents (id,entity_type,entity_id,provider,source_url,content_hash,content_kind,content,attribution,retrieved_at)
  VALUES ('source','artist','artist','wikipedia','https://example.test/story','hash','bounded-text','A recording story.','Article',?)`).run(now);
db.prepare(`INSERT INTO sleeve_claims (id,entity_type,entity_id,category,topic,wording,source_document_id,evidence,created_at,updated_at)
  VALUES ('claim','artist','artist','artist-stories','studio','A recording story.','source','A recording story.',?,?)`).run(now, now);
const use = db.prepare(`INSERT INTO sleeve_claim_uses (id,claim_id,local_track_id,entity_type,entity_id,category,topic,supplied_at,offered_wording,tts_text,tts_rendered_at,aired_at,speech_signal)
  VALUES (?,'claim',?,'artist','artist','artist-stories','studio',?,?,?, ?,?,?)`);
use.run('old','track',now,'Old play Spark.','Old DJ line.',now,now,JSON.stringify({version:1,status:'detected'}));
use.run('current','track',now,'Current play Spark.','Rendered DJ line.',now,now,JSON.stringify({version:1,status:'detected'}));
use.run('next','next-track',now,'Next play Spark.',null,null,null,null);
const current = { track: { id: 'track',title: 'Song',artist:'Band',album:'Album' }, sleeveClaimUseId:'current',introScript:'Draft DJ line.' };
const next = { track: { id:'next-track',title:'Next song',artist:'Another Band' },sleeveClaimUseId:'next',introScript:'Next DJ line.' };

test('live summary uses exact queue reservations and rendered speech rather than older plays or drafts', () => {
  const summary = liveNotesSummary({ subsonic_id:'track',title:'Song',artist:'Band',album:'Album' }, current, next);
  assert.equal(summary.onAir?.spark?.wording,'Current play Spark.');
  assert.equal(summary.onAir?.djLine,'Rendered DJ line.'); assert.equal(summary.onAir?.spark?.factDetected,true);
  assert.equal(summary.nextUp?.spark?.wording,'Next play Spark.'); assert.equal(summary.nextUp?.djLine,'Next DJ line.');
  assert.equal(summary.nextUp?.spark?.airedAt,null);
});
test('a boundary mismatch keeps actual on-air metadata without attaching outgoing speech', () => {
  const summary = liveNotesSummary({ subsonic_id:'different',title:'Actual song',artist:'New Artist' }, current, next);
  assert.equal(summary.onAir?.track.title,'Actual song'); assert.equal(summary.onAir?.spark,null); assert.equal(summary.onAir?.djLine,null);
  assert.equal(summary.nextUp?.track.title,'Next song');
});
test('missing reservations never borrow previous track facts, and a reservation for another track is rejected', () => {
  const summary = liveNotesSummary({subsonic_id:'track',title:'Song'}, {...current,sleeveClaimUseId:null}, {...next,sleeveClaimUseId:'current'});
  assert.equal(summary.onAir?.spark,null); assert.equal(summary.nextUp?.spark,null);
  assert.equal(liveNotesSummary(null,current,null).onAir,null);
  assert.deepEqual(liveNotesSummary(null,null,null),{onAir:null,nextUp:null});
});
test('unprepared links show matching stored Sparks and available counts using actual scope and cooldown rules', () => {
  db.prepare(`INSERT INTO sleeve_artists (id,name,musicbrainz_id,created_at,updated_at) VALUES ('artist','Band','artist',?,?)`).run(now, now);
  db.prepare(`INSERT INTO sleeve_recordings (id,title,artist_id,match_state,created_at,updated_at) VALUES ('recording','Song','artist','matched',?,?)`).run(now, now);
  db.prepare(`INSERT INTO sleeve_local_attachments (local_track_id,recording_id,title,artist,release_title,match_state,first_encountered_at,last_encountered_at,updated_at)
    VALUES ('track','recording','Song','Band','Album','matched',?,?,?)`).run(now, now, now);
  const insert = db.prepare(`INSERT INTO sleeve_claims (id,entity_type,entity_id,category,topic,wording,source_document_id,evidence,enabled,airtime_scope,matching_release_title,created_at,updated_at)
    VALUES (?,?,?,'artist-stories',?,'A recording story.','source','A recording story.',?,?,?, ?,?)`);
  insert.run('track-story','recording','recording','track-story',1,'general',null,now,now);
  insert.run('withdrawn','recording','recording','withdrawn',0,'general',null,now,now);
  insert.run('matching-album','artist','artist','matching-album',1,'matching-release-only','Album',now,now);
  insert.run('other-album','artist','artist','other-album',1,'matching-release-only','Other Album',now,now);
  const unprepared = {...current,sleeveClaimUseId:null,introScript:null};
  const read = () => liveNotesSummary({subsonic_id:'track',title:'Song',artist:'Band'},unprepared,null).onAir!;
  // The two artist notes match, but the previous artist airing blocks them;
  // the unplayed recording-level note is still available.
  assert.deepEqual(read().availability,{matchingCount:3,availableCount:1});
  db.prepare(`INSERT INTO sleeve_claim_uses (id,claim_id,local_track_id,entity_type,entity_id,category,topic,supplied_at)
    VALUES ('reserved','track-story','track','recording','recording','artist-stories','track-story',?)`).run(now);
  assert.deepEqual(read().availability,{matchingCount:3,availableCount:0});
  db.prepare("UPDATE sleeve_claim_uses SET released_at=? WHERE id='reserved'").run(now);
  assert.deepEqual(read().availability,{matchingCount:3,availableCount:1});
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM sleeve_claim_uses').get() as {n:number}).n,4,'reading counts must not reserve another Spark');
});
test('cached summaries remain read-only and never select or reserve another story', () => {
  close(); const before = readFileSync(DB_PATH);
  const summary = withCachedRead(() => liveNotesSummary({subsonic_id:'track',title:'Song',artist:'Band'},{...current,sleeveClaimUseId:null},next));
  assert.deepEqual(summary.onAir?.availability,{matchingCount:3,availableCount:1}); assert.deepEqual(readFileSync(DB_PATH),before);
  const counts = withCachedRead(() => open().prepare('SELECT COUNT(*) AS n FROM sleeve_claim_uses').get()); assert.deepEqual(counts,{n:4});
});
test.after(async () => { close(); await removeTempDir(root); });


test('live summary retains library navigation IDs without borrowing outgoing metadata',()=>{
 const item={...current,track:{...current.track,artistId:'artist-id',albumId:'album-id'}};
 const summary=liveNotesSummary({subsonic_id:'track',title:'Song'},item,item);
 assert.equal(summary.onAir?.track.artistId,'artist-id');
 assert.equal(summary.nextUp?.track.albumId,'album-id');
 assert.equal(liveNotesSummary({subsonic_id:'other'},item,null).onAir?.track.artistId,null);
});
