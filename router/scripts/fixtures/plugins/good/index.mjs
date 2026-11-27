// Fixture: the smallest useful plugin. Plain ESM, no imports.
const silence = (bytes) => new Uint8Array(bytes);
export default (ctx) => {
  const artist = { id: 'ar1', name: 'Fixture Artist' };
  const album = { id: 'al1', name: `Fixture Album (${ctx.config.greeting})`, artist: artist.name, artistId: 'ar1', year: 2001, genres: ['Test'] };
  const songs = [1, 2].map((n) => ({ id: `s${n}`, title: `Song ${n}`, album: album.name, albumId: 'al1', artist: artist.name, artistId: 'ar1', track: n, duration: 30, genres: ['Test'], suffix: 'wav' }));
  const byId = new Map(songs.map((s) => [s.id, s]));
  return {
    async song(id) { return byId.get(id); },
    async album(id) { return id === 'al1' ? { album, songs } : undefined; },
    async artist(id) { return id === 'ar1' ? { artist, albums: [album] } : undefined; },
    async genres() { return [{ name: 'Test', songCount: 2, albumCount: 1 }]; },
    async albumList() { return [album]; },
    async songsByGenre(g) { return g.toLowerCase() === 'test' ? songs : []; },
    async randomSongs(size) { return songs.slice(0, size); },
    async search(q) { const m = songs.filter((s) => s.title.toLowerCase().includes(q.toLowerCase())); return { artists: [], albums: [], songs: m }; },
    async stream(id) { return byId.has(id) ? { body: silence(8192), headers: { 'content-type': 'audio/wav' } } : undefined; },
    async coverArt(id) { return id === 'al1' ? { contentType: 'image/png', data: new Uint8Array([137, 80, 78, 71]) } : undefined; },
  };
};
