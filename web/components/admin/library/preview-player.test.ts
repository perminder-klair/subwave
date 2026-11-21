// The admin preview player's store (preview-player.ts), against a stand-in
// audio element: one preview at a time, play/pause/resume, seeking, and a
// link that arrives after the operator moved on.
//
// Run: npm test -- preview-player

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPreviewPlayer, fmtClock, parseVolume, type PreviewAudio } from './preview-player';

class FakeAudio implements PreviewAudio {
  src = '';
  currentTime = 0;
  duration = Number.NaN;
  paused = true;
  volume = 1;
  muted = false;
  failPlay = false;
  plays: string[] = [];
  private handlers = new Map<string, Array<() => void>>();
  addEventListener(type: string, fn: () => void) {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]);
  }
  emit(type: string) { for (const fn of this.handlers.get(type) ?? []) fn(); }
  async play() {
    if (this.failPlay) throw new Error('NotSupportedError');
    this.paused = false;
    this.plays.push(this.src);
    this.emit('playing');
  }
  pause() {
    if (this.paused) return;
    this.paused = true;
    this.emit('pause');
  }
  removeAttribute(name: string) { if (name === 'src') this.src = ''; }
  load() {}
}

function setup() {
  const audio = new FakeAudio();
  const player = createPreviewPlayer(() => audio);
  const links: string[] = [];
  const link = (id: string) => async () => { links.push(id); return `/api/library/preview/${id}?exp=1&sig=x`; };
  return { audio, player, links, link };
}

test('a press plays the track from a fresh link; a second press pauses, a third resumes', async () => {
  const { audio, player, links, link } = setup();
  await player.toggle('a', link('a'));
  assert.deepEqual(links, ['a']);
  assert.equal(audio.src, '/api/library/preview/a?exp=1&sig=x');
  assert.deepEqual(player.getSnapshot(), { id: 'a', status: 'playing', time: 0, duration: 0, volume: 1, muted: false });
  await player.toggle('a', link('a'));
  assert.equal(player.getSnapshot().status, 'paused');
  assert.equal(audio.paused, true);
  await player.toggle('a', link('a'));
  assert.equal(player.getSnapshot().status, 'playing');
  assert.deepEqual(links, ['a'], 'resuming reuses the link');
});

test('starting another track stops the first: one preview at a time', async () => {
  const { audio, player, link } = setup();
  await player.toggle('a', link('a'));
  await player.toggle('b', link('b'));
  assert.equal(player.getSnapshot().id, 'b');
  assert.equal(audio.src, '/api/library/preview/b?exp=1&sig=x');
  assert.deepEqual(audio.plays, ['/api/library/preview/a?exp=1&sig=x', '/api/library/preview/b?exp=1&sig=x']);
});

test('the bar follows the element and seeks within the track', async () => {
  const { audio, player, link } = setup();
  await player.toggle('a', link('a'));
  audio.duration = 300;
  audio.emit('loadedmetadata');
  audio.currentTime = 12.5;
  audio.emit('timeupdate');
  assert.equal(player.getSnapshot().duration, 300);
  assert.equal(player.getSnapshot().time, 12.5);
  player.seek(150);
  assert.equal(audio.currentTime, 150);
  player.seek(999);
  assert.equal(audio.currentTime, 300, 'clamped to the end');
  player.seek(-5);
  assert.equal(audio.currentTime, 0);
});

test('a link that arrives after the operator moved on never starts', async () => {
  const { audio, player, link } = setup();
  let release!: (v: string) => void;
  const slow = () => new Promise<string>(r => { release = r; });
  const first = player.toggle('a', slow);
  await player.toggle('b', link('b'));
  release('/api/library/preview/a?late');
  await first;
  assert.equal(player.getSnapshot().id, 'b');
  assert.equal(audio.src, '/api/library/preview/b?exp=1&sig=x');
});

test('a failed play or link shows an error, and the next press asks for a fresh link', async () => {
  const { audio, player, links, link } = setup();
  audio.failPlay = true;
  await player.toggle('a', link('a'));
  assert.equal(player.getSnapshot().status, 'error');
  audio.failPlay = false;
  await player.toggle('a', link('a'));
  assert.equal(player.getSnapshot().status, 'playing');
  assert.deepEqual(links, ['a', 'a']);
  await player.toggle('b', async () => { throw new Error('401'); });
  assert.deepEqual({ id: player.getSnapshot().id, status: player.getSnapshot().status }, { id: 'b', status: 'error' });
});

test('the end of the track, or stop, clears the preview', async () => {
  const { audio, player, link } = setup();
  await player.toggle('a', link('a'));
  audio.emit('ended');
  assert.deepEqual(player.getSnapshot(), { id: null, status: null, time: 0, duration: 0, volume: 1, muted: false });
  assert.equal(audio.src, '');
});

function memoryStore(initial: string | null = null) {
  let value = initial;
  return { get: () => value, set: (v: string) => { value = v; }, read: () => value };
}

test('the level is applied to the element, kept across previews and saved', async () => {
  const audio = new FakeAudio();
  const store = memoryStore();
  const player = createPreviewPlayer(() => audio, store);
  player.setVolume(0.4);
  await player.toggle('a', async () => '/a');
  assert.equal(audio.volume, 0.4, 'an element made after the change starts at the level');
  player.stop();
  assert.equal(player.getSnapshot().volume, 0.4, 'stopping keeps the level');
  player.setVolume(0.7);
  assert.equal(audio.volume, 0.7);
  assert.equal(store.read(), '0.7');
  player.setVolume(5);
  assert.equal(player.getSnapshot().volume, 1, 'clamped');
});

test('the saved level is read back, and a bad one is full level', async () => {
  const audio = new FakeAudio();
  const player = createPreviewPlayer(() => audio, memoryStore('0.3:m'));
  await player.toggle('a', async () => '/a');
  assert.deepEqual([audio.volume, audio.muted], [0.3, true]);
  assert.deepEqual(parseVolume('junk'), { volume: 1, muted: false });
  assert.deepEqual(parseVolume(null), { volume: 1, muted: false });
  assert.deepEqual(parseVolume('0.25'), { volume: 0.25, muted: false });
  const blocked = createPreviewPlayer(() => new FakeAudio(), { get: () => { throw new Error('denied'); }, set: () => { throw new Error('denied'); } });
  blocked.setVolume(0.2);
  assert.equal(blocked.getSnapshot().volume, 0.2, 'storage that throws changes nothing else');
});

test('mute toggles; raising the level unmutes; unmuting at zero comes back at half', async () => {
  const audio = new FakeAudio();
  const store = memoryStore();
  const player = createPreviewPlayer(() => audio, store);
  await player.toggle('a', async () => '/a');
  player.toggleMute();
  assert.equal(audio.muted, true);
  assert.equal(store.read(), '1:m');
  player.setVolume(0.6);
  assert.deepEqual([audio.muted, audio.volume], [false, 0.6]);
  player.setVolume(0);
  player.toggleMute();
  player.toggleMute();
  assert.deepEqual([audio.muted, audio.volume], [false, 0.5]);
});

test('the clock reads m:ss', () => {
  assert.equal(fmtClock(0), '0:00');
  assert.equal(fmtClock(65.9), '1:05');
  assert.equal(fmtClock(Number.NaN), '0:00');
});
