// Turns what a plugin's stream()/coverArt() returned into bytes the HTTP layer
// can send, and refuses anything that is not media.
//
// The refusal is the important part. Liquidsoap's subhttp protocol and the
// controller's analysis download both write whatever arrives to a temp file;
// a backend that answers an error with a JSON or HTML body (Subsonic servers
// do this inside an HTTP 200) would otherwise land on disk as a "track". The
// controller and Liquidsoap each guard against that too (#1405) — this is the
// same rule enforced once more at the source, so a plugin cannot be the
// weak link.

import type { ByteBody, CoverArt, StreamResult } from '../sdk/types.js';
import type { ResolvedArt, ResolvedStream } from './types.js';

export class MediaError extends Error {
  constructor(
    message: string,
    readonly httpStatus = 502,
  ) {
    super(message);
    this.name = 'MediaError';
  }
}

/** Time allowed for an upstream to START answering. The body may then take as long as it needs. */
const HEADERS_TIMEOUT_MS = Number(process.env.ROUTER_MEDIA_TIMEOUT_MS || 30_000);
const MAX_ART_BYTES = 10 * 1024 * 1024;

const PASS_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges'];

export function isTextual(contentType: string): boolean {
  const t = contentType.toLowerCase();
  return t.includes('json') || t.includes('xml') || t.startsWith('text/') || t.includes('html');
}

async function fetchHeadersOnly(url: string, headers: Record<string, string>): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`no response within ${HEADERS_TIMEOUT_MS}ms`)), HEADERS_TIMEOUT_MS);
  try {
    return await fetch(url, { headers, redirect: 'follow', signal: controller.signal });
  } finally {
    // Cleared once headers are in: the abort must not cut a long body short.
    clearTimeout(timer);
  }
}

async function* fromWeb(stream: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = stream.getReader();
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        return;
      }
      if (value) yield value;
    }
  } finally {
    // An early exit (the client hung up) must cancel the upstream fetch, not
    // just release the lock, or the backend keeps sending a file nobody reads.
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function toIterable(body: ByteBody): AsyncIterable<Uint8Array> {
  if (body instanceof Uint8Array) {
    return (async function* () {
      yield body;
    })();
  }
  if (typeof (body as ReadableStream<Uint8Array>).getReader === 'function') {
    return fromWeb(body as ReadableStream<Uint8Array>);
  }
  return body as AsyncIterable<Uint8Array>;
}

function lowerHeaders(h: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h ?? {})) if (typeof v === 'string') out[k.toLowerCase()] = v;
  return out;
}

function fromResponse(resp: Response): ResolvedStream {
  if (resp.status !== 200 && resp.status !== 206) {
    void resp.body?.cancel().catch(() => {});
    throw new MediaError(`upstream answered HTTP ${resp.status}`);
  }
  const headers: Record<string, string> = {};
  for (const h of PASS_HEADERS) {
    const v = resp.headers.get(h);
    if (v) headers[h] = v;
  }
  return { status: resp.status, headers, body: resp.body ? fromWeb(resp.body) : null };
}

/** Resolve a plugin's StreamResult, forwarding the caller's Range when the router does the fetch. */
export async function resolveStream(result: StreamResult, range: string | undefined): Promise<ResolvedStream> {
  let resolved: ResolvedStream;
  if ('url' in result) {
    const headers = { ...(result.headers ?? {}), ...(range ? { Range: range } : {}) };
    resolved = fromResponse(await fetchHeadersOnly(result.url, headers));
  } else if ('response' in result) {
    resolved = fromResponse(result.response);
  } else {
    const headers = lowerHeaders(result.headers);
    const status = result.status ?? 200;
    if (status !== 200 && status !== 206) throw new MediaError(`plugin produced HTTP ${status}`);
    const kept: Record<string, string> = {};
    for (const h of PASS_HEADERS) if (headers[h]) kept[h] = headers[h]!;
    if (result.body instanceof Uint8Array && !kept['content-length']) kept['content-length'] = String(result.body.byteLength);
    resolved = { status, headers: kept, body: toIterable(result.body) };
  }
  const type = resolved.headers['content-type'] ?? '';
  if (type && isTextual(type)) {
    if (resolved.body) void drain(resolved.body);
    throw new MediaError(`refused a ${type} body where audio was expected`);
  }
  if (!type) resolved.headers['content-type'] = 'application/octet-stream';
  return resolved;
}

async function drain(body: AsyncIterable<Uint8Array>): Promise<void> {
  try {
    const it = body[Symbol.asyncIterator]();
    await it.return?.();
  } catch {
    /* nothing to salvage */
  }
}

export async function resolveArt(result: CoverArt): Promise<ResolvedArt | undefined> {
  if ('url' in result) {
    const resp = await fetchHeadersOnly(result.url, result.headers ?? {});
    if (!resp.ok) {
      void resp.body?.cancel().catch(() => {});
      return undefined;
    }
    const contentType = resp.headers.get('content-type') ?? 'image/jpeg';
    if (isTextual(contentType)) {
      void resp.body?.cancel().catch(() => {});
      return undefined;
    }
    const data = new Uint8Array(await resp.arrayBuffer());
    if (!data.byteLength || data.byteLength > MAX_ART_BYTES) return undefined;
    return { contentType, data };
  }
  if (!result.data || !result.data.byteLength || result.data.byteLength > MAX_ART_BYTES) return undefined;
  if (isTextual(result.contentType)) return undefined;
  return { contentType: result.contentType || 'image/jpeg', data: result.data };
}
