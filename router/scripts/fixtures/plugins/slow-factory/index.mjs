// Fixture: a source whose factory takes a while to start (a plugin that logs
// in to its backend first). Used to show reloads applying in order.
const song = { id: 's1', title: 'Slow start', duration: 30 };
export default async (ctx) => {
  await new Promise((ok) => setTimeout(ok, Number(ctx.config.delayMs)));
  return {
    async song(id) { return id === 's1' ? song : undefined; },
    async album() { return undefined; },
    async artist() { return undefined; },
    async genres() { return []; },
    async albumList() { return []; },
    async songsByGenre() { return []; },
    async randomSongs() { return [song]; },
    async search() { return { artists: [], albums: [], songs: [song] }; },
    async stream() { return undefined; },
    async coverArt() { return undefined; },
  };
};
