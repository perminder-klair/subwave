import PlayerApp from '../components/PlayerApp';
import Landing from '../components/Landing';

// Read at request time so a deployment can flip player ↔ landing by just
// restarting the web container with a different env value, no rebuild.
export const dynamic = 'force-dynamic';

export default function HomePage() {
  const mode = (process.env.SUBWAVE_HOMEPAGE || 'player').toLowerCase();
  return mode === 'landing' ? <Landing /> : <PlayerApp />;
}
