import assert from 'node:assert/strict';
import test from 'node:test';
import {renderToStaticMarkup} from 'react-dom/server';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import DashSleeveNotes,{shuffled} from '../components/admin/dash/DashSleeveNotes';
const fetcher=async()=>{throw Error('No network');};
test('shuffle visits every saved item once without changing the input',()=>{
 const original=['one','two','three','four'];
 const result=shuffled(original);
 assert.deepEqual([...result].sort(),original.slice().sort());
 assert.equal(new Set(result).size,original.length);
 assert.deepEqual(original,['one','two','three','four']);
});
test('enabled empty shelf keeps its space and disabled shelf is absent',()=>{
 const client=new QueryClient();
 const render=()=>renderToStaticMarkup(<QueryClientProvider client={client}><DashSleeveNotes adminFetch={fetcher} trackId="track"/></QueryClientProvider>);
 client.setQueryData(['sleeve-notes','dash-stories','track'],{enabled:true,trackId:'track',artistId:'artist-id',items:[]});
 const html=render();
 assert.match(html,/focusType=library-artist&amp;focusId=artist-id/);
 assert.doesNotMatch(html,/Explore in Station Brain|Source ↗/);
 assert.match(html,/Sleeve Notes/);assert.match(html,/h-\[82px\]/);
 assert.match(html,/No Sleeve Notes saved for this track yet/);
 assert.doesNotMatch(html,/Flag this saved Spark/);
 client.setQueryData(['sleeve-notes','dash-stories','track'],{enabled:false,trackId:null,items:[]});
 assert.equal(render(),'');client.clear();
});
