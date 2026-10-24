// Operator selections: source identity is fixed; mood and flow rank it without
// the automatic picker's recency/show guards. /dj/queue-track owns the push.
import { z } from 'zod';
import * as subsonic from '../music/subsonic.js';
import * as library from '../music/library.js';
import * as blocklist from '../music/blocklist.js';
import { orderByTransitionFit } from '../music/shortlist.js';
import { shuffle } from '../util/shuffle.js';
import { mapPool } from '../util/async-pool.js';
import { getFullContext } from '../context.js';
import { queue } from '../broadcast/queue.js';
import { open, withCachedRead } from './db.js';
import { connectionNameKey } from './library-connections.js';

export const brainQueueSelectionSchema = z.object({
  entityType: z.enum(['library-track','recording','library-artist','artist','library-album','release','release-group']),
  entityId: z.string().trim().min(1).max(200),
}).strict();

export async function selectBrainQueueTrack(selection: z.infer<typeof brainQueueSelectionSchema>) {
  const {entityType,entityId}=selection;
  const fail=(message:string)=>Object.assign(new Error(message),{status:404});
  let id=entityId;
  let expectedAlbum:string|null=null;
  if (entityType==='recording') {
    const match=withCachedRead(()=>open().prepare(`SELECT local_track_id AS id FROM sleeve_local_attachments WHERE recording_id=? AND match_state='matched'
      UNION SELECT local_track_id AS id FROM sleeve_connection_library_matches WHERE recording_id=? ORDER BY id LIMIT 1`).get(entityId,entityId)) as {id:string}|undefined;
    if (!match) throw fail('This recording has no confirmed library track. Reopen its album layer.');
    id=match.id;
  }
  if (entityType==='library-track'||entityType==='recording') {
    const track=await subsonic.getSong(id);
    if (!track || track.id!==id) throw fail('This track is no longer available in the library.');
    return {track,reason:'The exact track you selected.'};
  }
  if (entityType==='artist') {
    const artist=withCachedRead(()=>open().prepare('SELECT name FROM sleeve_artists WHERE id=?').get(entityId)) as {name:string}|undefined;
    const local=artist?await subsonic.resolveArtist(artist.name):null;
    if (!artist || !local || connectionNameKey(local.name)!==connectionNameKey(artist.name)) throw fail('No matching library artist was found.');
    id=local.id;
  }
  if (entityType==='release'||entityType==='release-group') {
    const seeds=withCachedRead(()=>open().prepare(`SELECT a.local_track_id AS id,r.title AS title,a.release_title AS localTitle
      FROM sleeve_releases r JOIN sleeve_recording_releases rr ON rr.release_id=r.id
      JOIN sleeve_local_attachments a ON a.recording_id=rr.recording_id AND a.match_state='matched'
      WHERE ${entityType==='release'?'r.id':'r.musicbrainz_release_group_id'}=? ORDER BY a.local_track_id`).all(entityId)) as Array<{id:string;title:string;localTitle:string|null}>;
    const seed=seeds.find(row=>connectionNameKey(row.title)===connectionNameKey(row.localTitle??''));
    const song=seed?await subsonic.getSong(seed.id):null;
    if (!seed || !song?.albumId || connectionNameKey(song.album)!==connectionNameKey(seed.title)) throw fail('No confirmed library album was found. Open its library album layer.');
    id=song.albumId;expectedAlbum=seed.title;
  }
  let songs: Awaited<ReturnType<typeof subsonic.getAlbum>>;
  if (entityType==='library-artist'||entityType==='artist') {
    const artist=await subsonic.getArtist(id);
    if (!artist || artist.id!==id) throw fail('This artist is no longer available in the library.');
    // Bound the catalogue work and sample across the discography, rather than
    // treating the server's first album as the whole artist.
    const albums=shuffle<{id:string}>(artist.album??[]).slice(0,20);
    const pages=await mapPool(albums,3,async album=>subsonic.getAlbum(album.id));
    songs=pages.flat().filter(song=>song.artistId? song.artistId===id : connectionNameKey(song.artist)===connectionNameKey(artist.name));
  } else {
    const result=await subsonic.getAlbumWithSongs(id,{requireComplete:true});
    if (!result || result.album.id!==id || (expectedAlbum&&connectionNameKey(result.album.name)!==connectionNameKey(expectedAlbum))) throw fail('This album is no longer available in the library.');
    songs=result.songs.filter(song=>!song.albumId||song.albumId===id);
  }
  await library.load();
  await blocklist.load();
  const candidates=blocklist.rejectBlocked([...new Map(songs.filter(song=>song?.id&&song.title).map(song=>[song.id,song])).values()]);
  if (!candidates.length) throw fail('No playable tracks were found in this selection. Check Library → Blocked.');
  const ctx=await getFullContext();
  const moods=ctx.activeShow?.moods?.length?ctx.activeShow.moods:ctx.dominantMood?[ctx.dominantMood]:[];
  const moodIds=new Set(moods.flatMap(mood=>library.songsByMood(mood).map(song=>song.id)));
  const moodMatches=candidates.filter(song=>moodIds.has(song.id));
  // Resolve the tail after catalogue work: this track follows the queue, not
  // necessarily the track that was on air when the operator clicked.
  const predecessor=queue.upcoming.at(-1)?.track??queue.current?.track;
  const target=library.bpmKeyFor(predecessor);
  const track=orderByTransitionFit(shuffle(moodMatches.length?moodMatches:candidates),target,library.bpmKeyFor)[0];
  const moodReason=moodMatches.length?'Matches the current mood.':'No matching mood tags were available.';
  const flowReason=target.bpm!=null||target.key!=null?'Transition fit was ranked against the preceding queued track.':'No tempo or key analysis was available for the preceding track.';
  return {track,reason:`${moodReason} ${flowReason}`};
}
