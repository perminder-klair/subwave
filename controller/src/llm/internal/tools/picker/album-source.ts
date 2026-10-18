import * as subsonic from '../../../../music/subsonic.js';
import { shuffle } from '../../../../util/shuffle.js';

// Sample across twelve albums, including later track positions. Cache this
// wide pool, then let collect() draw fresh eligible tracks on every invocation.
export async function albumSourcePool(albums: Array<{ id: string }>, signal?: AbortSignal, tracksPerAlbum = 3): Promise<any[]> {
  const out: any[] = [];
  const sampled = shuffle(albums).slice(0, 12);
  let failed = 0;
  for (const album of sampled) {
    signal?.throwIfAborted();
    try { out.push(...shuffle(await subsonic.getAlbum(album.id, { signal })).slice(0, tracksPerAlbum)); } catch { failed++; }
  }
  // Partial failures retain the other albums' candidates. Every fetch failing
  // is a server error, not an empty shelf to cache and hide for five minutes.
  if (sampled.length && failed === sampled.length) {
    throw new Error('could not read albums from the music server — choose from your other tool results this round');
  }
  signal?.throwIfAborted();
  return out;
}
