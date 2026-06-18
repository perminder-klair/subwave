import Faq from '../../../components/manual/Faq';
import JsonLd from '@/components/JsonLd';
import { pageMeta } from '@/lib/seo';

export const metadata = pageMeta({
  title: 'SUB/WAVE — Manual · Questions & Answers',
  description:
    'Answers to the most common SUB/WAVE questions — empty rooms, small models, mood tagging, the pickers, and the debug tools.',
  path: '/manual/faq',
});

// FAQPage structured data — mirrors the Q&A rendered by <Faq />. Kept in sync
// by hand; answers are plain-text summaries of the prose on the page, which is
// what Google's FAQ rich result expects.
const FAQ = [
  {
    q: 'What happens when no one is listening?',
    a: 'By default nothing changes: the station broadcasts whether anyone is tuned in or not. An optional "Pause when empty" setting stops the AI work (track-picking, spoken links, station IDs) the moment the listener count hits zero, while a fallback playlist keeps music flowing, then wakes the DJ the instant someone tunes in. It exists to save tokens when no one is there to hear the DJ.',
  },
  {
    q: 'Does it work with a small model?',
    a: 'Yes. The AI DJ does not need a frontier model; a modest local one is plenty. A 9B-class model such as Qwen3.5 9B comfortably picks tracks and writes the DJ’s lines when run on lean settings: reasoning off, the simpler track-picker, and concise scripts. A 12B-class model like Gemma 4 12B is the comfortable sweet spot — capable enough to run the full conversational picker agent on your own hardware while still costing nothing per token.',
  },
  {
    q: 'What is mood tagging?',
    a: 'Every track can carry a mood: a label like calm, energetic or reflective. The station tags the library in the background and the DJ leans on those tags to pick music that fits the time of day, the weather, and the show that is on. Untagged tracks still play; they just are not matched by feel.',
  },
  {
    q: 'What are the "deploy" and "control" SUB/WAVE skills?',
    a: 'Two helper skills used through Claude Code. subwave-deploy handles installing and updating: first-time setup or pulling the latest code and rebuilding only what changed. subwave-control is lighter: it just starts or stops the station in development or production mode, with no builds.',
  },
  {
    q: 'What are the candidate pool and the agentic picker?',
    a: 'Two ways the DJ chooses the next song. The candidate pool gathers a shortlist from your library (similar songs and artists, mood matches, recently-added and frequently-played albums), caps it, and asks the model to pick one. The agentic picker is a small reasoning loop with session memory and tools to search the library itself, so its choices stay coherent across a run. It is on by default and falls back to the candidate pool if it fails or runs slow.',
  },
  {
    q: 'Why is there a debug page?',
    a: 'The admin console’s Debug page is a live snapshot of the station’s inner workings: recent AI calls and whether they succeeded, the audio mixer’s status, and the latest log lines. It is the first place to look when the stream stalls, the DJ goes quiet, or a voice sounds wrong. For behaviour over time there is also the subwave-log-analysis skill.',
  },
];

const FAQ_JSONLD = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: FAQ.map(({ q, a }) => ({
    '@type': 'Question',
    name: q,
    acceptedAnswer: { '@type': 'Answer', text: a },
  })),
};

export default function FaqPage() {
  return (
    <>
      <JsonLd data={FAQ_JSONLD} />
      <Faq />
    </>
  );
}
