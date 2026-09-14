// App entry: register the RNTP playback service so OS media controls reach our
// remote handlers even when the JS UI isn't mounted, then hand off to
// expo-router. The service MUST be registered before the router entry runs.
import TrackPlayer from 'react-native-track-player';
import { PlaybackService } from './service';

TrackPlayer.registerPlaybackService(() => PlaybackService);

import 'expo-router/entry';
