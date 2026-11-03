import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { claimRemotePlay, remotePlay, type RemotePlayHandler } from '../src/lib/remote-play.ts';

function service(opts: { hasStream?: boolean; reloadFails?: boolean } = {}) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      hasStream: () => opts.hasStream ?? true,
      reloadLast: async () => {
        calls.push('reloadLast');
        if (opts.reloadFails) throw new Error('load failed');
      },
      resume: async () => {
        calls.push('resume');
      },
    },
  };
}

function claim(t: TestContext, handler: RemotePlayHandler) {
  t.after(claimRemotePlay(handler));
}

test('a remote Play goes to the mounted player, not a direct reload (#2139)', async (t) => {
  const s = service();
  claim(t, () => {
    s.calls.push('player');
    return true;
  });
  await remotePlay(s.deps);
  assert.deepEqual(s.calls, ['player']);
});

test('with no player mounted, the service reloads the last stream itself', async () => {
  const s = service();
  await remotePlay(s.deps);
  assert.deepEqual(s.calls, ['reloadLast']);
});

test('a player that declines leaves the reload to the service', async (t) => {
  const s = service();
  claim(t, () => false);
  await remotePlay(s.deps);
  assert.deepEqual(s.calls, ['reloadLast']);
});

test('with nothing loaded it only resumes, even with a player mounted', async (t) => {
  // An in-app stop, a station switch or a Cast handoff tore the stream down.
  const s = service({ hasStream: false });
  claim(t, () => {
    s.calls.push('player');
    return true;
  });
  await remotePlay(s.deps);
  assert.deepEqual(s.calls, ['resume']);
});

test('a failed direct reload falls back to a resume', async () => {
  const s = service({ reloadFails: true });
  await remotePlay(s.deps);
  assert.deepEqual(s.calls, ['reloadLast', 'resume']);
});

test("an unmounted player's release leaves a newer claim in place", async (t) => {
  const s = service();
  const releaseOld = claimRemotePlay(() => {
    s.calls.push('old');
    return true;
  });
  claim(t, () => {
    s.calls.push('new');
    return true;
  });
  releaseOld();
  await remotePlay(s.deps);
  assert.deepEqual(s.calls, ['new']);
});

test('a released claim hands remote Plays back to the service', async () => {
  const s = service();
  const release = claimRemotePlay(() => {
    s.calls.push('player');
    return true;
  });
  release();
  await remotePlay(s.deps);
  assert.deepEqual(s.calls, ['reloadLast']);
});
