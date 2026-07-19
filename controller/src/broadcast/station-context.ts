// Station contexts — one isolated runtime per sub-station channel.
//
// A StationContext bundles the per-stream mutable state the controller keeps
// for a broadcast: the queue (single writer of that stream's next.txt /
// say.txt / intro.txt, with its own now-playing watcher and voice chain) and
// the DJ session store (chat history persisted under the channel's state
// dir). The MAIN station keeps using the module singletons (broadcast/queue
// `queue`, broadcast/session's default store) — it is intentionally NOT in
// this registry, so every pre-channels call path stays untouched.
//
// Lifecycle: server.ts calls sync() at boot after settings.load(); the
// settings route calls it again after every save that touches channels. The
// reconcile mirrors the broadcast supervisor's: create contexts for newly
// enabled channels (recover + start the watcher), tear down removed ones
// (stop the watcher; on-disk state stays — operator data is never deleted
// implicitly).

import { Queue } from './queue.js';
import { createSessionStore, type SessionStore } from './session.js';
import { channelPaths } from '../config.js';
import * as settings from '../settings.js';

export interface StationContext {
  channel: settings.Channel;
  queue: InstanceType<typeof Queue>;
  session: SessionStore;
}

const contexts = new Map<string, StationContext>();

// A channel's on-air persona: its own personaId override, else the STATION's
// base active persona (deliberately not getEffectivePersona() — that follows
// the main station's hourly show grid, and a channel must not change voice
// because the main station's schedule flipped).
function personaResolver(channelId: string) {
  return () => {
    const s = settings.get();
    const ch = settings.channelById(channelId, s);
    const p = ch?.personaId ? settings.resolvePersonaById(ch.personaId) : null;
    return p
      || settings.resolvePersonaById(s.activePersonaId)
      || settings.getEffectivePersona();
  };
}

// A channel's "active show" is its pinned show — time-invariant (a channel is
// a 24/7 broadcast of one identity). Resolved live so a show edit applies on
// the next pick without a context rebuild.
function showResolver(channelId: string) {
  return () => {
    const s = settings.get();
    const ch = settings.channelById(channelId, s);
    return ch ? settings.channelShow(ch, s) : null;
  };
}

function create(channel: settings.Channel): StationContext {
  const paths = channelPaths(channel.id);
  const personaFor = personaResolver(channel.id);
  const session = createSessionStore({
    paths: paths.session,
    personaFor,
  });
  const queue = new Queue({
    paths: { liquidsoap: paths.liquidsoap, queue: paths.queue },
    telnetPort: channel.telnetPort,
    channelId: channel.id,
    session,
    personaFor,
    activeShowFor: showResolver(channel.id),
  });
  return { channel, queue, session };
}

// Reconcile the registry against settings.channels. Safe to call repeatedly.
export function sync() {
  const s = settings.get();
  const want = new Map(settings.enabledChannels(s).map(c => [c.id, c]));

  for (const [id, ctx] of contexts) {
    if (!want.has(id)) {
      ctx.queue.stopWatcher();
      contexts.delete(id);
      ctx.queue.log('scheduler', `Channel "${id}" context stopped (disabled/removed)`);
    }
  }

  for (const [id, channel] of want) {
    const existing = contexts.get(id);
    if (existing) {
      // Keep the live context; refresh the channel snapshot (name/frequency/
      // overrides are read live via settings anyway, telnetPort via channel).
      existing.channel = channel;
      existing.queue.telnetPort = channel.telnetPort;
      continue;
    }
    const ctx = create(channel);
    contexts.set(id, ctx);
    // Same boot order as the main station (server.ts): restore the persisted
    // queue and session, then start watching the channel's now-playing.json —
    // the watcher is what drives the channel's DJ picks via runTrackEvent.
    // Session recovery is best-effort and async (it needs the channel's
    // context snapshot); the queue watcher's own maybeRoll covers the race.
    ctx.queue.recover();
    void ctx.queue.stationContext()
      .then(c => ctx.session.recover(c))
      .catch(() => {});
    ctx.queue.startWatcher();
    ctx.queue.log('scheduler', `Channel "${id}" context started`);
  }
}

export function get(id: string): StationContext | null {
  return contexts.get(id) ?? null;
}

export function all(): StationContext[] {
  return [...contexts.values()];
}
