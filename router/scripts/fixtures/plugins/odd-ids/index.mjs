const songs = [
  { id: 'Music/Artist/01 Song.flac', title: 'Path id', duration: 1 },
  { id: 'x'.repeat(80), title: 'Too long', duration: 1 },
  { title: 'No id', duration: 1 },
  { id: 42, title: 'Numeric id', duration: 1 },
];
export default () => ({
  async song(id) { return songs.find((s) => String(s.id) === id); },
  async album() { return undefined; },
  async artist() { return undefined; },
  async genres() { return ['Rock', { name: 'Jazz' }, '', null]; },
  async albumList() { return []; },
  async songsByGenre() { return []; },
  async randomSongs() { return songs; },
  async search() { return { artists: [], albums: [], songs }; },
  async stream() { return undefined; },
  async coverArt() { return undefined; },
});
