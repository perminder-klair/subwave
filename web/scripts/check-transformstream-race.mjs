// Build-time guard for issue #1535 / nodejs/node#62036.
//
// Node's `TransformStream` had a shutdown race: `reader.cancel()` clears the
// controller's algorithms via `transformStreamDefaultControllerClearAlgorithms`
// while a write is already in flight, so the pending write still reaches
// `transformStreamDefaultControllerPerformTransform` and throws
// `TypeError: controller[kState].transformAlgorithm is not a function`.
//
// Next's App Router streams every RSC response through a TransformStream, so a
// client that disconnects mid-render trips it and the whole page 500s. On a
// Pi 5 / k3s arm64 deploy that turned into a retry loop: ~1800 of these in two
// hours and a permanent "Can't reach the controller".
//
// Fixed upstream by nodejs/node#62040, shipped in v24.15.0 / v25.8.1 and never
// backported to the 22.x line (22.23.2 still reproduces, on amd64 AND arm64).
// This runs inside `web/Dockerfile`'s runner stage so a future base-image
// change back to an affected runtime fails the build instead of shipping.
//
// Body is the upstream reproduction from nodejs/node#62036, verbatim in shape.
import { TransformStream } from 'node:stream/web';
import { setTimeout as delay } from 'node:timers/promises';

const stream = new TransformStream({
  transform(chunk, controller) {
    controller.enqueue(chunk);
  },
});

await delay(50);

const reader = stream.readable.getReader();
const writer = stream.writable.getWriter();

const pendingRead = reader.read();
const pendingCancel = reader.cancel(new Error('client disconnected'));
const pendingLateWrite = writer.write('late-write');

const results = await Promise.allSettled([pendingRead, pendingCancel, pendingLateWrite]);

const leaked = results.find(
  (r) =>
    r.status === 'rejected' &&
    /transformAlgorithm is not a function/.test(String(r.reason?.message ?? r.reason)),
);

if (leaked) {
  console.error(
    `FAIL: ${process.version} leaks the TransformStream cancel race ` +
      `(nodejs/node#62036) — ${leaked.reason?.message ?? leaked.reason}. ` +
      'Use a Node release that carries nodejs/node#62040 (>= 24.15.0).',
  );
  process.exit(1);
}

console.log(`ok: ${process.version} carries the nodejs/node#62040 TransformStream fix`);
