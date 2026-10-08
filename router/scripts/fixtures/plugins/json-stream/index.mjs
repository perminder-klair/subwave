const song = { id: 'x1', title: 'Broken', duration: 10 };
export default () => ({
  async song(id) { return id === 'x1' ? song : undefined; },
  async album() { return undefined; },
  async artist() { return undefined; },
  async genres() { return []; },
  async albumList() { return []; },
  async songsByGenre() { return []; },
  async randomSongs() { return [song]; },
  async search() { return { artists: [], albums: [], songs: [] }; },
  async stream() { return { body: new TextEncoder().encode('{"error":"nope"}'), headers: { 'content-type': 'application/json' } }; },
  async coverArt() { return undefined; },
});
