// What the router has been asked lately, and which source answered: the admin
// "Signal path" monitor reads this through GET /internal/activity.
//
// Bounded and in memory only. A request records its endpoint, which station
// process sent it, how long it took and every source call it made. It never
// records a query string, an id, a credential or a payload: the feed answers
// "which backend served that, and how fast", not "what was asked for". An
// error message is kept, because "failed" with no reason is the one thing an
// operator cannot act on, but any URL in it loses its query string first,
// since a backend's API key can ride there (Plex's X-Plex-Token).
//
// Source calls are observed per child source (observeSource, applied in
// registry.buildSource before a merged set composes them), so a routed request
// lights only its real owner and a merged fan-out lights every backend it
// asked. A call made outside a /rest request (a health probe, a Test) has no
// request to land in and is not recorded.

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { UnsupportedError, type HostSource } from './types.js';

export type ActivityState = 'pending' | 'ok' | 'error';
/** `unsupported`: the source lacks the op and the handler degraded around it — not a failure. */
export type CallState = ActivityState | 'unsupported';

export interface ActivityCall {
  source: string;
  op: string;
  ms: number | null;
  state: CallState;
}

export interface ActivityRequest {
  id: string;
  endpoint: string;
  /** Which station process asked, from its user agent: controller | liquidsoap | analyzer, or the agent's product name. */
  client: string;
  at: number;
  ms: number | null;
  state: ActivityState;
  error?: string;
  calls: ActivityCall[];
}

export interface ActivitySnapshot {
  /** Changes when the router restarts, so a reader can drop what it held. */
  session: string;
  now: number;
  since: number;
  capacity: number;
  totals: { requests: number; failed: number };
  requests: ActivityRequest[];
}

export const ACTIVITY_CAPACITY = 60;
const MAX_CALLS = 64;
const MAX_ERROR_CHARS = 240;

const context = new AsyncLocalStorage<ActivityRequest>();
const session = randomUUID();
const since = Date.now();
let requests: ActivityRequest[] = [];
const totals = { requests: 0, failed: 0 };

/** Coarse caller label. Liquidsoap fetches with curl, the controller with Node, the analyzer with Python. */
export function clientOf(userAgent: string | undefined): string {
  const ua = (userAgent ?? '').trim();
  if (!ua) return 'unknown';
  if (/^curl\//i.test(ua)) return 'liquidsoap';
  if (/^(node|undici)\b/i.test(ua)) return 'controller';
  if (/python|aiohttp|urllib|httpx|requests/i.test(ua)) return 'analyzer';
  return (ua.split(/[\s/]/)[0] || 'unknown').slice(0, 24);
}

/** An error message safe to show: URLs keep their path but lose their query string. */
export function redactError(message: string): string {
  const clean = message.replace(/(https?:\/\/[^\s?#"']+)[?#][^\s"']*/gi, '$1?…').replace(/\s+/g, ' ').trim();
  return clean.length > MAX_ERROR_CHARS ? `${clean.slice(0, MAX_ERROR_CHARS - 1)}…` : clean;
}

/**
 * Run one /rest request inside a recorded context. The request settles when
 * the response finishes (ok unless marked failed or a 4xx/5xx) or the
 * connection closes first (a client that gave up).
 */
export function trackRequest<T>(req: Request, res: Response, endpoint: string, run: () => Promise<T>): Promise<T> {
  const record: ActivityRequest = {
    id: randomUUID(),
    endpoint: endpoint.slice(0, 80),
    client: clientOf(req.get('user-agent')),
    at: Date.now(),
    ms: null,
    state: 'pending',
    calls: [],
  };
  const started = performance.now();
  requests = [record, ...requests].slice(0, ACTIVITY_CAPACITY);
  totals.requests++;

  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    record.ms = Math.round(performance.now() - started);
    if (record.state === 'pending') {
      if (!res.writableFinished) fail(record, 'the client closed the connection before the answer finished');
      else if (res.statusCode >= 400) fail(record, `answered HTTP ${res.statusCode}`);
      else record.state = 'ok';
    }
  };
  res.once('finish', settle);
  res.once('close', settle);
  return context.run(record, run);
}

function fail(record: ActivityRequest, message: string): void {
  if (record.state !== 'error') totals.failed++;
  record.state = 'error';
  record.error ??= redactError(message);
}

/** Mark the current request failed: a Subsonic error rides inside a 200, so the status alone cannot say. */
export function markRequestFailed(message: string): void {
  const record = context.getStore();
  if (record) fail(record, message);
}

export function activitySnapshot(): ActivitySnapshot {
  return {
    session,
    now: Date.now(),
    since,
    capacity: ACTIVITY_CAPACITY,
    totals: { ...totals },
    requests: requests.map((r) => ({ ...r, calls: r.calls.map((c) => ({ ...c })) })),
  };
}

/** Test seam: forget everything recorded so far. */
export function resetActivity(): void {
  requests = [];
  totals.requests = 0;
  totals.failed = 0;
}

const UNOBSERVED = new Set<PropertyKey>(['owns', 'close']);

/**
 * Record every op called on this source while a request is in flight. Wraps a
 * child source, never the merged set, so each call is attributed to the
 * backend that made it. Without a request in context it is a pass-through.
 */
export function observeSource(source: HostSource): HostSource {
  return new Proxy(source, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function' || UNOBSERVED.has(property)) return value;
      return (...args: unknown[]) => {
        const record = context.getStore();
        if (!record || record.calls.length >= MAX_CALLS) return value.apply(target, args);
        const call: ActivityCall = { source: target.name, op: String(property), ms: null, state: 'pending' };
        record.calls.push(call);
        const started = performance.now();
        const done = (state: CallState) => {
          call.ms = Math.round(performance.now() - started);
          call.state = state;
        };
        return Promise.resolve()
          .then(() => value.apply(target, args))
          .then(
            (result) => {
              done('ok');
              return result;
            },
            (err) => {
              done(err instanceof UnsupportedError ? 'unsupported' : 'error');
              throw err;
            },
          );
      };
    },
  });
}
