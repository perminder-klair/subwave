import type Database from 'better-sqlite3';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import { getSession } from '../broadcast/session.js';
import { createSessionArchiveReader } from '../util/session-archives.js';
import { withCachedRead, open } from './db.js';

type Item = Record<string,unknown>;
type Turn = {text:string;at:string;ids:string[];speakerId:string;speakerName:string};
const archives=createSessionArchiveReader(config.session.dir);

/** Old segment lines lack a group ID. Recover only an unambiguous, confirmed
 * broadcast block anchored to its actual claim-use IDs and one supply batch. */
export function recoverLegacySegmentConversations(db:Database.Database,items:Item[],sessions:unknown[]):void {
  const wanted=items.filter(item=>item.consumer==='sleeveNotesSegment'&&!item.conversation);
  if(!wanted.length)return;
  for(const raw of sessions) {
    const messages=(raw as {messages?:unknown[]}|null)?.messages;
    if(!Array.isArray(messages))continue;
    let block:Turn[]=[];
    const flush=()=>{
      const turns=block;block=[];
      if(!turns.length||turns.length>12)return;
      const ids=[...new Set(turns.flatMap(turn=>turn.ids))];
      const targets=wanted.filter(item=>!item.conversation&&ids.includes(String(item.id)));
      if(!targets.length||ids.length>4)return;
      const uses=db.prepare(`SELECT id,claim_id AS claimId,consumer,local_track_id AS track,supplied_at AS at,aired_at AS airedAt,tts_text AS text
        FROM sleeve_claim_uses WHERE id IN (${ids.map(()=>'?').join(',')})`).all(...ids) as Array<{id:string;claimId:string;consumer:string;track:string;at:string;airedAt:string|null;text:string|null}>;
      if(uses.length!==ids.length||uses.some(use=>use.consumer!=='sleeveNotesSegment'||use.track!==uses[0].track))return;
      if(new Set(uses.map(use=>use.claimId)).size!==uses.length)return;
      if(uses.some(use=>!turns.some(turn=>turn.ids.includes(use.id)&&turn.at===use.airedAt&&turn.text===use.text)))return;
      const times=uses.map(use=>Date.parse(use.at));
      // Offers are written together in a synchronous loop. Distinct runs must
      // never be joined merely because both happened during the same track.
      if(times.some(time=>!Number.isFinite(time))||Math.max(...times)-Math.min(...times)>1000)return;
      for(const item of targets) {
        if(!turns.some(turn=>turn.ids.includes(String(item.id))&&turn.at===item.airedAt))continue;
        item.conversation={id:`legacy:${[...ids].sort()[0]}`,useIds:ids,expectedLines:null,complete:null,
          lines:turns.map((turn,lineIndex)=>({lineIndex,speakerId:turn.speakerId,speakerName:turn.speakerName,text:turn.text,airedAt:turn.at}))};
      }
    };
    for(const value of messages) {
      if(!value||typeof value!=='object') {flush();continue;}
      const turn=value as {role?:unknown;kind?:unknown;text?:unknown;meta?:Record<string,unknown>};
      if(turn.role!=='segment') {if(turn.role==='track')flush();continue;}
      const meta=turn.meta;
      if(turn.kind!=='sleeve-notes'||typeof turn.text!=='string'||!meta||meta.sleeveNotesSegment
        ||!Array.isArray(meta.sleeveNotesSegmentUseIds)||typeof meta.airedAt!=='string'||!Number.isFinite(Date.parse(meta.airedAt))) {flush();continue;}
      block.push({text:turn.text,at:meta.airedAt,ids:meta.sleeveNotesSegmentUseIds.filter((id):id is string=>typeof id==='string'),
        speakerId:typeof meta.personaId==='string'?meta.personaId:'',speakerName:typeof meta.personaName==='string'?meta.personaName:'DJ'});
    }
    flush();
  }
}

/** Read-only compatibility for segments aired before transcript storage. */
export async function addLegacySegmentConversations<T extends {items:Item[]}>(shelf:T):Promise<T> {
  const wanted=()=>shelf.items.filter(item=>item.consumer==='sleeveNotesSegment'&&!item.conversation);
  if(!wanted().length)return shelf;
  const current=getSession()??await readFile(config.session.currentFile,'utf8').then(text=>JSON.parse(text)).catch(()=>null);
  withCachedRead(()=>recoverLegacySegmentConversations(open(),shelf.items,[current]));
  if(!wanted().length)return shelf;
  const times=wanted().map(item=>Date.parse(String(item.airedAt))).filter(Number.isFinite);
  if(!times.length)return shelf;
  const matching=(await archives()).filter(entry=>{
    const start=Date.parse(entry.startedAt||''),end=entry.endedAt?Date.parse(entry.endedAt):Infinity;
    return typeof entry.id==='string'&&/^[\w-]+$/.test(entry.id)&&times.some(time=>time>=start-300_000&&time<=end+300_000);
  }).slice(0,20);
  const saved=await Promise.all(matching.map(entry=>readFile(join(config.session.dir,`${entry.id}.json`),'utf8')
    .then(text=>JSON.parse(text)).catch(()=>null)));
  withCachedRead(()=>recoverLegacySegmentConversations(open(),shelf.items,saved));
  return shelf;
}
