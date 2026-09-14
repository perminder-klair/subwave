import { clientLabel, type ListenerConnection } from '../../../lib/clientLabel';
import type { SessionTurn } from '../../../lib/types';
import type {
  NowPlayingTrack,
  StationContext,
  ActiveShow,
  DjState,
  ListenerCount,
  QueueEntry,
  StationLocale,
} from '../../../lib/types';
import { AudioLines, Clock3, MessagesSquare, RadioTower, type LucideIcon } from 'lucide-react';


export const SAY_KINDS = [
  { id: 'dj-speak', label: 'Solo' },
  { id: 'link', label: 'Over' },
];
export const SAY_MODES = [
  { id: 'raw', label: 'Raw' },
  { id: 'styled', label: 'Styled' },
];

// Fallback prompts for the manual voice box, used until /generate/say-suggestions
// returns a batch. The controller keeps a canonical copy of these six as the
// generator's style anchors (llm/internal/prompts/generate.ts
// SAY_SUGGESTION_EXAMPLES); keep the two lists in step.
export const SAY_SUGGESTIONS = [
  'Tease the weather like it’s a rumour you can’t quite confirm.',
  'Do a station ID like you suspect nobody’s listening — and you’re fine with it.',
  'Salute the graveyard shift: night drivers, dish pits, the deliberately awake.',
  'Tease the next track without giving up the title.',
  'Remind everyone the request line exists and judges no one.',
  'Announce the time like it’s classified information.',
];

type SegmentType = 'station-id' | 'hourly' | 'link' | 'banter';
export const SEGMENTS: { type: SegmentType; label: string; icon: LucideIcon }[] = [
  { type: 'station-id', label: 'Station ID', icon: RadioTower },
  { type: 'hourly', label: 'Time check', icon: Clock3 },
  { type: 'link', label: 'Track link', icon: AudioLines },
];
// Only offered while a show with guest co-hosts is on air — a one-person
// "exchange" is a 400 from the controller anyway.
export const BANTER_SEGMENT: { type: SegmentType; label: string; icon: LucideIcon } =
  { type: 'banter', label: 'Banter', icon: MessagesSquare };

export interface QueueState {
  upcoming?: QueueEntry[];
  history?: QueueEntry[];
  /** Human-readable description of the imminent seam, derived by the mixer. */
  nextTransition?: string | null;
  autoPick?: boolean;
  autoLink?: boolean;
  pickerBusy?: boolean;
}

export interface DashStatus {
  nowPlaying?: NowPlayingTrack | null;
  context?: StationContext | null;
  dj?: DjState | null;
  listeners?: ListenerCount | number | null;
  streamOnline?: boolean;
  streamBitrate?: number | null;
  activeShow?: ActiveShow | null;
  queue?: QueueState;
  sessionMessages?: SessionTurn[];
  /** Station IANA zone — render on-air timestamps in it (issue #418). */
  timezone?: string;
  locale?: StationLocale;
}

// Subset of /stats (admin) the health strip reads. Polled slower than live
// status: the figures move slowly and the endpoint is heavier.
export interface HealthStats {
  llm?: { count?: number; latency?: { p95?: number }; agentTimeoutMs?: number };
  tts?: { count?: number; fallbackRate?: number | null };
}

export interface ActResponse {
  ok?: boolean;
  spoken?: string;
  error?: string;
}

// Mirrors broadcast/trusted-proxies-pure.ts. `known: false` is an older
// broadcast image or a pair that has not rendered since the upgrade — the UI
// must then show nothing at all, not a miss.
export interface TrustedProxyState {
  known: boolean;
  count: number;
  source: string | null;
  proxies: string[];
  dropped: string[];
}

/** The verdict for an absent marker or an older controller: show nothing. */
export const UNKNOWN_TRUSTED_PROXIES: TrustedProxyState = {
  known: false, count: 0, source: null, proxies: [], dropped: [],
};

export interface ConnectionsState {
  count: number;
  connections: ListenerConnection[];
  /** What the icecast render trusted (#1613). Rides the connections response
   *  so the hint cannot disagree with the rows it is explaining. */
  trustedProxies: TrustedProxyState;
}

// The Listeners table shows the connecting peer whenever no proxy is trusted,
// which on docker-compose.byo.yml is every boot: there is no `caddy` service
// for the DNS path to resolve, so every row renders the edge's container
// address. Say so where the symptom is, rather than only in the broadcast
// container's log. Advisory only — nothing here changes what is displayed.
export function trustedProxyHint(s: TrustedProxyState | undefined): string | null {
  if (!s?.known) return null;
  // Icecast matches an EXACT IP, so a subnet is accepted by the operator's
  // editor and then never matches anything. Said whether or not something else
  // resolved: an operator who set the var to a CIDR ALONE reads the miss below
  // as "my setting was ignored" and has no way to learn why it was.
  const dropped = s.dropped.length
    ? ` Ignored ${s.dropped.join(', ')} — it matches an exact IP, so a subnet or hostname never matches.`
    : '';
  if (s.count === 0) {
    const why = s.source === 'ICECAST_TRUSTED_PROXY_HOSTS'
      ? 'no proxy hostname resolved, so Icecast can’t tell which address is the real client'
      : 'no trusted proxy was resolved';
    return `Showing the connecting peer: ${why}. Set ICECAST_TRUSTED_PROXY_IPS to your edge’s address and restart the broadcast container.${dropped}`;
  }
  return dropped.trim() || null;
}

// Mirrors the durable record the controller's request-log writes (GET /requests).
export interface RequestEntry {
  t?: string;
  requester?: string;
  text?: string;
  status?: string;
  ms?: number | null;
  path?: string | null;
  pickSource?: string | null;
  intent?: string | null;
  mood?: string | null;
  scope?: string | null;
  sort?: string | null;
  artist?: string | null;
  genre?: string | null;
  language?: string | null;
  searchTerms?: string[] | null;
  track?: { title?: string; artist?: string; id?: string } | null;
  ack?: string | null;
  introScript?: string | null;
  message?: string | null;
}

// Likes left the dash in #1253 — they live on the Library page's Liked mode now.
// GET /likes still serves the totals + top + recent shape for API callers.

// Hide the host portion so a glance at the screen doesn't expose a listener's full
// address: IPv4 drops the last octet, IPv6 keeps the routing prefix. A display
// default, not redaction — the raw IP is still in the row's title attribute.
export function maskIp(ip: string): string {
  if (!ip) return '—';
  if (ip.includes('.')) return ip.replace(/\.\d+$/, '.×');
  if (ip.includes(':')) {
    const groups = ip.split(':').filter(Boolean);
    return groups.length > 2 ? `${groups[0]}:${groups[1]}:×` : ip;
  }
  return ip;
}

export type SortKey = 'ip' | 'mount' | 'connectedSeconds' | 'client';
export interface SortState {
  key: SortKey;
  dir: 'asc' | 'desc';
}

// `client` sorts on the friendly label the operator sees, everything else raw.
export function sortConnections(
  rows: ListenerConnection[],
  { key, dir }: SortState,
): ListenerConnection[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    let cmp: number;
    if (key === 'connectedSeconds') cmp = a.connectedSeconds - b.connectedSeconds;
    else if (key === 'client') cmp = clientLabel(a.userAgent).localeCompare(clientLabel(b.userAgent));
    else cmp = String(a[key]).localeCompare(String(b[key]));
    return cmp * sign;
  });
}


