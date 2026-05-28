import type { Metadata } from 'next';
import RulesPanel from '../../../components/admin/RulesPanel';

export const metadata: Metadata = {
  title: 'Rules',
};

export default function AdminRulesPage() {
  return <RulesPanel />;
}
