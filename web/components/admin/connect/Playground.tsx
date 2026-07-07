'use client';

import { useMemo, useState } from 'react';
import { Btn } from '../ui';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import { Textarea } from '../../ui/textarea';
import { notify } from '../../../lib/notify';
import type { EndpointDoc } from './types';

interface Props {
  endpoint: EndpointDoc;
  apiBase: string;
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
}

interface Result {
  status: number;
  ms: number;
  body: string;
}

// Substitute :name path params into the path.
function buildPath(path: string, pathParams: Record<string, string>, query: Record<string, string>): string {
  let out = path.replace(/:([A-Za-z0-9_]+)/g, (_, k) => encodeURIComponent(pathParams[k] || `:${k}`));
  const qs = Object.entries(query)
    .filter(([, v]) => v.trim() !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  if (qs) out += `?${qs}`;
  return out;
}

export default function Playground({ endpoint, apiBase, adminFetch }: Props) {
  const [pathParams, setPathParams] = useState<Record<string, string>>(() =>
    Object.fromEntries((endpoint.pathParams || []).map(p => [p.name, p.example != null ? String(p.example) : ''])),
  );
  const [query, setQuery] = useState<Record<string, string>>(() =>
    Object.fromEntries((endpoint.queryParams || []).map(p => [p.name, p.example != null ? String(p.example) : ''])),
  );
  const [body, setBody] = useState(() =>
    endpoint.bodyExample ? JSON.stringify(endpoint.bodyExample, null, 2) : '',
  );
  const [result, setResult] = useState<Result | null>(null);
  const [sending, setSending] = useState(false);

  const relPath = useMemo(() => buildPath(endpoint.path, pathParams, query), [endpoint.path, pathParams, query]);
  const hasBody = endpoint.method !== 'GET' && endpoint.method !== 'DELETE';

  const send = async () => {
    // Guard destructive/air-mutating calls behind an explicit confirm — this
    // hits the LIVE broadcast, not a sandbox.
    if (endpoint.mutatesAir) {
      const ok = window.confirm(
        `${endpoint.method} ${endpoint.path} changes the live broadcast (it may speak, queue, or skip on air). Send it now?`,
      );
      if (!ok) return;
    }

    let parsedBody: string | undefined;
    if (hasBody && body.trim()) {
      try {
        parsedBody = JSON.stringify(JSON.parse(body));
      } catch {
        notify.err('Request body is not valid JSON');
        return;
      }
    }

    setSending(true);
    const started = performance.now();
    try {
      const r = await adminFetch(relPath, {
        method: endpoint.method,
        ...(parsedBody !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: parsedBody } : {}),
      });
      const text = await r.text();
      let pretty = text;
      try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch { /* non-JSON (image/text) — show raw */ }
      setResult({ status: r.status, ms: Math.round(performance.now() - started), body: pretty.slice(0, 20000) });
    } catch (e) {
      setResult({ status: 0, ms: Math.round(performance.now() - started), body: e instanceof Error ? e.message : String(e) });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="mt-3 border-t border-separator-strong pt-3">
      <div className="caption mb-2">Try it</div>

      {(endpoint.pathParams || []).length > 0 && (
        <div className="mb-2 grid gap-2 sm:grid-cols-2">
          {endpoint.pathParams!.map(p => (
            <div key={p.name}>
              <Label className="text-[11px]">{p.name}{p.required ? ' *' : ''}</Label>
              <Input
                value={pathParams[p.name] || ''}
                onChange={e => setPathParams(s => ({ ...s, [p.name]: e.target.value }))}
                placeholder={p.description}
              />
            </div>
          ))}
        </div>
      )}

      {(endpoint.queryParams || []).length > 0 && (
        <div className="mb-2 grid gap-2 sm:grid-cols-2">
          {endpoint.queryParams!.map(p => (
            <div key={p.name}>
              <Label className="text-[11px]">{p.name}{p.required ? ' *' : ''}</Label>
              <Input
                value={query[p.name] || ''}
                onChange={e => setQuery(s => ({ ...s, [p.name]: e.target.value }))}
                placeholder={p.description}
              />
            </div>
          ))}
        </div>
      )}

      {hasBody && (
        <div className="mb-2">
          <Label className="text-[11px]">Request body (JSON)</Label>
          <Textarea
            value={body}
            onChange={e => setBody(e.target.value)}
            rows={Math.min(10, Math.max(3, body.split('\n').length))}
            className="font-mono text-[12px]"
          />
        </div>
      )}

      <div className="flex items-center gap-3">
        <Btn sm tone={endpoint.mutatesAir ? 'danger' : 'solid'} onClick={send} disabled={sending}>
          {sending ? 'Sending…' : `Send ${endpoint.method}`}
        </Btn>
        <code className="truncate text-[11px] text-muted">{apiBase}{relPath}</code>
      </div>

      {result && (
        <div className="mt-3">
          <div className="caption mb-1 flex items-center gap-2">
            <span className={result.status >= 200 && result.status < 300 ? 'text-[var(--accent)]' : 'text-[var(--danger)]'}>
              {result.status || 'error'}
            </span>
            <span className="text-muted">· {result.ms}ms</span>
          </div>
          <pre className="term max-h-80 overflow-auto">{result.body}</pre>
        </div>
      )}
    </div>
  );
}
