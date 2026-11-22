import MastheadView from './MastheadView';
import { IS_OFFICIAL_HOST } from '@/lib/site';

// The masthead for server-rendered pages. The Cloud link sells the project's
// paid offering, so it shows only on the project's own site (IS_OFFICIAL_HOST),
// like the landing page's Classified; app/cloud 404s everywhere else.
export default function Masthead() {
  return <MastheadView cloud={IS_OFFICIAL_HOST} />;
}
