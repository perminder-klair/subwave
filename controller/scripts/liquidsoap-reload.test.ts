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
const { reloadAutoPlaylist, sendCommand } = await import('../src/broadcast/liquidsoap-control.js');

after(async () => {
  await new Promise<void>((resolve, reject) => mixer.close(err => err ? reject(err) : resolve()));
});

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
  test(`auto-playlist reload checks ${name}`, async () => {
    reply = response;
    commands.length = 0;
    assert.equal(await reloadAutoPlaylist(), confirmed);
    assert.deepEqual(commands, ['auto.reload']);
  });
}

test('other telnet callers retain their close-without-END behaviour', async () => {
  reply = 'partial reply';
  assert.equal(await sendCommand('legacy'), 'partial reply');
});
