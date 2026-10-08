// Mutable mock state: playlists and stars, in memory only. Restarting resets
// them to the seeded fixtures; the library itself is deterministic, so ids
// stay valid either way.

import { norm } from '../../util.js';
import type { PlaylistPatch, Song } from '../../sdk/types.js';
import type { Library } from './library.js';

export interface PlaylistRec {
  id: string;
  name: string;
  comment: string;
  public: boolean;
  created: string;
  changed: string;
  songIds: string[];
}

export interface Store {
  playlists: Map<string, PlaylistRec>;
  starred: Map<string, string>;
  create(name: string, songIds: string[]): PlaylistRec;
  overwrite(id: string, name: string | undefined, songIds: string[]): PlaylistRec | undefined;
  update(id: string, patch: PlaylistPatch): PlaylistRec | undefined;
  remove(id: string): boolean;
  star(id: string): void;
  unstar(id: string): void;
  starredSongs(): Song[];
}

export function createStore(lib: Library): Store {
  const playlists = new Map<string, PlaylistRec>();
  const starred = new Map<string, string>();
  let counter = 0;
  const known = (ids: string[]) => ids.filter((s) => lib.songById.has(s));

  const store: Store = {
    playlists,
    starred,
    create(name, songIds) {
      const now = new Date().toISOString();
      const rec: PlaylistRec = { id: `pl-${++counter}`, name, comment: '', public: false, created: now, changed: now, songIds: known(songIds) };
      playlists.set(rec.id, rec);
      return rec;
    },
    // Subsonic createPlaylist with a playlistId REPLACES the song list.
    overwrite(id, name, songIds) {
      const rec = playlists.get(id);
      if (!rec) return undefined;
      if (name) rec.name = name;
      rec.songIds = known(songIds);
      rec.changed = new Date().toISOString();
      return rec;
    },
    update(id, patch) {
      const rec = playlists.get(id);
      if (!rec) return undefined;
      if (patch.name !== undefined) rec.name = patch.name;
      if (patch.comment !== undefined) rec.comment = patch.comment;
      if (patch.public !== undefined) rec.public = patch.public;
      if (patch.addIds) rec.songIds.push(...known(patch.addIds));
      // Subsonic removes by position; go from the highest index down so an
      // earlier removal does not shift a later one.
      for (const i of [...(patch.removeIndexes ?? [])].sort((a, b) => b - a)) {
        if (i >= 0 && i < rec.songIds.length) rec.songIds.splice(i, 1);
      }
      rec.changed = new Date().toISOString();
      return rec;
    },
    remove: (id) => playlists.delete(id),
    star(id) {
      if (lib.songById.has(id) && !starred.has(id)) starred.set(id, new Date().toISOString());
    },
    unstar: (id) => void starred.delete(id),
    starredSongs: () => lib.songs.filter((s) => starred.has(s.id)),
  };

  const seed = (name: string, genres: string[], max: number) => {
    const targets = genres.map(norm);
    const rec = store.create(
      name,
      lib.songs.filter((s) => (s.genres ?? []).some((g) => targets.includes(norm(g)))).slice(0, max).map((s) => s.id),
    );
    rec.public = true;
    rec.comment = 'Seeded by the SUB/WAVE mock source';
  };
  seed('Chill Rotation', ['Ambient', 'Downtempo', 'Lo-Fi', 'Chillhop'], 12);
  seed('Late Night Drive', ['Synthwave', 'Techno', 'Trip-Hop', 'Electronic'], 12);
  lib.songs.filter((_, i) => i % 7 === 0).slice(0, 5).forEach((s) => store.star(s.id));
  return store;
}
