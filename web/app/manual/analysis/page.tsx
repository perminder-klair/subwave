import AcousticAnalysis from '../../../components/manual/AcousticAnalysis';
import { pageMeta } from '@/lib/seo';

export const metadata = pageMeta({
  title: 'SUB/WAVE — Manual · Acoustic Analysis',
  description:
    'Acoustic analysis for SUB/WAVE — the default lean analyzer (bpm, key, intro, loudness), and enabling the heavy tier (CLAP "sounds-like" fingerprints + Demucs vocal detection) with ANALYZER_HEAVY=1.',
  path: '/manual/analysis',
});

export default function AcousticAnalysisPage() {
  return <AcousticAnalysis />;
}
