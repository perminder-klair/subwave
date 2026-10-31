import assert from 'node:assert/strict';
import test from 'node:test';
import {renderToStaticMarkup} from 'react-dom/server';
import type {ComponentProps} from 'react';
import {DjBehaviourSection} from '../components/admin/settings/DjBehaviourSection';
import {settingsForm} from '../components/admin/settings/form-state';
test('master switch is visible before Advanced and explains additional tokens and data retention',()=>{
 const props:ComponentProps<typeof DjBehaviourSection>={data:{},form:settingsForm({}),setForm:()=>{},busy:false,saveSettings:async()=>true,fieldErrors:{}};
 const html=renderToStaticMarkup(<DjBehaviourSection {...props}/>);
 assert.match(html,/Enable Extended Sleeve Notes/);
 assert.match(html,/2,000 additional tokens per track played/);
 assert.match(html,/paid LLM Provider/);
 assert.match(html,/Saved research is retained/);
 assert.doesNotMatch(html,/Open Sleeve Notes Settings/);
 const cardIndex=html.indexOf('data-card="extended-sleeve-notes"');
 const advancedIndex=html.indexOf('>Advanced</span>');
 assert.ok(cardIndex>=0 && advancedIndex>cardIndex);
 assert.doesNotMatch(html,/prompt memory and extended notes/);
});
