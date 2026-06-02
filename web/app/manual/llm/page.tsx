import ModelsAndTokens from '../../../components/manual/ModelsAndTokens';
import { pageMeta } from '@/lib/seo';

export const metadata = pageMeta({
  title: 'SUB/WAVE — Manual · Models & Tokens',
  description:
    'Models & tokens for SUB/WAVE — choosing an LLM, running lean on local hardware, and keeping token costs under control.',
  path: '/manual/llm',
});

export default function ModelsAndTokensPage() {
  return <ModelsAndTokens />;
}
