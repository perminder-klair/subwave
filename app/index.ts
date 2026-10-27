// App entry: register the RNTP playback service so OS media controls reach our
// remote handlers even when the JS UI isn't mounted, then hand off to
// expo-router. The service MUST be registered before the router entry runs.
// App Intents register here for the same reason: Siri or a Control can launch
// the app into the background, where no screen may ever mount.
import TrackPlayer from 'react-native-track-player';
import { registerIntentHandlers } from '@/intents/handlers';
import { PlaybackService } from './service';

TrackPlayer.registerPlaybackService(() => PlaybackService);
registerIntentHandlers();

// Registration must run before the router starts the app.
// eslint-disable-next-line import/first
import 'expo-router/entry';
