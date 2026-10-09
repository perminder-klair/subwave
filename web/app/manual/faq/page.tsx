import Faq from '../../../components/manual/Faq';
import JsonLd from '@/components/JsonLd';
import { pageMeta } from '@/lib/seo';

export const metadata = pageMeta({
  title: 'SUB/WAVE — Manual · Questions & Answers',
  description:
    'Answers to the most common SUB/WAVE questions — empty rooms, small models, mood tagging, the pickers, and the debug tools.',
  path: '/manual/faq',
});

// FAQPage structured data mirroring the Q&A rendered by <Faq />, kept in sync by
// hand. Answers must be plain-text summaries — that's what Google's FAQ rich
// result expects.
const FAQ = [
  {
    q: 'What happens when no one is listening?',
    a: 'By default nothing changes: the station broadcasts whether anyone is tuned in or not. An optional "Pause when empty" setting stops the AI work (track-picking, spoken links, station IDs) the moment the listener count hits zero, while a fallback playlist keeps music flowing, then wakes the DJ the instant someone tunes in. It exists to save tokens when no one is there to hear the DJ.',
  },
  {
    q: 'Does it work with a small model?',
    a: 'Yes. Start with Track Shortlist: the controller finds eligible tracks and the model makes one structured choice, so it does not need a chain of tool calls. Direct request matching and the direct segments-and-skills runtime can be selected independently for modest local models. Larger or cloud-hosted models can use Agentic Tools where that suits the station.',
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
    q: 'What are Track Shortlist and Agentic Tools?',
    a: 'They are two selectable ways to choose the next song. Track Shortlist prepares a varied list of eligible tracks and asks the model to choose one. Agentic Tools lets a tool-capable model search the library itself before deciding. Both respect the same show, recency and artist rules; neither is presented as the more musical choice.',
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
