import AgentAccess from '../../../components/manual/AgentAccess';
import { pageMeta } from '@/lib/seo';

export const metadata = pageMeta({
  title: 'SUB/WAVE — Manual · Agent Access',
  description:
    'Agent access to SUB/WAVE over MCP — let Claude and other agents inspect and control your station programmatically.',
  path: '/manual/mcp',
});

export default function AgentAccessPage() {
  return <AgentAccess />;
}
