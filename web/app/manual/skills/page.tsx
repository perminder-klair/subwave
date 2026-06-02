import CustomSkills from '../../../components/manual/CustomSkills';
import { pageMeta } from '@/lib/seo';

export const metadata = pageMeta({
  title: 'SUB/WAVE — Manual · Custom Skills',
  description:
    'Custom skills for SUB/WAVE — extend the AI DJ with your own behaviours and automations through Claude Code.',
  path: '/manual/skills',
});

export default function CustomSkillsPage() {
  return <CustomSkills />;
}
