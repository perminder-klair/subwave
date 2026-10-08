// Fixture: a stream() that takes a moment to reach its backend, then hands
// over a body that HOLDS a resource, as a fetch body or a file stream does:
// a web ReadableStream (kind=web) or a Node Readable (kind=node), far larger
// than a socket buffer. globalThis.__slowStream counts bodies opened and
// released — one left open is an upstream download outliving its client.
// (The router runs in-process in the HTTP tests, so the test reads the counts.)
import { Readable } from 'node:stream';

const song = { id: 's1', title: 'Slow', duration: 30 };
const counts = (globalThis.__slowStream ??= { opened: 0, closed: 0 });
const CHUNK = 64 * 1024;
const CHUNKS = 2000;

function webBody() {
  let sent = 0;
  return new ReadableStream({
    pull(ctrl) {
      if (sent++ < CHUNKS) ctrl.enqueue(new Uint8Array(CHUNK).fill(1));
      else ctrl.close();
    },
    cancel() {
      counts.closed++;
    },
  });
}

function nodeBody() {
  let sent = 0;
  return new Readable({
    read() {
      this.push(sent++ < CHUNKS ? Buffer.alloc(CHUNK, 1) : null);
    },
    destroy(err, cb) {
      counts.closed++;
      cb(err);
    },
  });
}

export default (ctx) => ({
  async song(id) { return id === 's1' ? song : undefined; },
  async album() { return undefined; },
  async artist() { return undefined; },
  async genres() { return []; },
  async albumList() { return []; },
  async songsByGenre() { return []; },
  async randomSongs() { return [song]; },
  async search() { return { artists: [], albums: [], songs: [song] }; },
  async stream(id) {
    if (id !== 's1') return undefined;
    await new Promise((ok) => setTimeout(ok, Number(ctx.config.delayMs)));
    counts.opened++;
    const body = ctx.config.kind === 'node' ? nodeBody() : webBody();
    return { body, headers: { 'content-type': 'audio/wav' } };
  },
  async coverArt() { return undefined; },
});
