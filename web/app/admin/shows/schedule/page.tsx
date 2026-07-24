import type { Metadata } from 'next';
import SchedulePanel from '../../../../components/admin/schedule/SchedulePanel';

export const metadata: Metadata = { title: 'Schedule' };

export default function AdminSchedulePage() {
  return <SchedulePanel />;
}
