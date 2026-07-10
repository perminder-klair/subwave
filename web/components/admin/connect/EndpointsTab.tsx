'use client';

import { useMemo, useState } from 'react';
import { Card } from '../ui';
import { Input } from '../../ui/input';
import type { Catalog } from './types';
import EndpointCard from './EndpointCard';

interface Props {
  catalog: Catalog;
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
}

export default function EndpointsTab({ catalog, adminFetch }: Props) {
  const [q, setQ] = useState('');

  const groups = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return catalog.groups;
    return catalog.groups
      .map(g => ({
        ...g,
        endpoints: g.endpoints.filter(e =>
          `${e.method} ${e.path} ${e.summary} ${e.description}`.toLowerCase().includes(term),
        ),
      }))
      .filter(g => g.endpoints.length > 0);
  }, [catalog.groups, q]);

  return (
    <div className="grid gap-4">
      <Card>
        <div className="flex flex-wrap items-center gap-3">
          <Input
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Filter endpoints…"
            className="max-w-xs"
          />
          <span className="caption text-muted">
            {groups.reduce((n, g) => n + g.endpoints.length, 0)} endpoint
            {groups.reduce((n, g) => n + g.endpoints.length, 0) === 1 ? '' : 's'}
          </span>
          <span className="caption ml-auto text-muted">
            Base <code>{catalog.apiBase}</code>
          </span>
        </div>
      </Card>

      {groups.map(g => (
        <Card key={g.id} title={g.label} sub={g.blurb}>
          <div className="grid gap-1.5">
            {g.endpoints.map(ep => (
              <EndpointCard
                key={`${ep.method} ${ep.path}`}
                endpoint={ep}
                apiBase={catalog.apiBase}
                adminFetch={adminFetch}
              />
            ))}
          </div>
        </Card>
      ))}

      {groups.length === 0 && (
        <Card><div className="text-[13px] text-muted italic">No endpoints match “{q}”.</div></Card>
      )}
    </div>
  );
}
