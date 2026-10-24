import {createTempDir, removeTempDir} from './test-utils/temp-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = createTempDir(join(tmpdir(), 'subwave-series-config-'));
process.env.STATE_DIR = root;
delete process.env.ADMIN_USER; delete process.env.ADMIN_PASS;
const { open, close } = await import('../src/sleeve-notes/db.js');
const store = await import('../src/sleeve-notes/series-catalog-store.js');
const settings=await import('../src/settings.js');
await settings.update({djBehaviour:{extendedSleeveNotes:true}});
const repository = await import('../src/sleeve-notes/research-repository.js');
const { DEFAULT_MUSICBRAINZ_SERIES } = await import('../src/sleeve-notes/musicbrainz-series-catalog.js');
const { loadExtendedSleeveNoteCandidatesInDatabase,countExtendedSleeveNoteCandidatesInDatabase } = await import('../src/sleeve-notes/link-selection.js');
const { router } = await import('../src/routes/sleeve-notes.js');
const db = open();
const app = express(); app.use(express.json(), router);
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const address = server.address(); if (!address || typeof address === 'string') throw new Error('No address');
const base = `http://127.0.0.1:${address.port}`;
const custom = '11111111-1111-4111-8111-111111111111';
const unsupported = '22222222-2222-4222-8222-222222222222';
const member = '33333333-3333-4333-8333-333333333333';
const originalFetch = globalThis.fetch;
let providerCalls = 0;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.origin === base) return originalFetch(input, init);
  if (url.hostname !== 'musicbrainz.org') throw new Error('Unexpected provider request');
  providerCalls++;
  const id = url.pathname.split('/').at(-1);
  return new Response(JSON.stringify({ id, name: 'Custom recording list', type: id === unsupported ? 'Work series' : 'Recording series', relations: [
    { recording: { id: member, title: 'First Song' }, 'attribute-values': { number: '12' } },
  ] }), { headers: { 'Content-Type': 'application/json' } });
}) as typeof fetch;
const request = async (path: string, body?: unknown, status = 200) => {
  const response = await fetch(`${base}/sleeve-notes/series${path}`, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)});
  assert.equal(response.status, status, await response.clone().text());
  return await response.json() as { lists: Array<{ id: string; enabled: boolean }>; checkId: string; existing?: { id: string }; error?: string };
};
test('default switches persist through seeding, cold opening and refresh reservation', async () => {
  assert.equal((await request('')).lists.length, DEFAULT_MUSICBRAINZ_SERIES.length);
  const ids = DEFAULT_MUSICBRAINZ_SERIES.map((item) => item.id);
  await request('/configure', { ids, enabled: false });
  store.seedSuppliedSeries(db);
  assert.equal(repository.reserveDueMusicBrainzSeries(), null);
  assert.equal(store.activeSeriesMap(db).size, 0);
  const second = new (await import('better-sqlite3')).default(join(root, 'sleeve-notes.db'), { readonly: true });
  assert.equal(store.activeSeriesMap(second).size, 0); second.close();
  assert.equal(providerCalls, 0);
});
test('check/add uses verified metadata, detects duplicates and refuses unsupported types or arbitrary URLs', async () => {
  await request('/check', { input: 'https://example.test/series/' + custom }, 400);
  const duplicate = await request('/check', { input: DEFAULT_MUSICBRAINZ_SERIES[0].id });
  assert.equal(duplicate.existing?.id, DEFAULT_MUSICBRAINZ_SERIES[0].id);
  const preview = await request('/check', { input: `https://musicbrainz.org/series/${custom}` });
  await request('', { checkId: preview.checkId, ranked: false, name: 'Invented title', entityType: 'work' }, 201);
  assert.equal(store.activeSeriesMap(db).get(custom)?.label, 'Custom recording list');
  assert.equal(repository.reserveDueMusicBrainzSeries()?.id, custom);
  await request('/check', { input: unsupported }, 400);
  await request('', { checkId: 'invented', ranked: false }, 400);
});
test('custom cached membership supplies Sparks, ranking is explicit, disabling/removing defeats matching and in-flight refreshes', async () => {
  const definition = store.activeSeriesMap(db).get(custom)!;
  repository.retainMusicBrainzSeriesSnapshot(definition, { id: custom, name: definition.label, type: 'Recording series', members: [{ id: member, title: 'First Song', rank: '12' }] });
  repository.retainLibrarySeriesClaims({ localAlbumId: 'album', releaseGroupMbid: null, songs: [{ id: 'song', musicBrainzId: member }] });
  const candidates = () => loadExtendedSleeveNoteCandidatesInDatabase(db, 'song', 'Artist');
  assert.match(candidates()[0].wording, /was included in/);
  await request('/configure', { ids: [custom], ranked: true });
  assert.match(candidates()[0].wording, /ranked number 12/);
  await request('/configure', { ids: [custom], enabled: false });
  assert.equal(candidates().length, 0);
  repository.retainMusicBrainzSeriesSnapshot(definition, { id: custom, name: definition.label, type: 'Recording series', members: [{ id: member, title: 'Changed Song', rank: '1' }] });
  repository.retainLibrarySeriesClaims({ localAlbumId: 'album', releaseGroupMbid: null, songs: [{ id: 'song', musicBrainzId: member }] });
  assert.equal(candidates().length, 0);
  assert.equal((db.prepare('SELECT entity_title AS title FROM sleeve_musicbrainz_series_members WHERE series_mbid = ?').get(custom) as { title: string }).title, 'First Song');
  await request('/configure', { ids: [custom], enabled: true });
  assert.match(candidates()[0].wording, /ranked number 12/);
  const claim = candidates()[0].claimId;
  await request('/configure', { ids: [custom], removed: true });
  assert.equal(candidates().length, 0);
  assert.ok(db.prepare('SELECT 1 FROM sleeve_claims WHERE id = ?').get(claim));
  assert.equal((await request('')).lists.some((item) => item.id === custom), false);
  await request('/configure', { ids: [DEFAULT_MUSICBRAINZ_SERIES[0].id], removed: true }, 400);
});
test('1001 editions fold to the earliest enabled edition, including cached disable/re-enable', async () => {
  const editions = DEFAULT_MUSICBRAINZ_SERIES.filter((item) => item.editionGroup === '1001-albums').slice(0, 2);
  await request('/configure', { ids: editions.map((item) => item.id), enabled: true });
  for (const definition of editions) repository.retainMusicBrainzSeriesSnapshot(definition, { id: definition.id, name: definition.label, type: 'Release group series', members: [{ id: member, title: 'First Album', rank: null }] });
  repository.retainLibrarySeriesClaims({ localAlbumId: 'album2', releaseGroupMbid: member, songs: [{ id: 'song2', musicBrainzId: null }] });
  const candidates = () => loadExtendedSleeveNoteCandidatesInDatabase(db, 'song2', 'Artist');
  assert.equal(candidates().length, 1); assert.match(candidates()[0].wording, /2005/);
  await request('/configure', { ids: [editions[0].id], enabled: false });
  assert.equal(candidates().length, 1); assert.match(candidates()[0].wording, /2008/);
  await request('/configure', { ids: [editions[0].id], enabled: true });
  assert.equal(candidates().length, 1); assert.match(candidates()[0].wording, /2005/);
});
test('series cooldown finds confirmed airings on another recording through retained sources',async()=>{
 const definition=DEFAULT_MUSICBRAINZ_SERIES.find(item=>item.entityType==='recording')!;
 await request('/configure',{ids:[definition.id],enabled:true});
 const other='44444444-4444-4444-8444-444444444444';
 repository.retainMusicBrainzSeriesSnapshot(definition,{id:definition.id,name:definition.label,type:'Recording series',members:[
  {id:member,title:'First',rank:'1'},{id:other,title:'Second',rank:'2'}]});
 repository.retainLibrarySeriesClaims({localAlbumId:'cooldown-first',releaseGroupMbid:null,songs:[{id:'cooldown-first',musicBrainzId:member}]});
 repository.retainLibrarySeriesClaims({localAlbumId:'cooldown-second',releaseGroupMbid:null,songs:[{id:'cooldown-second',musicBrainzId:other}]});
 const note=loadExtendedSleeveNoteCandidatesInDatabase(db,'cooldown-first','First Artist')[0];
 const now=Date.now(),at=new Date(now).toISOString();
 db.prepare(`INSERT INTO sleeve_claim_uses(id,claim_id,entity_type,entity_id,category,topic,local_track_id,supplied_at,aired_at,detection_status)
 VALUES ('series-cooldown',?,?,?,?,?,'cooldown-first',?,?,'detected')`).run(note.claimId,note.entityType,note.entityId,note.category,note.topic,at,at);
 const available=(time=now)=>countExtendedSleeveNoteCandidatesInDatabase(db,'cooldown-second','Second Artist',time).availableCount;
 assert.equal(available(),0);
 db.prepare("UPDATE sleeve_claim_uses SET detection_status='not-detected' WHERE id='series-cooldown'").run();
 assert.equal(available(),1);
 db.prepare("UPDATE sleeve_claim_uses SET detection_status='detected',aired_at=NULL,released_at=? WHERE id='series-cooldown'").run(at);
 assert.equal(available(),1);
 db.prepare("UPDATE sleeve_claim_uses SET aired_at=? WHERE id='series-cooldown'").run(at);
 assert.equal(available(now+6*60*60*1000),1);
});

test.after(async () => {
  globalThis.fetch = originalFetch;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  close(); await removeTempDir(root);
});
