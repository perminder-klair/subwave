export interface BrainCoverage {
  state: 'ready' | 'empty' | 'unexplored' | 'queued' | 'researching' | 'incomplete';
  usableStories: number;
  lastResearchedAt: string | null;
  canQueue: boolean;
  hasResearchHistory: boolean;
}

export type ConnectionEntityType = 'artist' | 'recording' | 'release' | 'release-group' | 'series' | 'library-artist' | 'library-album';
export type ConnectionNodeKind = 'recording' | 'artist' | 'release' | 'series' | 'external-recording' | 'contributor';
export type ConnectionEdgeType = 'samples' | 'sampled-in' | 'cover-of' | 'covered-by'
  | 'producer' | 'writer' | 'performed-by' | 'appears-on' | 'series-membership';

export interface ConnectionNode {
  id: string;
  kind: ConnectionNodeKind;
  entityType: ConnectionEntityType | 'external-recording' | 'contributor' | 'library-track' | 'external-artist';
  entityId: string;
  title: string;
  subtitle: string | null;
  local: boolean;
  expandable: boolean;
  sourceUrl: string | null;
  localTrackId?: string | null;
  localArtistId?: string | null;
  researched?: boolean;
  coverage?: BrainCoverage;
  trackCount?: number;
  connectionCount?: number;
  verifiedConnectionCount?: number;
}

export interface ConnectionEdge {
  id: string;
  source: string;
  target: string;
  type: ConnectionEdgeType;
  label: string;
  provider: string;
  sourceUrl: string | null;
  evidence: string;
  attribution: string | null;
  count?: number;
  sources?: Array<{ evidence: string; sourceUrl: string | null; attribution: string | null }>;
}

export interface ConnectionGraphData {
  active: boolean;
  focusId: string;
  nodes: ConnectionNode[];
  edges: ConnectionEdge[];
  truncated: boolean;
}

export interface ConnectionSearchResult {
  nodeId: string;
  entityType: ConnectionEntityType;
  entityId: string;
  title: string;
  subtitle: string | null;
  kind: 'recording' | 'artist' | 'release' | 'series';
  artistNodeId?: string | null;
  localArtistId?: string | null;
}

export interface PositionedConnectionNode extends ConnectionNode {
  x: number;
  y: number;
}
