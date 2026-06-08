// App entry. Two responsibilities, in order:
//   1. Register the react-native-track-player playback service so OS media
//      controls (lock screen / CarPlay / Android Auto / headphones) route to
//      our remote handlers even when the JS UI isn't mounted.
//   2. Hand off to expo-router's file-based entry.
//
// The service MUST be registered before the router entry runs.
import TrackPlayer from 'react-native-track-player';
import { PlaybackService } from './service';

TrackPlayer.registerPlaybackService(() => PlaybackService);

import 'expo-router/entry';
