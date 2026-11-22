// The routes that bring the mounts back new withdraw GET /state's idle window
// (#2072). New mounts are younger than any buffer and a restarted mixer boots
// live, so a burst after either holds music that the window would vouch for as
// silence, and the web player would fast-forward it. The monitor's side is in
// stream-idle-window.test.ts; this pins the calls from /restart-mixer and
// /stream-start, which nothing else would notice going missing.
//
// Run: npm test -- stream-idle-window-routes

import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { createServer, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import test, { after, mock } from 'node:test';

process.env.ADMIN_USER = 'test-admin';
process.env.ADMIN_PASS = 'test-pass';

// A stand-in mixer, paused. `restart` takes it down for good, as the real one
// does until the container comes back, so it runs last. A command in `drop`
// lands but its answer is lost: the connection resets.
const commands: string[] = [];
const drop = new Set<string>();
const sockets = new Set<Socket>();
const mixer = createServer(socket => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.once('data', data => {
    const cmd = data.toString().split('\n')[0].trim();
    commands.push(cmd);
    if (cmd === 'restart') {
      mixer.close();
      for (const s of sockets) s.destroy();
      return;
    }
    if (drop.has(cmd)) {
      socket.resetAndDestroy();
      return;
    }
    socket.end(`${cmd === 'idle_status' ? 'on' : 'OK'}\r\nEND\r\n`);
  });
});
await new Promise<void>(resolve => mixer.listen(0, '127.0.0.1', resolve));
// Down already if the restart test ran; a failure before it must not leave the
// stand-in listening and the file hanging.
after(() => {
  if (mixer.listening) mixer.close();
  for (const s of sockets) s.destroy();
});
process.env.LIQUIDSOAP_HOST = '127.0.0.1';
process.env.LIQUIDSOAP_PORT = String((mixer.address() as AddressInfo).port);

// A stand-in Icecast status, so the pause can be tied to the MP3 mount a
// committed poll saw (bound before config reads ICECAST_STATUS_URL).
const icecast = createHttpServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ icestats: { source: {
    listenurl: 'http://localhost:7702/stream.mp3', listeners: 0, stream_start: '29/Oct/2026:11:58:12 +0000',
  } } }));
});
await new Promise<void>(resolve => icecast.listen(0, '127.0.0.1', resolve));
after(() => {
  icecast.closeAllConnections();
  icecast.close();
});
process.env.ICECAST_STATUS_URL = `http://127.0.0.1:${(icecast.address() as AddressInfo).port}/status-json.xsl`;

const express = (await import('express')).default;
const { refresh } = await import('../src/broadcast/listeners.js');
const { idleWindow, startStreamIdleMonitor } = await import('../src/broadcast/stream-idle.js');
const { router } = await import('../src/routes/settings/station.js');

const app = express();
app.use(express.json());
app.use(router);
const server = createHttpServer(app);
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
server.unref();
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const authorization = `Basic ${Buffer.from('test-admin:test-pass').toString('base64')}`;

// A fresh monitor that adopts the stand-in's pause. Its tick and wake probe
// are left unscheduled, so nothing but the route moves the window.
async function pausedMonitor() {
  await refresh();
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    await startStreamIdleMonitor();
  } finally {
    mock.timers.reset();
  }
  const window = idleWindow();
  assert.ok(window, 'the adopted pause is published');
  assert.equal(window.endedMsAgo, null);
}

async function post(path: string, status = 200) {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: { authorization } });
  assert.equal(res.status, status, await res.text());
}

test('/stream-start withdraws the pause: the new mounts never carried it', async () => {
  await pausedMonitor();
  await post('/stream-start');
  assert.ok(commands.includes('stream_on'));
  assert.equal(idleWindow(), null);
});

test('/stream-start withdraws it too when the mixer does not confirm', async () => {
  await pausedMonitor();
  drop.add('stream_on');
  try {
    await post('/stream-start', 500);
  } finally {
    drop.delete('stream_on');
  }
  assert.equal(idleWindow(), null);
});

test('/restart-mixer withdraws the pause once the restart lands', async () => {
  await pausedMonitor();
  await post('/restart-mixer');
  assert.ok(commands.includes('restart'));
  assert.equal(idleWindow(), null);
});
