import { BookOpen, Compass, GitBranch, Headphones, ShieldCheck, SlidersHorizontal } from 'lucide-react';

// The sidebar and page tabs describe the same destinations.
export const NOTES_TABS = [
  { id: 'overview', description: 'See the current track, the next track, recent speech and the research queue.', label: 'Overview', icon: BookOpen },
  { id: 'stories', description: 'Browse saved facts and their sources, or manage withdrawn facts.', label: 'Stories', icon: Compass },
  { id: 'heard', description: 'Read confirmed aired speech and flag an exchange for review.', label: 'Heard on air', icon: Headphones },
  { id: 'connections', description: 'Explore artists, albums, tracks and the connections between them.', label: 'Station Brain', icon: GitBranch },
  { id: 'moderation', description: 'Read model findings and decide which changes to apply.', label: 'Review', icon: ShieldCheck },
  { id: 'config', description: 'Control collection, segments, source access and research instructions.', label: 'Settings', icon: SlidersHorizontal },
];
