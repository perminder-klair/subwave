import { invalidateChangedLocalIdentity } from './local-identity.js';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { BRAIN_RESEARCH_PRIORITY, type BrainCoverage, type BrainLibrarySeed } from './brain-coverage.js';
import { connectionNameKey } from './library-connections.js';

const active = ['queued', 'retry-at', 'running'];
export type BrainAlbumType = 'release' | 'release-group' | 'library-album';
export type BrainAlbumSeed = { albumId: string; title: string; track: BrainLibrarySeed };
const hasRequests = (db: Database.Database) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='sleeve_brain_album_requests'").get();

function groupId(db: Database.Database, type: 'release' | 'release-group', id: string): string | null {
  return (db.prepare(`SELECT musicbrainz_release_group_id AS id FROM sleeve_releases WHERE ${type === 'release' ? 'id' : 'musicbrainz_release_group_id'}=? LIMIT 1`).get(id) as {id:string|null}|undefined)?.id ?? null;
}
export function brainAlbumGroupForTrackInDatabase(db: Database.Database, seed: BrainAlbumSeed): string | null {
  const key = (title: string) => { const value=connectionNameKey(title); return value.split(' ').length >= 5 ? value.replace(/^the /u,'') : value; };
  const rows=db.prepare(`SELECT DISTINCT release.title,release.musicbrainz_release_group_id AS id FROM sleeve_local_attachments local
    JOIN sleeve_recording_releases link ON link.recording_id=local.recording_id
    JOIN sleeve_releases release ON release.id=link.release_id
    WHERE local.local_track_id=? AND local.match_state='matched' AND release.musicbrainz_release_group_id IS NOT NULL`).all(seed.track.id) as Array<{title:string;id:string}>;
  const ids=new Set(rows.filter(row=>key(row.title)===key(seed.title)).map(row=>row.id));
  return ids.size===1?[...ids][0]:null;
}
export function queueBrainAlbumInDatabase(db: Database.Database, type: 'release' | 'release-group', id: string, now=new Date()): {queued:boolean;state:'queued'|'researching'} {
  const group=groupId(db,type,id);
  if(!group) throw new Error('This album has no confirmed MusicBrainz album identity yet. Select the album from your library to identify it.');
  return db.transaction(()=>{
    const jobs=db.prepare("SELECT state FROM sleeve_research_jobs WHERE subject_type='release' AND subject_id=? AND provider IN ('wikipedia','researcher','genius') AND capability IN ('release-group-biography','extract-wikipedia-release-group','album-biography','extract-genius-album')").all(group) as Array<{state:string}>;
    const running=jobs.filter(job=>active.includes(job.state));
    if(running.length){
      // Matching can enqueue the automatic job immediately before this handoff.
      // Reuse it, but preserve the manual request's first-play bypass and priority.
      db.prepare(`UPDATE sleeve_research_jobs SET operator_requested=1,priority=MAX(priority,?)
        WHERE subject_type='release' AND subject_id=? AND state IN ('queued','retry-at','running')
          AND provider IN ('wikipedia','researcher','genius')
          AND capability IN ('release-group-biography','extract-wikipedia-release-group','album-biography','extract-genius-album')`)
        .run(BRAIN_RESEARCH_PRIORITY,group);
      return {queued:false,state:running.some(job=>job.state==='running')?'researching' as const:'queued' as const};
    }
    const cached=!!db.prepare("SELECT 1 FROM sleeve_source_documents WHERE entity_type='release-group' AND entity_id=? AND provider='wikipedia' LIMIT 1").get(group);
    const provider=cached?'researcher':'wikipedia',capability=cached?'extract-wikipedia-release-group':'release-group-biography';
    db.prepare(`INSERT INTO sleeve_research_jobs (id,provider,subject_type,subject_id,capability,state,priority,attempts,operator_requested,created_at,updated_at)
      VALUES (?,?,'release',?,?,'queued',?,0,1,?,?) ON CONFLICT(provider,subject_type,subject_id,capability) DO UPDATE SET
      state='queued',priority=excluded.priority,attempts=0,run_after=NULL,completed_at=NULL,operator_requested=1,updated_at=excluded.updated_at`)
      .run(randomUUID(),provider,group,capability,BRAIN_RESEARCH_PRIORITY,now.toISOString(),now.toISOString());
    if(cached){
      const job=db.prepare("SELECT id FROM sleeve_research_jobs WHERE provider='researcher' AND subject_type='release' AND subject_id=? AND capability='extract-wikipedia-release-group'").get(group) as {id:string};
      db.prepare(`INSERT INTO sleeve_wikipedia_rescan_requests (job_id,encounter_count_at_request,requested_at,refresh_mode)
        VALUES (?,0,?,'replace') ON CONFLICT(job_id) DO NOTHING`).run(job.id,now.toISOString());
    }
    return {queued:true,state:'queued' as const};
  }).immediate();
}

export function queueBrainLibraryAlbumInDatabase(db: Database.Database, seed: BrainAlbumSeed, now=new Date()): {queued:boolean;state:'queued'|'researching'} {
  return db.transaction(()=>{
    invalidateChangedLocalIdentity(db,seed.track.id,{title:seed.track.title,artist:seed.track.artist,album:seed.title,mbid:seed.track.mbid},true);
    const group=brainAlbumGroupForTrackInDatabase(db,seed);
    if(group){
      const result=queueBrainAlbumInDatabase(db,'release-group',group,now);
      db.prepare(`INSERT INTO sleeve_brain_album_requests (local_album_id,local_track_id,title,release_group_id,state,requested_at)
        VALUES (?,?,?,?,'resolved',?) ON CONFLICT(local_album_id) DO UPDATE SET local_track_id=excluded.local_track_id,
        title=excluded.title,release_group_id=excluded.release_group_id,state='resolved',last_error=NULL,requested_at=excluded.requested_at`)
        .run(seed.albumId,seed.track.id,seed.title,group,now.toISOString());
      return result;
    }
    const previous=db.prepare("SELECT state FROM sleeve_brain_album_requests WHERE local_album_id=?").get(seed.albumId) as {state:string}|undefined;
    const job=db.prepare("SELECT state FROM sleeve_research_jobs WHERE provider='musicbrainz' AND subject_type='local-track' AND subject_id=? AND capability='match'").get(seed.track.id) as {state:string}|undefined;
    if(previous?.state==='waiting' && job && active.includes(job.state))return {queued:false,state:job.state==='running'?'researching' as const:'queued' as const};
    db.prepare(`INSERT INTO sleeve_brain_album_requests (local_album_id,local_track_id,title,state,requested_at)
      VALUES (?,?,?,'waiting',?) ON CONFLICT(local_album_id) DO UPDATE SET local_track_id=excluded.local_track_id,
      title=excluded.title,release_group_id=NULL,state='waiting',last_error=NULL,requested_at=excluded.requested_at`).run(seed.albumId,seed.track.id,seed.title,now.toISOString());
    db.prepare(`INSERT INTO sleeve_local_attachments (local_track_id,title,artist,release_title,musicbrainz_recording_id,match_state,first_encountered_at,last_encountered_at,updated_at)
      VALUES (?,?,?,?,?,'unmatched',?,?,?) ON CONFLICT(local_track_id) DO UPDATE SET title=excluded.title,artist=excluded.artist,
      release_title=excluded.release_title,musicbrainz_recording_id=COALESCE(excluded.musicbrainz_recording_id,sleeve_local_attachments.musicbrainz_recording_id),updated_at=excluded.updated_at`)
      .run(seed.track.id,seed.track.title,seed.track.artist,seed.title,seed.track.mbid,now.toISOString(),now.toISOString(),now.toISOString());
    if(!job || !active.includes(job.state))db.prepare(`INSERT INTO sleeve_research_jobs (id,provider,subject_type,subject_id,capability,state,priority,attempts,origin_local_track_id,created_at,updated_at)
      VALUES (?,'musicbrainz','local-track',?,'match','queued',?,0,?,?,?) ON CONFLICT(provider,subject_type,subject_id,capability) DO UPDATE SET
      state='queued',priority=excluded.priority,attempts=0,run_after=NULL,completed_at=NULL,updated_at=excluded.updated_at`)
      .run(randomUUID(),seed.track.id,BRAIN_RESEARCH_PRIORITY,seed.track.id,now.toISOString(),now.toISOString());
    else db.prepare("UPDATE sleeve_research_jobs SET priority=MAX(priority,?) WHERE provider='musicbrainz' AND subject_type='local-track' AND subject_id=? AND capability='match'").run(BRAIN_RESEARCH_PRIORITY,seed.track.id);
    return {queued:true,state:job?.state==='running'?'researching' as const:'queued' as const};
  }).immediate();
}

/** Called only after the existing quiet-time MusicBrainz match has completed. */
export function finishBrainAlbumMatchesInDatabase(db: Database.Database, localTrackId: string, matched: boolean): void {
  if(!hasRequests(db))return;
  const requests=db.prepare("SELECT local_album_id AS albumId,title FROM sleeve_brain_album_requests WHERE local_track_id=? AND state='waiting'").all(localTrackId) as Array<{albumId:string;title:string}>;
  for(const request of requests){
    const group=matched?brainAlbumGroupForTrackInDatabase(db,{...request,track:{id:localTrackId,title:'',artist:'',album:request.title,mbid:null}}):null;
    if(group)queueBrainAlbumInDatabase(db,'release-group',group);
    db.prepare('UPDATE sleeve_brain_album_requests SET release_group_id=?,state=?,last_error=? WHERE local_album_id=?')
      .run(group,group?'resolved':'failed',group?null:'The selected album could not be confirmed from this library track. No different album was substituted.',request.albumId);
  }
}

export function brainAlbumCoverageInDatabase(db: Database.Database, type: BrainAlbumType, id: string): BrainCoverage & {error:string|null} {
  const request=type==='library-album' && hasRequests(db)?db.prepare('SELECT release_group_id AS groupId,state,local_track_id AS trackId,last_error AS error FROM sleeve_brain_album_requests WHERE local_album_id=?').get(id) as {groupId:string|null;state:string;trackId:string;error:string|null}|undefined:undefined;
  const group=type==='library-album'?request?.groupId:groupId(db,type,id);
  const jobs=group?db.prepare(`SELECT state,provider,updated_at AS updatedAt,completed_at AS completedAt,
    EXISTS(SELECT 1 FROM sleeve_wikipedia_rescan_requests rescan WHERE rescan.job_id=job.id) AS rescan
    FROM sleeve_research_jobs job WHERE subject_type='release' AND subject_id=? AND capability IN ('release-group-biography','extract-wikipedia-release-group','album-biography','extract-genius-album')`).all(group) as Array<{state:string;provider:string;updatedAt:string;completedAt:string|null;rescan:number}>:[];
  if(request?.state==='waiting'){
    const match=db.prepare("SELECT state FROM sleeve_research_jobs WHERE provider='musicbrainz' AND subject_type='local-track' AND subject_id=? AND capability='match'").get(request.trackId) as {state:string}|undefined;
    if(match)jobs.push({state:match.state,provider:'musicbrainz',updatedAt:'',completedAt:null,rescan:0});
  }
  const usableStories=group?(db.prepare(`SELECT COUNT(*) AS n FROM sleeve_claims claim JOIN sleeve_source_documents source ON source.id=claim.source_document_id
    WHERE claim.enabled=1 AND length(trim(claim.wording))>0 AND length(trim(claim.evidence))>0 AND length(trim(source.source_url))>0
      AND ((claim.entity_type='release-group' AND claim.entity_id=?) OR (claim.entity_type='release' AND claim.entity_id IN
        (SELECT id FROM sleeve_releases WHERE musicbrainz_release_group_id=?)))`).get(group,group) as {n:number}).n:0;
  const running=jobs.some(job=>job.state==='running'),queued=jobs.some(job=>active.includes(job.state)||job.rescan);
  const completed=jobs.filter(job=>job.provider==='researcher'&&job.state==='complete'&&!job.rescan);
  const failed=request?.state==='failed'||jobs.some(job=>['failed','cancelled'].includes(job.state));
  return {state:running?'researching':queued?'queued':usableStories?'ready':completed.length?'empty':failed?'incomplete':'unexplored',
    usableStories,lastResearchedAt:completed.map(job=>job.completedAt??job.updatedAt).sort().at(-1)??null,
    canQueue:!queued && (type==='library-album'||!!group),hasResearchHistory:usableStories>0||completed.length>0||!!failed,error:request?.error??null};
}
