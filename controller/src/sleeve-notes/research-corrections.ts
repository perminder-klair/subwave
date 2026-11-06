// Operator biography corrections never rewrite canonical recording identities.
// Verification is durable, paced by WikipediaWorker, and does not admit LLM jobs.
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { researchOverrideSchema, type ResearchOverride, type ResearchVerification } from '../schemas/sleeve-notes-corrections.js';
import type { ResearchGapSnapshot } from '../schemas/sleeve-notes-research-gaps.js';

export function researchOverride(db: Database.Database, id: string): ResearchOverride | null {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='sleeve_artist_research_overrides'").get()) return null;
  const row=db.prepare('SELECT musicbrainz_id AS musicBrainzId,wikipedia_url AS wikipediaUrl FROM sleeve_artist_research_overrides WHERE artist_id=?').get(id) as {musicBrainzId:string|null;wikipediaUrl:string|null}|undefined;
  return row && (row.musicBrainzId || row.wikipediaUrl) ? {musicBrainzId:row.musicBrainzId??'',wikipediaUrl:row.wikipediaUrl??''} : null;
}

export function queueArtistRescan(db: Database.Database, id: string, now = new Date().toISOString()): void {
  const artist=db.prepare('SELECT musicbrainz_id AS mbid FROM sleeve_artists WHERE id=?').get(id) as {mbid:string|null}|undefined;
  const override=researchOverride(db,id);
  if (!artist) throw new Error('This artist is no longer in Sleeve Notes.');
  if (!artist.mbid && !override?.musicBrainzId && !override?.wikipediaUrl) throw new Error('Supply an artist identity or Wikipedia article first.');
  if (db.prepare("SELECT 1 FROM sleeve_research_jobs WHERE subject_type='artist' AND subject_id=? AND provider IN ('wikipedia','researcher') AND state='running'").get(id)) throw new Error('Research is running for this artist. Wait for it to finish before rescanning.');
  const pending=db.prepare("SELECT id FROM sleeve_research_jobs WHERE provider='wikipedia' AND subject_type='artist' AND subject_id=? AND capability='biography' AND state IN ('queued','retry-at')").get(id) as {id:string}|undefined;
  // A fresh collection must finish before extraction can resume from old text.
  db.prepare("UPDATE sleeve_research_jobs SET state='cancelled',run_after=NULL,operator_requested=0,updated_at=? WHERE subject_type='artist' AND subject_id=? AND provider='researcher' AND state IN ('queued','retry-at')").run(now,id);
  const extract=db.prepare("SELECT id FROM sleeve_research_jobs WHERE subject_type='artist' AND subject_id=? AND provider='researcher' AND capability='extract-wikipedia'").get(id) as {id:string}|undefined;
  if (extract) db.prepare('DELETE FROM sleeve_wikipedia_rescan_requests WHERE job_id=?').run(extract.id);
  if (pending) {
    db.prepare('UPDATE sleeve_research_jobs SET operator_requested=1,priority=MAX(priority,500) WHERE id=?').run(pending.id);
    return;
  }
  db.prepare(`INSERT INTO sleeve_research_jobs(id,provider,subject_type,subject_id,capability,state,priority,created_at,updated_at,operator_requested)
    VALUES(?,'wikipedia','artist',?,'biography','queued',500,?,?,1)
    ON CONFLICT(provider,subject_type,subject_id,capability) DO UPDATE SET state='queued',run_after=CASE WHEN run_after>excluded.updated_at THEN run_after ELSE NULL END,completed_at=NULL,attempts=0,operator_requested=1,priority=MAX(priority,500),updated_at=excluded.updated_at`).run(randomUUID(),id,now,now);
}

export function saveResearchOverride(db: Database.Database, id: string, input: ResearchOverride): {queued:boolean} {
  const parsed=researchOverrideSchema.parse(input), now=new Date().toISOString();
  return db.transaction(()=>{
    const artist=db.prepare('SELECT musicbrainz_id AS mbid FROM sleeve_artists WHERE id=?').get(id) as {mbid:string|null}|undefined;
    if (!artist) throw new Error('This artist is no longer in Sleeve Notes.');
    if (db.prepare("SELECT 1 FROM sleeve_research_jobs WHERE subject_type='artist' AND subject_id=? AND provider IN ('wikipedia','researcher') AND state='running'").get(id)) throw new Error('Research is running for this artist. Wait for it to finish before editing.');
    const old=researchOverride(db,id);
    const changed=(old?.musicBrainzId??'')!==parsed.musicBrainzId || (old?.wikipediaUrl??'')!==parsed.wikipediaUrl;
    if (changed) {
      db.prepare(`INSERT INTO sleeve_artist_research_overrides(artist_id,musicbrainz_id,wikipedia_url,updated_at) VALUES(?,?,?,?)
        ON CONFLICT(artist_id) DO UPDATE SET musicbrainz_id=excluded.musicbrainz_id,wikipedia_url=excluded.wikipedia_url,updated_at=excluded.updated_at`).run(id,parsed.musicBrainzId||null,parsed.wikipediaUrl||null,now);

      // Preserve provenance and operator decisions, but do not keep automatic
      // facts from the superseded biography eligible for speech.
      db.prepare(`UPDATE sleeve_claims SET enabled=0,updated_at=? WHERE entity_type='artist' AND entity_id=? AND operator_state='auto'
        AND source_document_id IN (SELECT id FROM sleeve_source_documents WHERE provider='wikipedia')`).run(now,id);
      db.prepare('DELETE FROM sleeve_artist_verification WHERE artist_id=?').run(id);
      db.prepare("UPDATE sleeve_research_jobs SET state='cancelled' WHERE subject_type='artist' AND subject_id=? AND provider='wikipedia' AND capability='biography' AND state IN ('queued','retry-at')").run(id);
    }
    if (!artist.mbid && !parsed.musicBrainzId && !parsed.wikipediaUrl) {
      db.prepare("UPDATE sleeve_research_jobs SET state='cancelled',operator_requested=0,updated_at=? WHERE subject_type='artist' AND subject_id=? AND provider IN ('wikipedia','researcher') AND state IN ('queued','retry-at')").run(now,id);
      db.prepare("DELETE FROM sleeve_wikipedia_rescan_requests WHERE job_id IN (SELECT id FROM sleeve_research_jobs WHERE subject_type='artist' AND subject_id=?)").run(id);
      return {queued:false};
    }
    queueArtistRescan(db,id,now);
    return {queued:true};
  }).immediate();
}

export function verificationReadout(db: Database.Database): ResearchVerification {
  const empty:ResearchVerification={state:'idle',total:0,checked:0,found:0,missing:0,failed:0,skipped:0,startedAt:null};
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='sleeve_library_verification'").get()) return empty;
  const scan=db.prepare('SELECT token,state,started_at AS startedAt,skipped FROM sleeve_library_verification WHERE id=1').get() as {token:string;state:ResearchVerification['state'];startedAt:string;skipped:number}|undefined;
  if (!scan) return empty;
  const counts=db.prepare('SELECT state,COUNT(*) AS n FROM sleeve_artist_verification WHERE scan_token=? GROUP BY state').all(scan.token) as Array<{state:string;n:number}>;
  const n=(state:string)=>counts.find(row=>row.state===state)?.n??0;
  const total=counts.reduce((sum,row)=>sum+row.n,0),checked=n('found')+n('missing')+n('failed');
  return {state:scan.state==='running'&&checked===total?'complete':scan.state,total,checked,found:n('found'),missing:n('missing'),failed:n('failed'),skipped:scan.skipped,startedAt:scan.startedAt};
}

export function startLibraryVerification(db: Database.Database, snapshot: ResearchGapSnapshot): ResearchVerification {
  return db.transaction(()=>{
    if (verificationReadout(db).state==='running') throw new Error('A library source scan is already running.');
    const token=randomUUID(),now=new Date().toISOString();
    const backoff=(db.prepare("SELECT MAX(run_after) AS at FROM sleeve_research_jobs WHERE provider='wikipedia' AND state='retry-at'").get() as {at:string|null}).at;
    const identities=new Map(snapshot.items.flatMap(item=>item.identities.map(identity=>[identity.id,identity] as const)));
    // The snapshot was computed asynchronously. Recheck identities against the
    // current database so a restore cannot leave orphaned scan entries.
    const current=new Map((db.prepare('SELECT id,musicbrainz_id AS mbid FROM sleeve_artists').all() as Array<{id:string;mbid:string|null}>).map(row=>[row.id,row]));
    const overrides=new Set((db.prepare('SELECT artist_id AS id FROM sleeve_artist_research_overrides WHERE musicbrainz_id IS NOT NULL OR wikipedia_url IS NOT NULL').all() as Array<{id:string}>).map(row=>row.id));
    const eligible=[...identities.values()].filter(identity=>current.has(identity.id) && (current.get(identity.id)?.mbid || overrides.has(identity.id)));
    const eligibleIds=new Set(eligible.map(artist=>artist.id));
    const skipped=snapshot.items.filter(item=>!item.identities.some(identity=>eligibleIds.has(identity.id))).length;
    db.prepare(`INSERT INTO sleeve_library_verification(id,token,state,started_at,skipped,next_step_at) VALUES(1,?,'running',?,?,?)
      ON CONFLICT(id) DO UPDATE SET token=excluded.token,state=excluded.state,started_at=excluded.started_at,skipped=excluded.skipped,next_step_at=MAX(COALESCE(next_step_at,''),COALESCE(excluded.next_step_at,''))`).run(token,now,skipped,backoff);
    const put=db.prepare(`INSERT INTO sleeve_artist_verification(artist_id,scan_token,state) VALUES(?,?,'queued')
      ON CONFLICT(artist_id) DO UPDATE SET scan_token=excluded.scan_token,state='queued',source_url=NULL,checked_at=NULL,last_error=NULL,attempts=0,run_after=NULL`);
    for (const artist of eligible) put.run(artist.id,token);
    return verificationReadout(db);
  }).immediate();
}

export function cancelLibraryVerification(db: Database.Database): ResearchVerification {
  if (verificationReadout(db).state!=='running') return verificationReadout(db);
  db.transaction(()=>{
    db.prepare("UPDATE sleeve_library_verification SET state='cancelled' WHERE id=1 AND state='running'").run();
    db.prepare("UPDATE sleeve_artist_verification SET state='cancelled' WHERE scan_token=(SELECT token FROM sleeve_library_verification WHERE id=1) AND state IN ('queued','retry-at','running')").run();
  }).immediate();
  return verificationReadout(db);
}
