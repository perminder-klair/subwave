'use client';

import { useState } from 'react';
import { Pill } from '../ui';
import { notify } from '../../../lib/notify';
import type { EndpointDoc } from './types';
import Playground from './Playground';

interface Props {
  endpoint: EndpointDoc;
  apiBase: string;
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
}

const METHOD_CLASS: Record<string, string> = {
  GET: 'border-[var(--accent)] text-[var(--accent)]',
  POST: 'border-vermilion text-vermilion',
  PUT: 'border-vermilion text-vermilion',
  DELETE: 'border-[var(--danger)] text-[var(--danger)]',
};

// Build a copy-pasteable curl command. Admin endpoints carry a -u placeholder
// (never the operator's cached credentials); the pre-filled body example rides
// along for mutating calls.
function toCurl(ep: EndpointDoc, apiBase: string): string {
  const parts = ['curl'];
  if (ep.method !== 'GET') parts.push('-X', ep.method);
  if (ep.auth === 'admin') parts.push('-u "$ADMIN_USER:$ADMIN_PASS"');
  if (ep.bodyExample && ep.method !== 'GET' && ep.method !== 'DELETE') {
    parts.push('-H "Content-Type: application/json"');
    parts.push(`-d '${JSON.stringify(ep.bodyExample)}'`);
  }
  let path = ep.path;
  if (ep.queryParams?.length) {
    const qs = ep.queryParams
      .filter(p => p.example != null)
      .map(p => `${p.name}=${encodeURIComponent(String(p.example))}`)
      .join('&');
    if (qs) path += `?${qs}`;
  }
  parts.push(`'${apiBase}${path}'`);
  return parts.join(' ');
}

export default function EndpointCard({ endpoint, apiBase, adminFetch }: Props) {
  const [open, setOpen] = useState(false);

  const copyCurl = async () => {
    try {
      await navigator.clipboard.writeText(toCurl(endpoint, apiBase));
      notify.info('curl copied');
    } catch {
      notify.err('Could not copy');
    }
  };

  const allParams = [...(endpoint.pathParams || []), ...(endpoint.queryParams || [])];

  return (
    <details
      open={open}
      onToggle={e => setOpen((e.target as HTMLDetailsElement).open)}
      className="border border-separator-strong bg-bg"
    >
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2">
        <span className={`shrink-0 border px-1.5 py-[2px] text-[10px] font-bold tracking-[0.1em] ${METHOD_CLASS[endpoint.method] || ''}`}>
          {endpoint.method}
        </span>
        <code className="text-[12px] font-semibold">{endpoint.path}</code>
        <span className="truncate text-[11px] text-muted">{endpoint.summary}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {endpoint.auth === 'admin'
            ? <Pill tone="accent">admin</Pill>
            : <Pill>public</Pill>}
          {endpoint.mutatesAir && <Pill className="border-vermilion text-vermilion">on-air</Pill>}
        </span>
      </summary>

      <div className="border-t border-separator-strong px-3 pt-2.5 pb-3">
        <div className="text-[12px] leading-[1.6] text-muted">{endpoint.description}</div>

        {allParams.length > 0 && (
          <div className="mt-3">
            <div className="caption mb-1">Parameters</div>
            <div className="grid gap-1">
              {allParams.map(p => (
                <div key={p.name} className="flex items-baseline gap-2 text-[12px]">
                  <code className="shrink-0 font-semibold">{p.name}</code>
                  {p.required && <span className="text-[10px] text-vermilion">required</span>}
                  <span className="text-muted">{p.description}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="mt-3">
          <div className="caption mb-1 flex items-center gap-3">
            <span>Sample response</span>
            <button type="button" className="text-[11px] text-[var(--accent)] underline" onClick={copyCurl}>
              Copy as curl
            </button>
          </div>
          <pre className="term max-h-64 overflow-auto">
            {typeof endpoint.responseExample === 'string'
              ? endpoint.responseExample
              : JSON.stringify(endpoint.responseExample, null, 2)}
          </pre>
        </div>

        {open && <Playground endpoint={endpoint} apiBase={apiBase} adminFetch={adminFetch} />}
      </div>
    </details>
  );
}
