import Themes from '../../../components/manual/Themes';
import { pageMeta } from '@/lib/seo';

export const metadata = pageMeta({
  title: 'SUB/WAVE — Manual · Skins & Themes',
  description:
    'Skinning and theming SUB/WAVE — swap the player face between six built-in skins, switch palettes, and fork the reference player when you want to go further.',
  path: '/manual/themes',
});

export default function ThemesPage() {
  return <Themes />;
}
