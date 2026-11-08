// One durable external check per quiet minute, using the biography client. No
// full article retention or extraction: results describe source reachability,
// never proof that a same-name artist is the right artist.
import { open } from './db.js';
import { researchOverride } from './research-corrections.js';
import * as repository from './research-repository.js';
import * as wikipedia from './wikipedia.js';
import * as settings from '../settings.js';
import { librarySourceKey } from './local-identity.js';

export async function verifyNextArtistSource(sources: Pick<typeof wikipedia,'fetchWikipediaArtistDocument'>): Promise<boolean> {
  const db=open(),now=new Date().toISOString();
  const pacing=db.prepare('SELECT last_step_at AS at,next_step_at AS next FROM sleeve_library_verification WHERE id=1').get() as {at:string|null;next:string|null}|undefined;
  if (pacing?.next && pacing.next>now || pacing?.at && Date.parse(pacing.at)>Date.now()-60_000) return false;
  const row=db.prepare(`SELECT item.artist_id AS id,item.scan_token AS token,item.attempts,artist.musicbrainz_id AS mbid
    FROM sleeve_artist_verification item JOIN sleeve_artists artist ON artist.id=item.artist_id
    JOIN sleeve_library_verification scan ON scan.token=item.scan_token AND scan.state='running'
    WHERE item.state IN ('queued','retry-at','running') AND (item.run_after IS NULL OR item.run_after<=?)
    ORDER BY item.artist_id LIMIT 1`).get(now) as {id:string;token:string;attempts:number;mbid:string|null}|undefined;
  if (!row) return false;
  db.prepare('UPDATE sleeve_library_verification SET last_step_at=? WHERE id=1').run(now);
  const override=researchOverride(db,row.id),fingerprint=JSON.stringify(override),sourceKey=librarySourceKey();
  db.prepare("UPDATE sleeve_artist_verification SET state='running',attempts=attempts+1,run_after=? WHERE artist_id=?").run(new Date(Date.now()+5*60_000).toISOString(),row.id);
  const request=repository.startProviderRequest({provider:'wikipedia',capability:'verify-biography'});
  const current=()=> settings.get().djBehaviour.extendedSleeveNotes && sourceKey===librarySourceKey()
    && JSON.stringify(researchOverride(db,row.id))===fingerprint && !!db.prepare(`SELECT 1 FROM sleeve_artist_verification item JOIN sleeve_library_verification scan ON scan.token=item.scan_token
      WHERE item.artist_id=? AND item.scan_token=? AND item.state='running' AND scan.state='running'`).get(row.id,row.token);
  try {
    const document=await sources.fetchWikipediaArtistDocument(override?.musicBrainzId || row.mbid || '',override?.wikipediaUrl || undefined,{metadataOnly:true});
    repository.finishProviderRequest(request,document?'ready':'no-match',null);
    if (!current()) return true;
    db.prepare('UPDATE sleeve_artist_verification SET state=?,source_url=?,checked_at=?,run_after=NULL,last_error=NULL WHERE artist_id=?')
      .run(document?'found':'missing',document?.url??null,new Date().toISOString(),row.id);
  } catch(error) {
    const message=error instanceof Error?error.message:'Source lookup failed';
    const status=Number(message.match(/HTTP\s+(\d{3})/i)?.[1])||null;
    repository.finishProviderRequest(request,status===429?'rate-limited':'failed',status);
    if (!current()) return true;
    const delay=repository.wikipediaOutageDelay(row.attempts+1);
    db.prepare('UPDATE sleeve_artist_verification SET state=?,last_error=?,checked_at=?,run_after=? WHERE artist_id=?')
      .run(row.attempts>=2?'failed':'retry-at',message.slice(0,300),new Date().toISOString(),new Date(Date.now()+delay).toISOString(),row.id);
    // An outage applies to the service, not just this artist. Avoid walking the
    // whole library while it is unavailable; ordinary collection also backs off.
    db.prepare(`UPDATE sleeve_artist_verification SET run_after=? WHERE scan_token=? AND state IN ('queued','retry-at')`).run(new Date(Date.now()+delay).toISOString(),row.token);
    repository.deferWikipediaResearchJobs(delay);
  }
  return true;
}
