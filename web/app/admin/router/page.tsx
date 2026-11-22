import { redirect } from 'next/navigation';

// The router console became the Monitor tab of Admin → Music sources.
export default function AdminRouterPage() {
  redirect('/admin/sources?tab=monitor');
}
