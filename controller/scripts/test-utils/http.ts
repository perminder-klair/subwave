// Replaces loopback port-0 listen/address/close boilerplate. Callers still own
// handlers, unref(), and closeAllConnections() when their fixture needs them.
import { createServer, type RequestListener, type Server } from 'node:http';

export async function listen(serverOrApp: Server | RequestListener) {
  const server = typeof serverOrApp === 'function' ? createServer(serverOrApp) : serverOrApp;
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP listen address');
  return {
    server,
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    }),
  };
}
