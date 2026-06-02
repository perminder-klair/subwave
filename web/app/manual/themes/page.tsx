import Themes from '../../../components/manual/Themes';
import { pageMeta } from '@/lib/seo';

export const metadata = pageMeta({
  title: 'SUB/WAVE — Manual · Themes',
  description:
    'Theming SUB/WAVE — switch palettes and tailor the look of the player and the broadsheet to your station.',
  path: '/manual/themes',
});

export default function ThemesPage() {
  return <Themes />;
}
