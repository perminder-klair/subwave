import {createTempDir, removeTempDir} from './test-utils/temp-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const root=createTempDir(join(tmpdir(),'subwave-notes-settings-'));process.env.STATE_DIR=root;
const settings=await import('../src/settings.js');
const store=await import('../src/settings/store.js');
await settings.load();const defaults=settings.get();

test('legacy and malformed master settings load safely; both switches survive save and cold reload in both directions',async()=>{
 for(const value of [undefined,null,0,'true',{}]) {
  writeFileSync(join(root,'settings.json'),JSON.stringify({...defaults,djBehaviour:{...defaults.djBehaviour,
   extendedSleeveNotes:value,sleeveNotesCollectionPaused:value,sleeveNotesMaintenanceWhenEmpty:value}}));
  store.setCache(null);await settings.load();
  assert.equal(settings.get().djBehaviour.extendedSleeveNotes,false);
  assert.equal(settings.get().djBehaviour.sleeveNotesCollectionPaused,false);
  assert.equal(settings.get().djBehaviour.sleeveNotesMaintenanceWhenEmpty,false);
 }
 for(const [master,paused] of [[true,true],[false,true],[true,false],[false,false]]) {
  await settings.update({djBehaviour:{extendedSleeveNotes:master,sleeveNotesCollectionPaused:paused}});
  store.setCache(null);await settings.load();
  assert.equal(settings.get().djBehaviour.extendedSleeveNotes,master);
  assert.equal(settings.get().djBehaviour.sleeveNotesCollectionPaused,paused);
 }
});

test('Genius credentials stay redacted and survive settings round trips without altering unrelated settings',async()=>{
 const token='synthetic-genius-test-token';
 const before=settings.get();
 await settings.update({sleeveNotes:{providers:{genius:{enabled:true,accessToken:token}}}});
 const redacted=store.getRedacted();
 assert.equal(redacted.sleeveNotes.providers.genius.accessToken,'set');
 assert.equal(settings.get().sleeveNotes.providers.genius.accessToken,token,'redaction must not mutate the stored token');
 await settings.update({djBehaviour:{extendedSleeveNotes:true},sleeveNotes:{providers:{genius:{accessToken:'set'}}}});
 store.setCache(null);await settings.load();
 assert.equal(settings.get().sleeveNotes.providers.genius.accessToken,token,'saving a redacted settings form must preserve the credential');
 assert.deepEqual(settings.get().tts,before.tts);
 assert.equal(settings.get().crossfadeDuration,before.crossfadeDuration);
 assert.equal(settings.get().djBehaviour.showWelcome,before.djBehaviour.showWelcome);
 await settings.update({sleeveNotes:{providers:{genius:{accessToken:''}}}});
 store.setCache(null);await settings.load();
 assert.equal(settings.get().sleeveNotes.providers.genius.accessToken,'');
 assert.equal(store.getRedacted().sleeveNotes.providers.genius.accessToken,'');
});

test.after(async ()=>await removeTempDir(root));
