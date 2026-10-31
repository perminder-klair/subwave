import { settingsKeys } from '../settings/queries';

export const showKeys = {
  all: ['shows'] as const,
  settings: () => settingsKeys.detail(),
  skills: () => ['shows', 'skills'] as const,
  genres: () => ['shows', 'genres'] as const,
  playlists: () => ['shows', 'playlists'] as const,
  community: () => ['shows', 'community'] as const,
  preparation: () => ['shows', 'preparation'] as const,
  generated: () => ['shows', 'generated'] as const,
  blocklist: () => ['shows', 'blocklist'] as const,
  playlistPosition: (showId: string) => ['shows', 'playlist-position', showId] as const,
};
