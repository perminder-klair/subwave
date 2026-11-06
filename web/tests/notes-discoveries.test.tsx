import assert from 'node:assert/strict';
import test from 'node:test';
import {renderToStaticMarkup} from 'react-dom/server';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import GeniusCaptureNotice from '../components/admin/connections/GeniusCaptureNotice';
import ExternalDiscoveries from '../components/admin/connections/ExternalDiscoveries';
test('discoveries render ranked artists with collapsed examples and refresh',()=>{
 const client=new QueryClient();
 client.setQueryData(['sleeve-notes','external-discoveries'],{allSavedRelationships:72859,calculatedAt:'2026-10-19T10:00:00Z',externalArtists:1,
 mostConnected:[{artist:'External',references:4,libraryArtists:2,sources:3,users:1,examples:[{artist:'Local',track:'Song',targetTrack:'Outside song',type:'samples'}]}],sampleSources:[],sampleUsers:[]});
 const html=renderToStaticMarkup(<QueryClientProvider client={client}><ExternalDiscoveries adminFetch={async()=>{throw Error('No network');}} timezone="Europe/London"/></QueryClientProvider>);
 assert.match(html,/Stats|Most connected/);assert.match(html,/2 library artists/);
 assert.match(html,/All saved relationships: <!-- -->72,859|All saved relationships: 72,859/);
 assert.match(html,/category=musical-connections/);
 assert.match(html,/Includes recordings outside your library/);
 assert.match(html,/Refresh/);assert.match(html,/Example connections/);
 assert.match(html,/tab=stories/);assert.doesNotMatch(html,/<details[^>]* open/);
 client.clear();
});

for(const state of [{enabled:false,configured:true},{enabled:false,configured:false},{enabled:true,configured:false}]) {
 test(`Station Brain explains Genius enabled=${state.enabled}, configured=${state.configured} without hiding saved discoveries`,()=>{
  const notice=renderToStaticMarkup(<GeniusCaptureNotice state={state}/>);
  assert.match(notice,state.enabled?/needs an API key/:/capture is off/);
  assert.match(notice,/browse your library and Wikipedia stories/);
  assert.match(notice,/Previously saved connections remain visible/);
  assert.match(notice,/tab=config/);
  const client=new QueryClient();
  const key=['sleeve-notes','external-discoveries'];
  client.setQueryData(key,{calculatedAt:'2026-10-18T12:00:00Z',externalArtists:0,mostConnected:[],sampleSources:[],sampleUsers:[]});
  const render=()=>renderToStaticMarkup(<QueryClientProvider client={client}><ExternalDiscoveries adminFetch={async()=>{throw Error('No network');}} genius={state}/></QueryClientProvider>);
  assert.match(render(),state.enabled?/Add a Genius API key/:/Enable Genius capture/);
  client.setQueryData(key,{calculatedAt:'2026-10-18T12:00:00Z',externalArtists:1,mostConnected:[{artist:'Saved artist',references:1,libraryArtists:1,sources:1,users:0,examples:[]}],sampleSources:[],sampleUsers:[]});
  assert.match(render(),/Saved artist/);
  client.clear();
 });
}
test('configured and enabled capture needs no disabled notice; unknown status makes no claim',()=>{
 assert.equal(renderToStaticMarkup(<GeniusCaptureNotice state={{enabled:true,configured:true}}/>),'');
 assert.equal(renderToStaticMarkup(<GeniusCaptureNotice/>),'');
});
