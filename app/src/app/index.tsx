import { Redirect } from 'expo-router';
import { useStation } from '@/config/StationContext';
import PlayerScreen from '@/player/PlayerScreen';

// Boot gate: no active station → onboarding; otherwise the player.
export default function Index() {
  const { base } = useStation();
  if (!base) return <Redirect href="/onboarding" />;
  return <PlayerScreen />;
}
