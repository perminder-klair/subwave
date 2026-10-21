'use client';

// The review step for a skill's quarantined tool.mjs. Code that arrived in an
// imported zip or a restored backup is held as tool.mjs.pending and has not
// run; this shows its source and is the only place it can be trusted. Trust
// sends back the digest of the source shown, so code that changed underneath
// the operator is refused rather than loaded unread.
import { useState } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { notify, errorMessage } from '../../../lib/notify';
import { useAdminAuth } from '../../../lib/adminAuth';
import { adminJson, useAdminMutation } from '../../../lib/admin-query';
import { Btn } from '../ui';
import {
  skillKeys,
  usePendingToolQuery,
  writeInstalledSkills,
  type SkillsResponse,
} from './queries';

interface PendingToolReviewProps {
  slug: string;
  fileId: string;
  onResolved: () => void | Promise<void>;
}

export default function PendingToolReview({ slug, fileId, onResolved }: PendingToolReviewProps) {
  const { adminFetch } = useAdminAuth();
  const pending = usePendingToolQuery(adminFetch, slug, true);
  const [acting, setActing] = useState(false);

  const settle = async (client: QueryClient, response: SkillsResponse) => {
    writeInstalledSkills(client, response);
    client.removeQueries({ queryKey: skillKeys.pendingTool(slug), exact: true });
    await client.invalidateQueries({ queryKey: skillKeys.file(fileId), exact: true, refetchType: 'none' });
  };
  const trustMutation = useAdminMutation<SkillsResponse, { sha256: string }>({
    adminFetch,
    request: ({ sha256 }, fetcher) => adminJson(fetcher, `/dj/skills/${encodeURIComponent(slug)}/tool/trust`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sha256 }),
    }),
    onDone: (response, _vars, client) => settle(client, response),
    toastOnError: false,
  });
  const discardMutation = useAdminMutation<SkillsResponse, void>({
    adminFetch,
    request: (_vars, fetcher) => adminJson(
      fetcher, `/dj/skills/${encodeURIComponent(slug)}/tool/pending`, { method: 'DELETE' },
    ),
    onDone: (response, _vars, client) => settle(client, response),
    toastOnError: false,
  });

  const run = async (what: 'trust' | 'discard') => {
    setActing(true);
    try {
      if (what === 'trust') {
        if (!pending.data) return;
        await trustMutation.mutateAsync({ sha256: pending.data.sha256 });
        notify.ok(`Trusted “${slug}”'s tool.mjs — it is loaded now`);
      } else {
        await discardMutation.mutateAsync();
        notify.ok(`Discarded “${slug}”'s pending tool.mjs`);
      }
      await onResolved();
    } catch (e) {
      notify.err(`${what === 'trust' ? 'Trust' : 'Discard'} failed: ${errorMessage(e)}`);
      if (what === 'trust') void pending.refetch();
    } finally {
      setActing(false);
    }
  };

  return (
    <div className="mt-3.5 border border-l-[3px] border-[color-mix(in_oklab,var(--ink)_24%,transparent)] border-l-[var(--danger)] px-3.5 py-3 text-[12px] leading-[1.6] text-muted">
      <div className="font-bold text-ink">Data tool awaiting review</div>
      <p className="mt-1.5 mb-2.5 max-w-[78ch]">
        This skill came with a <code>tool.mjs</code> that has <strong>not been loaded</strong> — none of it
        has run. It would run inside the controller with the same access as the station itself, so
        read it first. Until you trust or discard it the skill can&apos;t air.
      </p>
      {pending.isLoading && <div>Loading source…</div>}
      {pending.error && <div role="alert">Couldn&apos;t load the source: {errorMessage(pending.error)}</div>}
      {pending.data && (
        <>
          <pre
            aria-label={`${slug} tool.mjs source`}
            className="m-0 max-h-80 overflow-auto bg-[color-mix(in_oklab,var(--ink)_6%,transparent)] p-2.5 text-[11px] leading-[1.5] whitespace-pre text-ink"
          >
            {pending.data.source}
          </pre>
          <div className="mt-1.5 text-[10px] break-all tabular-nums">
            {pending.data.bytes} bytes · sha256 {pending.data.sha256}
          </div>
        </>
      )}
      <div className="mt-2.5 flex flex-wrap gap-2">
        <Btn sm disabled={acting || !pending.data} onClick={() => { void run('trust'); }}>
          I&apos;ve read it — trust and load
        </Btn>
        <Btn sm disabled={acting} onClick={() => { void run('discard'); }}>
          Discard code
        </Btn>
      </div>
    </div>
  );
}
