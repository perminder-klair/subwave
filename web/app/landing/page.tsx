import Landing from '../../components/Landing';
import { getShowcaseStations } from '@/lib/stations';
import { pageMeta } from '@/lib/seo';

export const metadata = pageMeta({
  title: 'SUB/WAVE — A real internet radio station',
  description:
    'A real internet radio station. Single Icecast stream — every listener hears the same broadcast at the same time, picked and announced by an LLM-driven DJ.',
  path: '/landing',
});

// Fixed app-shell layout — lock out pinch-zoom on mobile. Merges with root.
export const viewport = {
  maximumScale: 1,
  userScalable: false,
};

export default async function LandingPreviewPage() {
  return <Landing stations={await getShowcaseStations()} />;
}
