// Subsonic response envelope. JSON is the primary path (the controller always
// sends f=json); a generic JSON→XML mapping covers clients that omit `f` —
// scalars become attributes, objects and arrays child elements — which is
// close enough to the Subsonic XML convention for probes and casual clients.

import type { Request, Response } from 'express';

export const ROUTER_VERSION = '1.0.0';

// `type` is what the controller's connection test shows the operator
// ("subwave-router v1.0.0 (jellyfin)"); `serverVersion` names the source that
// answered, which is the first thing to check when a payload looks wrong.
function base(sourceName: string | undefined): Record<string, unknown> {
  return {
    status: 'ok',
    version: '1.16.1',
    type: 'subwave-router',
    serverVersion: `${ROUTER_VERSION}${sourceName ? ` (${sourceName})` : ''}`,
    openSubsonic: true,
  };
}

function wantsJson(req: Request): boolean {
  return String((req.query as Record<string, unknown>).f ?? '').toLowerCase().startsWith('json');
}

function esc(v: unknown): string {
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function xml(name: string, value: unknown): string {
  if (Array.isArray(value)) return value.map((v) => xml(name, v)).join('');
  if (value !== null && typeof value === 'object') {
    const attrs: string[] = [];
    const children: string[] = [];
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v) || typeof v === 'object') children.push(xml(k, v));
      else attrs.push(`${k}="${esc(v)}"`);
    }
    const open = attrs.length ? `<${name} ${attrs.join(' ')}` : `<${name}`;
    return children.length ? `${open}>${children.join('')}</${name}>` : `${open}/>`;
  }
  return `<${name}>${esc(value)}</${name}>`;
}

function send(req: Request, res: Response, payload: Record<string, unknown>): void {
  if (wantsJson(req)) {
    res.json({ 'subsonic-response': payload });
  } else {
    res
      .type('application/xml')
      .send(`<?xml version="1.0" encoding="UTF-8"?>` + xml('subsonic-response', { xmlns: 'http://subsonic.org/restapi', ...payload }));
  }
}

export function respondOk(req: Request, res: Response, sourceName: string | undefined, body: Record<string, unknown> = {}): void {
  send(req, res, { ...base(sourceName), ...body });
}

// Subsonic errors ride inside a 200 envelope, so `httpStatus` defaults to 200.
//
// The binary endpoints are the exception and must pass a 4xx/5xx. `stream` and
// `getCoverArt` return raw bytes on success, so a caller that gets 200 hands
// the body straight to a decoder — Liquidsoap's subhttp download and the
// controller's analysis fetch would write an error envelope to disk as a
// "track". A non-2xx is what lets them tell audio from "no such id".
export function respondError(
  req: Request,
  res: Response,
  sourceName: string | undefined,
  code: number,
  message: string,
  httpStatus = 200,
): void {
  res.status(httpStatus);
  send(req, res, { ...base(sourceName), status: 'failed', error: { code, message } });
}
