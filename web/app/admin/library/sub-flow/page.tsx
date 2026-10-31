import type { Metadata } from 'next';
import SubFlowDraft from '../../../../components/admin/SubFlowDraft';

export const metadata: Metadata = { title: 'Sub/Flow' };

export default function SubFlowPage() {
  return <SubFlowDraft />;
}
