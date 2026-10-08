import type { Metadata } from 'next';
import RouterPanel from '../../../components/admin/router/RouterPanel';

export const metadata: Metadata = {
  title: 'Music router',
};

export default function AdminRouterPage() {
  return <RouterPanel />;
}
