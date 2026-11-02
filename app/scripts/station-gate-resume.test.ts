// useStationGate's resume, driven through the hook itself: the app has no renderer to test with and
// no device here, and this wiring (the hold, the `api` it names, tune() toggling) is what gate-resume.ts
// can't see. `react` is swapped for the few hooks it uses: effects run in order after each render,
// and state set in one tick lands together, as React batches it. The player is the real one's
// shape: tune() toggles on what it knows now, stop() always stops, and each render hands over a new
// tune(), so a resume through an old one shows up as 'stale'.

import assert from 'node:assert/strict';
import Module from 'node:module';
import test from 'node:test';
import type { useStationGate as UseStationGate, StationGate } from '../src/hooks/useStationGate.ts';
import type { StationApi } from '../src/lib/api.ts';
import type { StationAuthResult, StationPrivacy } from '../src/lib/station-password.ts';

type Deps = unknown[] | undefined;
type Cleanup = void | (() => void);
interface Cell { value?: unknown; deps?: Deps; cleanup?: Cleanup }

const sameDeps = (a: Deps, b: Deps) => !!a && !!b && a.every((x, i) => Object.is(x, b[i]));

class Host {
  private cells: Cell[] = [];
  private cursor = 0;
  private effects: (() => void)[] = [];
  dirty = true;

  private cell(): Cell {
    return (this.cells[this.cursor++] ??= {});
  }

  useState<T>(init: T): [T, (next: T | ((prev: T) => T)) => void] {
    const c = this.cell();
    if (!('value' in c)) c.value = init;
    const set = (next: T | ((prev: T) => T)) => {
      const value = typeof next === 'function' ? (next as (prev: T) => T)(c.value as T) : next;
      if (!Object.is(value, c.value)) {
        c.value = value;
        this.dirty = true;
      }
    };
    return [c.value as T, set];
  }

  useRef<T>(current: T): { current: T } {
    const c = this.cell();
    c.value ??= { current };
    return c.value as { current: T };
  }

  useCallback<T>(fn: T, deps: Deps): T {
    const c = this.cell();
    if (!sameDeps(c.deps, deps)) {
      c.deps = deps;
      c.value = fn;
    }
    return c.value as T;
  }

  useEffect(fn: () => Cleanup, deps: Deps): void {
    const c = this.cell();
    if (sameDeps(c.deps, deps)) return;
    c.deps = deps;
    this.effects.push(() => {
      if (typeof c.cleanup === 'function') c.cleanup();
      c.cleanup = fn();
    });
  }

  render(hook: () => void): void {
    while (this.dirty) {
      this.dirty = false;
      this.cursor = 0;
      host = this;
      hook();
      const effects = this.effects;
      this.effects = [];
      for (const effect of effects) effect();
    }
  }
}

let host: Host;
const react = {
  useState: <T>(init: T) => host.useState(init),
  useRef: <T>(current: T) => host.useRef(current),
  useCallback: <T>(fn: T, deps: Deps) => host.useCallback(fn, deps),
  useEffect: (fn: () => Cleanup, deps: Deps) => host.useEffect(fn, deps),
};

// Before the hook loads: it imports react at the top of its module.
const moduleInternals = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
const realLoad = moduleInternals._load;
moduleInternals._load = function load(request, ...rest) {
  return request === 'react' ? react : realLoad.call(this, request, ...rest);
};
// eslint-disable-next-line @typescript-eslint/no-require-imports -- must run after the swap above
const { useStationGate } = require('../src/hooks/useStationGate.ts') as { useStationGate: typeof UseStationGate };
moduleInternals._load = realLoad;

const STREAM_LOCK: StationPrivacy = { privatePlayer: false, listenerAuth: true };
const PRIVATE_PLAYER: StationPrivacy = { privatePlayer: true, listenerAuth: false };

function station(password: string, answers: StationAuthResult[] = []) {
  const asked: string[] = [];
  const api = {
    checkStationAuth: async (pw: string) => {
      asked.push(pw);
      return answers.shift() ?? (pw === password ? 'ok' : 'denied');
    },
    stationAuthHeldUntil: () => 0,
  } as unknown as StationApi;
  return { api, asked };
}

function mount(first: StationApi, privacy: StationPrivacy | null, saved: string | null = null) {
  const h = new Host();
  const tunes: string[] = [];
  let renders = 0;
  const rig = {
    api: first,
    privacy,
    stationPassword: saved,
    tunedIn: false,
    gate: null as unknown as StationGate,
    tunes,
    /** The listener's own press, or any path that puts them on air. */
    press() {
      rig.tunedIn = true;
      h.dirty = true;
      rig.flush();
    },
    change(next: Partial<Pick<typeof rig, 'api' | 'privacy' | 'stationPassword'>>) {
      Object.assign(rig, next);
      h.dirty = true;
      rig.flush();
    },
    flush() {
      h.render(() => {
        const render = (renders += 1);
        rig.gate = useStationGate({
          api: rig.api,
          privacy: rig.privacy,
          stationPassword: rig.stationPassword,
          loginPassword: null,
          rememberStationPassword: remember,
          forgetStationPassword: forget,
          tunedIn: rig.tunedIn,
          status: rig.tunedIn ? 'playing' : 'idle',
          stop,
          tune: () => tune(render),
        });
      });
    },
    async settle() {
      for (let i = 0; i < 8; i += 1) {
        await new Promise((r) => setImmediate(r));
        rig.flush();
      }
    },
    async type(password: string) {
      const result = rig.gate.unlock(password);
      await rig.settle();
      return result;
    },
  };
  const stop = () => {
    tunes.push('stop');
    rig.tunedIn = false;
    h.dirty = true;
  };
  const tune = (render: number) => {
    if (render !== renders) tunes.push('stale');
    if (rig.tunedIn) return stop();
    tunes.push('tune');
    rig.tunedIn = true;
    h.dirty = true;
  };
  const remember = async (password: string) => {
    rig.stationPassword = password;
    h.dirty = true;
  };
  const forget = async () => {
    rig.stationPassword = null;
    h.dirty = true;
  };
  return rig;
}

test('a lock switched on mid-listen: wrong, 429 and unavailable stay stopped, and the right password plays', async () => {
  const { api } = station('right', ['denied', 'rate-limited', 'unavailable']);
  const rig = mount(api, null);
  rig.flush();
  rig.press();
  rig.change({ privacy: STREAM_LOCK });
  await rig.settle();
  assert.equal(rig.gate.phase, 'prompt');
  assert.deepEqual(rig.tunes, ['stop']);

  assert.equal(await rig.type('right'), 'denied');
  assert.equal(await rig.type('right'), 'rate-limited');
  assert.equal(await rig.type('right'), 'unavailable');
  assert.deepEqual(rig.tunes, ['stop']);
  assert.equal(rig.tunedIn, false);

  assert.equal(await rig.type('right'), 'ok');
  assert.equal(rig.gate.phase, 'ok');
  assert.deepEqual(rig.tunes, ['stop', 'tune']);
  assert.equal(rig.tunedIn, true);
});

test('a saved password refused mid-listen: the private player holds its listener too', async () => {
  const { api } = station('new');
  const rig = mount(api, null, 'old');
  rig.flush();
  rig.press();
  rig.change({ privacy: PRIVATE_PLAYER });
  await rig.settle();
  assert.equal(rig.gate.savedRejected, true);
  await rig.type('new');
  assert.deepEqual(rig.tunes, ['stop', 'tune']);
});

test('a password forgotten while tuned in brings the prompt, and the right one plays', async () => {
  const { api } = station('right');
  const rig = mount(api, STREAM_LOCK, 'right');
  rig.flush();
  await rig.settle();
  assert.equal(rig.gate.phase, 'ok');
  rig.press();
  rig.change({ stationPassword: null });
  await rig.settle();
  assert.equal(rig.gate.phase, 'prompt');
  await rig.type('right');
  assert.deepEqual(rig.tunes, ['stop', 'tune']);
});

test('a first visit starts nothing', async () => {
  const { api } = station('right');
  const rig = mount(api, STREAM_LOCK);
  rig.flush();
  await rig.settle();
  await rig.type('right');
  assert.equal(rig.gate.phase, 'ok');
  assert.deepEqual(rig.tunes, []);
});

test('a listener who stopped before the prompt stays stopped', async () => {
  const { api } = station('right');
  const rig = mount(api, null);
  rig.flush();
  rig.press();
  rig.tunedIn = false;
  rig.change({ privacy: STREAM_LOCK });
  await rig.settle();
  await rig.type('right');
  assert.deepEqual(rig.tunes, []);
});

test("a station switch under the prompt drops the hold: the next station's password starts nothing", async () => {
  const a = station('a-pass');
  const b = station('b-pass');
  const rig = mount(a.api, null);
  rig.flush();
  rig.press();
  rig.change({ privacy: STREAM_LOCK });
  await rig.settle();
  assert.deepEqual(rig.tunes, ['stop']);

  rig.change({ api: b.api });
  await rig.settle();
  assert.equal(rig.gate.phase, 'prompt');
  await rig.type('b-pass');
  assert.equal(rig.gate.phase, 'ok');
  assert.deepEqual(rig.tunes, ['stop']);
});

test('an answer that lands after a station switch resumes nobody', async () => {
  const a = station('a-pass');
  const b = station('b-pass');
  const rig = mount(a.api, null);
  rig.flush();
  rig.press();
  rig.change({ privacy: STREAM_LOCK });
  await rig.settle();
  const typed = rig.gate.unlock('a-pass');
  rig.change({ api: b.api });
  assert.equal(await typed, 'unavailable');
  await rig.settle();
  assert.deepEqual(rig.tunes, ['stop']);
  assert.equal(rig.tunedIn, false);
});

test('a remote Play while the check is out is stopped by the gate, and the pass still plays once', async () => {
  const { api } = station('right');
  const rig = mount(api, null);
  rig.flush();
  rig.press();
  rig.change({ privacy: STREAM_LOCK });
  await rig.settle();
  const typed = rig.gate.unlock('right');
  rig.press();
  assert.equal(await typed, 'ok');
  await rig.settle();
  assert.deepEqual(rig.tunes, ['stop', 'stop', 'tune']);
  assert.equal(rig.tunedIn, true);
});

test('the hold is spent on the pass: a later prompt finds a stopped listener stopped', async () => {
  const { api } = station('right');
  const rig = mount(api, null);
  rig.flush();
  rig.press();
  rig.change({ privacy: STREAM_LOCK });
  await rig.settle();
  await rig.type('right');
  assert.deepEqual(rig.tunes, ['stop', 'tune']);

  rig.tunedIn = false;
  rig.change({ stationPassword: null });
  await rig.settle();
  assert.equal(rig.gate.phase, 'prompt');
  await rig.type('right');
  assert.deepEqual(rig.tunes, ['stop', 'tune']);
});

test('a lock lifted under the prompt drops the hold with the prompt', async () => {
  const { api } = station('right');
  const rig = mount(api, null);
  rig.flush();
  rig.press();
  rig.change({ privacy: STREAM_LOCK });
  await rig.settle();
  rig.change({ privacy: null });
  await rig.settle();
  assert.equal(rig.gate.phase, 'open');
  rig.change({ privacy: STREAM_LOCK });
  await rig.settle();
  assert.equal(rig.gate.phase, 'prompt');
  await rig.type('right');
  assert.deepEqual(rig.tunes, ['stop']);
});
