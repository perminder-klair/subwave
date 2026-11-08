import type Database from 'better-sqlite3';
import {connectionNameKey,connectionArtistVariantKey} from './library-connections.js';

export function externalDiscoveriesInDatabase(db: Database.Database) {
  const local = new Set((db.prepare('SELECT name_key FROM sleeve_connection_library_artists').all() as {name_key:string}[]).map(row=>row.name_key));
  // Display-only membership fallback: punctuation variants must identify one
  // library name. This never establishes a recording match or merges identities.
  const displayKey=connectionArtistVariantKey;
  const variants=new Map<string,Set<string>>();
  for(const name of local){
    const key=displayKey(name);
    if(!key)continue;
    const names=variants.get(key)??new Set<string>();names.add(name);variants.set(key,names);
  }
  const localName=(name:string)=>{
    const exact=connectionNameKey(name);
    if(local.has(exact))return exact;
    const matches=variants.get(displayKey(name));
    return matches?.size===1?[...matches][0]:null;
  };
  const rows=db.prepare(`SELECT e.source_recording_id AS recordingId, e.relationship_type AS type,
    e.target_provider_id AS targetId, e.target_artist AS artist, e.target_title AS title,
    s.name AS sourceArtist, r.title AS sourceTitle, c.source_document_id AS sourceId
    FROM sleeve_connection_edges e JOIN sleeve_claims c ON c.id=e.claim_id
    JOIN sleeve_recordings r ON r.id=e.source_recording_id JOIN sleeve_artists s ON s.id=r.artist_id
    WHERE c.enabled=1 AND c.evidence=e.claim_evidence AND e.target_kind='recording'
    ORDER BY c.updated_at DESC`).all() as Array<{recordingId:string;type:string;targetId:string;artist:string;title:string;sourceArtist:string;sourceTitle:string;sourceId:string}>;
  const groups=new Map<string,{artist:string;references:number;libraryArtists:Set<string>;sources:number;users:number;examples:Array<{artist:string;track:string;targetTrack:string;type:string}>;seen:Set<string>}>();
  for(const row of rows){
    const key=connectionNameKey(row.artist),sourceKey=localName(row.sourceArtist);
    // Only connections directly from an artist in the local catalogue count.
    if(!key||localName(row.artist)||!sourceKey)continue;
    let group=groups.get(key);
    if(!group){group={artist:row.artist,references:0,libraryArtists:new Set(),sources:0,users:0,examples:[],seen:new Set()};groups.set(key,group);}
    const identity=JSON.stringify([row.recordingId,row.type,row.targetId]);
    if(group.seen.has(identity))continue;
    group.seen.add(identity);group.references++;group.libraryArtists.add(sourceKey);
    if(row.type==='samples')group.sources++;
    if(row.type==='sampled_in')group.users++;
    if(group.examples.filter(example=>example.type===row.type).length<3)group.examples.push({artist:row.sourceArtist,track:row.sourceTitle,targetTrack:row.title,type:row.type});
  }
  const entries=[...groups.values()].map(({seen:_seen,libraryArtists,...entry})=>({...entry,libraryArtists:libraryArtists.size}));
  const rank=(field:'libraryArtists'|'sources'|'users')=>entries.filter(row=>row[field]>0).sort((a,b)=>b[field]-a[field]||b.references-a.references||a.artist.localeCompare(b.artist)).slice(0,20);
  const allSavedRelationships=(db.prepare("SELECT COUNT(*) AS count FROM sleeve_claims WHERE enabled=1 AND category='musical-connections'").get() as {count:number}).count;
  return {allSavedRelationships,calculatedAt:new Date().toISOString(),externalArtists:entries.length,mostConnected:rank('libraryArtists'),sampleSources:rank('sources'),sampleUsers:rank('users')};
}
