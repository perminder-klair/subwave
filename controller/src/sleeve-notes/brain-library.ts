import { librarySourceKey } from './local-identity.js';
// Display-only Navidrome metadata. This never inserts encounters, claims or
// research jobs. The artist index is a complete, persisted snapshot; albums
// and tracks are read only when their neighbourhood is explicitly opened.
import { z } from 'zod';
import * as subsonic from '../music/subsonic.js';
import * as settings from '../settings.js';
import { open, runResearchDatabaseWork } from './db.js';
import type { QuietGate } from './musicbrainz-worker.js';
import { connectionNameKey } from './library-connections.js';
import { resolveConnectionLocalTracks, type ConnectionGraph, type ConnectionNode,
  type ConnectionSearchResult } from './research-repository.js';

let population: Promise<{ artists: number }> | null = null;

export function populateBrainArtists(quietGate?: QuietGate): Promise<{ artists: number }> {
  if (population) return population;
  population = (async () => {
    const sourceKey=librarySourceKey();
    let count = 0;
    let interrupted = false;
    const assertAllowed = () => {
      if (sourceKey!==librarySourceKey() || interrupted || !settings.get().djBehaviour.extendedSleeveNotes || (quietGate && !quietGate.isQuiet())) {
        throw new Error('Artist population interrupted; waiting for another enabled quiet slot');
      }
    };
    const unsubscribe = settings.onCacheChange(() => {
      if (!settings.get().djBehaviour.extendedSleeveNotes || (quietGate && !quietGate.isQuiet())) interrupted = true;
    });
    try {
      const ran = await runResearchDatabaseWork(async () => {
        assertAllowed();
        if (await subsonic.getScanStatus() === true) throw new Error('Navidrome is scanning. Try populating the Brain after the scan finishes.');
        assertAllowed();
        const artists = await subsonic.getLibraryArtists({ requireComplete: true });
        assertAllowed();
        if (await subsonic.getScanStatus() === true) throw new Error('Navidrome started scanning. The previous artist map has been kept.');
        assertAllowed();
        const db = open();
        const existing = db.prepare('SELECT COUNT(*) AS count FROM sleeve_connection_library_artists').get() as { count: number };
        if (!artists.length && existing.count) throw new Error('Navidrome returned an empty artist index. The previous map has been kept.');
        const unique = new Map(artists.map((artist) => [artist.id, artist]));
        if (unique.size !== artists.length) throw new Error('Navidrome returned duplicate artist identities. The previous map has been kept.');
        db.transaction(() => {
          const remove = db.prepare('DELETE FROM sleeve_connection_library_artists WHERE local_artist_id = ?');
          for (const row of db.prepare('SELECT local_artist_id AS id FROM sleeve_connection_library_artists').all() as Array<{ id: string }>) {
            if (!unique.has(row.id)) remove.run(row.id);
          }
          const insert = db.prepare(`INSERT INTO sleeve_connection_library_artists (local_artist_id, name, name_key) VALUES (?, ?, ?)
            ON CONFLICT(local_artist_id) DO UPDATE SET name=excluded.name, name_key=excluded.name_key
            WHERE name IS NOT excluded.name OR name_key IS NOT excluded.name_key`);
          for (const artist of unique.values()) insert.run(artist.id, artist.name, connectionNameKey(artist.name));
          db.prepare(`INSERT INTO sleeve_connection_artist_population (id, completed_at) VALUES (1, ?)
            ON CONFLICT(id) DO UPDATE SET completed_at = excluded.completed_at`).run(new Date().toISOString());
        })();
        count = unique.size;
        return true;
      });
      if (!ran) throw new Error('Sleeve Notes restore is in progress; try again shortly');
      return { artists: count };
    } finally { unsubscribe(); }
  })().finally(() => { population = null; });
  return population;
}

// One fast index request on first enabled startup, then at most once a day.
// A failed attempt backs off for an hour; the operator can retry explicitly.
export function startBrainArtistPopulation(quietGate: QuietGate): void {
  let retryAfter = 0;
  const run = async () => {
    if (settings.get().djBehaviour.extendedSleeveNotes !== true || settings.get().djBehaviour.sleeveNotesCollectionPaused === true || !quietGate.isQuiet() || Date.now() < retryAfter) return;
    await runResearchDatabaseWork(async () => {
      const saved = open().prepare('SELECT completed_at AS at FROM sleeve_connection_artist_population WHERE id = 1')
        .get() as { at: string } | undefined;
      if (saved && Date.now() - Date.parse(saved.at) < 24 * 60 * 60_000) return false;
      retryAfter = Date.now() + 60 * 60_000;
      await populateBrainArtists(quietGate);
      return true;
    });
  };
  const tick = () => { void run().catch((error: unknown) => {
    console.warn('[sleeve-notes] Brain artist population:', error instanceof Error ? error.message : String(error));
  }); };
  tick();
  setInterval(tick, 60_000).unref();
}

export function localBrainArtistId(name: string): string | null {
  const rows = open().prepare('SELECT local_artist_id AS id FROM sleeve_connection_library_artists WHERE name_key = ? LIMIT 2')
    .all(connectionNameKey(name)) as Array<{ id: string }>;
  // A name is only a display lookup, never proof of a musical relationship.
  return rows.length === 1 ? rows[0].id : null;
}

export function searchBrainArtists(query: string, limit: number): ConnectionSearchResult[] {
  const term = query.trim().toLocaleLowerCase();
  if (term.length < 2) return [];
  const rows = open().prepare(`SELECT local_artist_id AS id, name FROM sleeve_connection_library_artists
    ORDER BY name COLLATE NOCASE, local_artist_id`).iterate() as Iterable<{ id: string; name: string }>;
  const results: ConnectionSearchResult[] = [];
  for (const row of rows) {
    if (!row.name.toLocaleLowerCase().includes(term)) continue;
    results.push({ nodeId: `library-artist:${row.id}`, entityType: 'library-artist', entityId: row.id,
      title: row.name, subtitle: 'Library artist · open albums', kind: 'artist', localArtistId: row.id });
    if (results.length >= limit) break;
  }
  return results;
}

const identity = z.string().trim().min(1);
const albumSchema = z.object({ id: identity, name: identity, artist: z.string().optional(),
  artistId: identity.optional(),
  songCount: z.number().nonnegative().optional(), year: z.number().optional() });
const artistSchema = z.object({ id: identity, name: identity, album: z.array(albumSchema) });
const songSchema = z.object({ id: identity, title: identity, artist: z.string().optional() });
const NODE_CAP = 600;

export function cachedBrainLibraryGraph(type: 'library-artist' | 'library-album', id: string): ConnectionGraph | null {
  const db = open();
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'sleeve_brain_layers'").get()) return null;
  const row = db.prepare('SELECT graph_json AS json FROM sleeve_brain_layers WHERE entity_type = ? AND entity_id = ?').get(type, id) as { json: string } | undefined;
  return row ? JSON.parse(row.json) as ConnectionGraph : null;
}

export async function brainLibraryGraph(
  type: 'library-artist' | 'library-album', id: string, signal?: AbortSignal,
  canonicalRoot?: ConnectionNode,
): Promise<ConnectionGraph> {
  const nodes: ConnectionNode[] = [];
  const edges: ConnectionGraph['edges'] = [];
  let truncated = false;
  const membership = (root: ConnectionNode, child: ConnectionNode, label: string, evidence: string) => {
    nodes.push(child);
    edges.push({ id: `${root.id}:${child.id}`, source: root.id, target: child.id, type: 'appears-on',
      label, provider: 'navidrome', sourceUrl: null, evidence, attribution: 'Your music library' });
  };
  if (type === 'library-artist') {
    const artist = artistSchema.parse(await subsonic.getArtist(id, { signal }));
    if (artist.id !== id) throw new Error('Navidrome returned a different artist identity.');
    const root: ConnectionNode = canonicalRoot ?? { id: `library-artist:${id}`, entityType: type,
      entityId: id, kind: 'artist', title: artist.name, subtitle: 'Library artist',
      local: true, expandable: true, localArtistId: id, sourceUrl: null };
    nodes.push(root);
    const albums = [...new Map(artist.album.map((album) => [album.id, album])).values()];
    truncated = albums.length >= NODE_CAP;
    for (const album of albums.slice(0, NODE_CAP - 1)) {
      const node: ConnectionNode = { id: `library-album:${album.id}`, entityType: 'library-album',
        entityId: album.id, kind: 'release', title: album.name,
        subtitle: [album.artist ?? artist.name, album.year].filter(Boolean).join(' · '),
        local: true, expandable: true, sourceUrl: null, trackCount: album.songCount };
      membership(root, node, 'has album', `${artist.name} has ${album.name} in your Navidrome library.`);
    }
  } else {
    const result = await subsonic.getAlbumWithSongs(id, { requireComplete: true, signal });
    if (!result) throw new Error('The album is no longer in the library.');
    const album = albumSchema.parse(result.album);
    const songs = z.array(songSchema).parse(result.songs);
    const root: ConnectionNode = { id: `library-album:${id}`, entityType: type, entityId: id,
      kind: 'release', title: album.name, subtitle: album.artist ?? null,
      local: true, expandable: true, sourceUrl: null, trackCount: songs.length, localArtistId: album.artistId };
    nodes.push(root);
    truncated = songs.length >= NODE_CAP;
    const displayedSongs = songs.slice(0, NODE_CAP - 1);
    const matchedTracks = new Map(resolveConnectionLocalTracks(displayedSongs.map((song) => song.id))
      .map((track) => [track.localTrackId, track]));
    const seen = new Set([root.id]);
    for (const song of displayedSongs) {
      const matched = matchedTracks.get(song.id);
      const node: ConnectionNode = { id: matched?.nodeId ?? `library-track:${song.id}`,
        entityType: matched ? 'recording' : 'library-track', entityId: matched?.entityId ?? song.id,
        kind: 'recording', title: song.title, subtitle: song.artist ?? album.artist ?? null,
        local: true, expandable: !!matched, sourceUrl: null, localTrackId: song.id };
      if (!seen.has(node.id)) {
        seen.add(node.id);
        membership(root, node, 'contains track', `${song.title} appears on ${album.name} in your Navidrome library.`);
      }
    }
  }
  const graph = { focusId: nodes[0].id, nodes, edges, truncated };
  // Store a library root identity, independent of a canonical artist alias.
  const snapshot = structuredClone(graph);
  if (canonicalRoot) {
    const rootId = `library-artist:${id}`;
    snapshot.nodes[0] = { ...snapshot.nodes[0], id: rootId, entityType: type, entityId: id };
    snapshot.focusId = rootId;
    for (const edge of snapshot.edges) if (edge.source === canonicalRoot.id) edge.source = rootId;
  }
  open().prepare(`INSERT INTO sleeve_brain_layers (entity_type, entity_id, graph_json) VALUES (?, ?, ?)
    ON CONFLICT(entity_type, entity_id) DO UPDATE SET graph_json = excluded.graph_json`).run(type, id, JSON.stringify(snapshot));
  return graph;
}

/** One verified library track seeds identity matching; this never queues music. */
export async function brainLibraryResearchSeed(id: string, signal?: AbortSignal): Promise<import('./brain-coverage.js').BrainLibrarySeed> {
  const indexed = open().prepare('SELECT name FROM sleeve_connection_library_artists WHERE local_artist_id = ?').get(id) as { name: string } | undefined;
  if (!indexed) throw new Error('This artist is no longer in the saved library index. Refresh the artist map.');
  const artist = artistSchema.parse(await subsonic.getArtist(id, { signal }));
  if (artist.id !== id || connectionNameKey(artist.name) !== connectionNameKey(indexed.name)) throw new Error('The library artist identity changed. Refresh the artist map.');
  for (const album of artist.album.slice(0, 3)) {
    signal?.throwIfAborted();
    const result = await subsonic.getAlbumWithSongs(album.id, { requireComplete: true, signal });
    signal?.throwIfAborted();
    if (!result || result.album.id !== album.id) continue;
    for (const song of result.songs) {
      if (typeof song.id !== 'string' || !song.id.trim() || typeof song.title !== 'string' || !song.title.trim()) continue;
      if (typeof song.artist !== 'string' || connectionNameKey(song.artist) !== connectionNameKey(artist.name)) continue;
      if (song.artistId && song.artistId !== id) continue;
      return { id: song.id, title: song.title, artist: song.artist, album: album.name,
        mbid: typeof song.musicBrainzId === 'string' && z.uuid().safeParse(song.musicBrainzId).success ? song.musicBrainzId : null };
    }
  }
  throw new Error('No track with a matching artist credit was found in this artist’s first three albums. Queue a track through Sleeve Notes after playing it.');
}

/** Resolve a selected library album using its own returned tracks, not an artist's first album. */
export async function brainLibraryAlbumResearchSeed(id: string, signal?: AbortSignal): Promise<import('./brain-album-research.js').BrainAlbumSeed> {
  const rows=open().prepare(`SELECT DISTINCT json_extract(node.value,'$.title') AS title FROM sleeve_brain_layers layer,
    json_each(layer.graph_json,'$.nodes') node WHERE json_extract(node.value,'$.entityType')='library-album'
      AND json_extract(node.value,'$.entityId')=?`).all(id) as Array<{title:string}>;
  if(!rows.length)throw new Error('Open this album on Station Brain before requesting research.');
  const result=await subsonic.getAlbumWithSongs(id,{requireComplete:true,signal});
  signal?.throwIfAborted();
  if(!result||result.album.id!==id||!rows.some(row=>connectionNameKey(row.title)===connectionNameKey(result.album.name)))throw new Error('The library album identity changed. Reopen its layer and try again.');
  const { brainAlbumGroupForTrackInDatabase }=await import('./brain-album-research.js');
  let fallback:import('./brain-album-research.js').BrainAlbumSeed|undefined;
  for(const song of result.songs.slice(0,20)){
    signal?.throwIfAborted();
    if(!song.id?.trim()||!song.title?.trim()||!song.artist?.trim()||(song.albumId&&song.albumId!==id))continue;
    const seed={albumId:id,title:result.album.name,track:{id:song.id,title:song.title,artist:song.artist,album:result.album.name,
      mbid:typeof song.musicBrainzId==='string'&&z.uuid().safeParse(song.musicBrainzId).success?song.musicBrainzId:null}};
    if(brainAlbumGroupForTrackInDatabase(open(),seed))return seed;
    fallback??=seed;
  }
  if(!fallback)throw new Error('No usable track was found in the first twenty tracks of this album.');
  return fallback;
}
