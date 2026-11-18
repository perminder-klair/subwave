// Reload confirmation must cover the telnet response, not just a connection.
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { after, test } from 'node:test';

let reply = '';
const commands: string[] = [];
const mixer = createServer(socket => socket.once('data', data => {
  commands.push(data.toString().trim());
  socket.end(reply);
}));
await new Promise<void>(resolve => mixer.listen(0, '127.0.0.1', resolve));
const address = mixer.address();
if (!address || typeof address === 'string') throw new Error('mixer has no TCP port');
process.env.LIQUIDSOAP_HOST = '127.0.0.1';
process.env.LIQUIDSOAP_PORT = String(address.port);
const { autoPlaylistReady, reloadAutoPlaylist, reloadJinglesPlaylist, sendCommand } = await import('../src/broadcast/liquidsoap-control.js');

after(async () => {
  await new Promise<void>((resolve, reject) => mixer.close(err => err ? reject(err) : resolve()));
});

// The jingles rotate's reload (#2008) is read the same way. Its error reply is
// also what a mixer with no rotate gives (jingleRatio 0, controller-owned).
for (const [playlist, reload, command] of [
  ['auto-playlist', reloadAutoPlaylist, 'auto.reload'],
  ['jingles', reloadJinglesPlaylist, 'jingles.reload'],
] as const) {
  for (const [name, response, confirmed] of [
    ['complete acknowledgement', 'OK\r\nEND\r\n', true],
    ['LF acknowledgement', 'OK\nEND\n', true],
    ['empty close', '', false],
    ['unterminated acknowledgement', 'OK\r\n', false],
    ['truncated terminator', 'OK\r\nEND', false],
    ['inline terminator', 'OKEND\n', false],
    ['error reply', 'ERROR: unknown command\nEND\n', false],
    ['unexpected reply', 'OK\nunexpected\nEND\n', false],
  ] as const) {
    test(`${playlist} reload checks ${name}`, async () => {
      reply = response;
      commands.length = 0;
      assert.equal(await reload(), confirmed);
      assert.deepEqual(commands, [command]);
    });
  }
}

test('other telnet callers retain their close-without-END behaviour', async () => {
  reply = 'partial reply';
  assert.equal(await sendCommand('legacy'), 'partial reply');
});

for (const [name, response, ready] of [
  ['ready', 'ready\nEND\n', true],
  ['pending', 'pending\nEND\n', false],
  // A mixer older than auto.ready has no signal to wait for.
  ['a mixer without the command', 'ERROR: unknown command, type "help" to get a list of commands.\nEND\n', true],
] as const) {
  test(`fallback readiness reads ${name}`, async () => {
    reply = response;
    commands.length = 0;
    assert.equal(await autoPlaylistReady(), ready);
    assert.deepEqual(commands, ['auto.ready']);
  });
}
