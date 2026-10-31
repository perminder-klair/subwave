import assert from 'node:assert/strict';
import test from 'node:test';
import {notesSettingsDefaults,notesSettingsPatch,notesSettingsSchema} from '../components/admin/notes-settings';
import {sleeveNotesPatchSchema} from '../lib/schemas.generated';
import {countLeafDiffs} from '../components/admin/settings/form-diff';

test('clean drafts preserve hidden credentials and do not post unrelated settings',()=>{
 const baseline=notesSettingsDefaults(undefined,'Default prompt');
 assert.deepEqual(notesSettingsPatch(baseline,baseline,'Default prompt'),{djBehaviour:{},sleeveNotes:{}});
 const draft={...baseline,geniusEnabled:false,segment:{...baseline.segment,cooldownMinutes:90}};
 const patch=notesSettingsPatch(draft,baseline,'Default prompt');
 assert.deepEqual(patch,{djBehaviour:{},sleeveNotes:{providers:{genius:{enabled:false}},segment:{cooldownMinutes:90}}});
 assert.equal(countLeafDiffs(draft,baseline),2);
 assert.equal(sleeveNotesPatchSchema.safeParse(patch.sleeveNotes).success,true);
});
test('token replacement and clearing require an explicit draft choice',()=>{
 const baseline=notesSettingsDefaults();
 assert.deepEqual(notesSettingsPatch({...baseline,token:' replacement '},baseline).sleeveNotes.providers?.genius,{accessToken:'replacement'});
 assert.deepEqual(notesSettingsPatch({...baseline,clearToken:true},baseline).sleeveNotes.providers?.genius,{accessToken:''});
 assert.equal(notesSettingsPatch(baseline,baseline).sleeveNotes.providers,undefined);
});
test('restoring the default prompt removes the custom override only on save',()=>{
 const baseline={...notesSettingsDefaults(),prompt:'Custom prompt'};
 assert.deepEqual(notesSettingsPatch({...baseline,prompt:'Default prompt'},baseline,'Default prompt').sleeveNotes.wikipedia,{extractPrompt:''});
 assert.equal(baseline.prompt,'Custom prompt');
});
test('pending values validate limits and segment settings before saving',()=>{
 const baseline=notesSettingsDefaults();
 assert.equal(notesSettingsSchema.safeParse(baseline).success,true);
 for(const artistClaimLimit of [0,21,1.5,NaN]) assert.equal(notesSettingsSchema.safeParse({...baseline,artistClaimLimit}).success,false);
 assert.equal(notesSettingsSchema.safeParse({...baseline,segment:{...baseline.segment,cooldownMinutes:0}}).success,false);
});
