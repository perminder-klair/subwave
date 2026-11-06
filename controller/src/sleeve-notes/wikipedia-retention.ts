import type Database from 'better-sqlite3';
import * as settings from '../settings.js';

export const WIKIPEDIA_ARTICLE_RETENTION_MS=24*60*60*1000;

/** Keep exact evidence and the same nearby context that operator reviews use. */
export function compactWikipediaEvidence(content:string,evidence:readonly string[]):string|null {
  const ranges:Array<{start:number;end:number}>=[];
  for(const passage of new Set(evidence)) {
    if(!passage.trim())continue;
    const at=content.indexOf(passage);
    // Never discard an article if an existing citation cannot be preserved exactly.
    if(at<0)return null;
    const start=Math.max(0,at-500);
    ranges.push({start,end:Math.max(at+passage.length,Math.min(content.length,start+2400))});
  }
  ranges.sort((a,b)=>a.start-b.start);
  const merged:Array<{start:number;end:number}>=[];
  for(const range of ranges) {
    const previous=merged.at(-1);
    if(previous&&range.start<=previous.end)previous.end=Math.max(previous.end,range.end);
    else merged.push({...range});
  }
  const retained='<!-- subwave-wikipedia-source-format:2 -->\n<!-- subwave-wikipedia-evidence-only:1 -->\n'
    +merged.map(range=>content.slice(range.start,range.end)).join('\n\n[... omitted article text ...]\n\n');
  return Buffer.byteLength(retained)<Buffer.byteLength(content)?retained:content;
}

/** Bounded synchronous maintenance, called only inside the shared quiet/restore gate. */
export function pruneCompletedWikipediaArticlesInDatabase(db:Database.Database,limit=10,sourceId?:string,now=new Date()):number {
  const behaviour=settings.get().djBehaviour;
  if(!behaviour.extendedSleeveNotes||behaviour.sleeveNotesCollectionPaused)return 0;
  return db.transaction(()=>{
    const rows=db.prepare(`SELECT source.id,source.content FROM sleeve_source_documents source
      WHERE source.provider='wikipedia' AND source.wikipedia_pruned_at IS NULL
        AND (? IS NULL OR source.id=?)
        AND (source.wikipedia_completed_at<=? OR EXISTS (
          SELECT 1 FROM sleeve_wikipedia_scan_progress scan
          JOIN sleeve_research_jobs job ON job.id=scan.job_id
          WHERE scan.source_document_id=source.id AND job.state='complete'
            AND scan.next_chunk>=scan.chunk_count AND job.completed_at<=?))
        AND NOT EXISTS (SELECT 1 FROM sleeve_wikipedia_scan_progress scan
          WHERE scan.source_document_id=source.id AND scan.next_chunk<scan.chunk_count)
        AND NOT EXISTS (SELECT 1 FROM sleeve_research_jobs job
          WHERE job.subject_id=source.entity_id AND job.subject_type=CASE source.entity_type WHEN 'artist' THEN 'artist' ELSE 'release' END
            AND job.provider IN ('researcher','wikipedia') AND job.state IN ('queued','retry-at','running','failed'))
        AND NOT EXISTS (SELECT 1 FROM sleeve_wikipedia_rescan_requests request
          JOIN sleeve_research_jobs job ON job.id=request.job_id WHERE job.subject_id=source.entity_id)
        AND NOT EXISTS (SELECT 1 FROM sleeve_wikipedia_refresh_plan plan WHERE source.retrieved_at<=plan.requested_at
          AND NOT EXISTS (SELECT 1 FROM sleeve_research_jobs refreshed WHERE refreshed.provider='researcher'
            AND refreshed.subject_id=source.entity_id AND refreshed.subject_type=CASE source.entity_type WHEN 'artist' THEN 'artist' ELSE 'release' END
            AND refreshed.wikipedia_refreshed_at>=plan.requested_at))
        AND NOT EXISTS (SELECT 1 FROM sleeve_moderation_candidates candidate
          WHERE candidate.source_document_id=source.id AND candidate.status='pending')
        AND NOT EXISTS (SELECT 1 FROM sleeve_claims claim WHERE claim.source_document_id=source.id
          AND length(trim(claim.evidence))>0 AND instr(source.content,claim.evidence)=0)
        AND NOT EXISTS (SELECT 1 FROM sleeve_moderation_candidates candidate WHERE candidate.source_document_id=source.id
          AND length(trim(candidate.evidence))>0 AND instr(source.content,candidate.evidence)=0)
        AND NOT EXISTS (SELECT 1 FROM sleeve_airing_reviews review,json_each(review.context_json,'$.sparks') spark
          JOIN sleeve_claims claim ON claim.id=json_extract(spark.value,'$.claimId')
          WHERE review.state IN ('queued','running','ready') AND claim.source_document_id=source.id)
      ORDER BY source.retrieved_at,source.id LIMIT ?`).all(sourceId??null,sourceId??null,new Date(now.getTime()-WIKIPEDIA_ARTICLE_RETENTION_MS).toISOString(),new Date(now.getTime()-WIKIPEDIA_ARTICLE_RETENTION_MS).toISOString(),Math.max(1,Math.min(10,limit))) as Array<{id:string;content:string}>;
    let cleared=0;
    for(const source of rows) {
      const evidence=db.prepare(`SELECT evidence FROM sleeve_claims WHERE source_document_id=?
        UNION SELECT evidence FROM sleeve_moderation_candidates WHERE source_document_id=?`)
        .all(source.id,source.id) as Array<{evidence:string}>;
      const retained=compactWikipediaEvidence(source.content,evidence.map(row=>row.evidence));
      if(retained===null)continue;
      db.prepare('UPDATE sleeve_source_documents SET content=?,wikipedia_pruned_at=? WHERE id=?')
        .run(retained,now.toISOString(),source.id);
      cleared++;
    }
    return cleared;
  }).immediate();
}
