'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { AdminFetch } from '../../lib/admin-query';
import AiringReviews from './AiringReviews';
import ResearchGaps, { useResearchGapsQuery } from './ResearchGaps';
import { Seg } from './ui';

export default function NotesReviews({adminFetch,timezone,readOnly}: {
  adminFetch: AdminFetch; timezone?: string; readOnly: boolean;
}) {
  const params = useSearchParams(), router = useRouter(), pathname = usePathname();
  const gaps = useResearchGapsQuery(adminFetch);
  const view = params.get('reviewView') === 'gaps' ? 'gaps' : 'flagged';
  return <div className="space-y-4">
    <Seg aria-label="Review sections" value={view} options={[
      {id:'flagged',label:'Flagged reviews'}, {id:'gaps',label:gaps.data?.counts.attention?`Research gaps (${gaps.data.counts.attention})`:'Research gaps'},
    ]} onChange={value=>{
      const next = new URLSearchParams(params.toString());
      if (value === 'flagged') next.delete('reviewView'); else next.set('reviewView','gaps');
      router.replace(`${pathname}?${next}`,{scroll:false});
    }} />
    {/* Keep fact-correction drafts when moving between the two sections. */}
    <div hidden={view !== 'flagged'}><AiringReviews adminFetch={adminFetch} timezone={timezone} active={view==='flagged'} /></div>
    {view === 'gaps' && <ResearchGaps adminFetch={adminFetch} timezone={timezone} readOnly={readOnly} />}
  </div>;
}
