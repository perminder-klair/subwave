import type Database from 'better-sqlite3';

/** Promotions affect eligible work only; provider backoff and broadcast gates remain authoritative. */
export function queuePromotion(db: Database.Database, id: string): string {
  return (db.prepare('SELECT requested_at AS at FROM sleeve_queue_promotions WHERE job_id=?').get(id) as {at:string}|undefined)?.at ?? '';
}

export function manageQueuedJob(db: Database.Database, id: string, action: 'top'|'cancel', now=new Date()): void {
  db.transaction(()=>{
    const review=id.startsWith('review:');
    const key=review?id.slice(7):id;
    const job=db.prepare(review?'SELECT state FROM sleeve_airing_reviews WHERE id=?':`SELECT state,
      EXISTS(SELECT 1 FROM sleeve_wikipedia_rescan_requests WHERE job_id=sleeve_research_jobs.id) AS rescan
      FROM sleeve_research_jobs WHERE id=?`).get(key) as {state:string;rescan?:number}|undefined;
    if(!job)throw new Error('Queued job not found');
    if(job.state==='running')throw new Error('This job is running; wait for its current step to finish');
    if(!(review?job.state==='queued':['queued','retry-at'].includes(job.state)||job.rescan))throw new Error('This job is no longer queued; refresh the queue');
    const at=now.toISOString();
    if(action==='top'){
      db.prepare('INSERT INTO sleeve_queue_promotions(job_id,requested_at) VALUES (?,?) ON CONFLICT(job_id) DO UPDATE SET requested_at=excluded.requested_at').run(id,at);
      return;
    }
    db.prepare('DELETE FROM sleeve_queue_promotions WHERE job_id=?').run(id);
    if(review){
      db.prepare("UPDATE sleeve_airing_reviews SET state='dismissed',lease_token=NULL,guidance_approved=0,updated_at=? WHERE id=?").run(at,key);
    }else{
      db.prepare("UPDATE sleeve_research_jobs SET state='cancelled',run_after=NULL,operator_requested=0,wikipedia_refresh_mode=NULL,updated_at=? WHERE id=?").run(at,key);
      db.prepare('DELETE FROM sleeve_wikipedia_rescan_requests WHERE job_id=?').run(key);
    }
  }).immediate();
}
