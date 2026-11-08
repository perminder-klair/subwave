// An artist-scale projection of retained facts. Opening the map performs only
// local reads; the recurring library matcher owns catalogue maintenance.
import type Database from 'better-sqlite3';
import { connectionNameKey } from './library-connections.js';
import type { ConnectionEdge, ConnectionEdgeType, ConnectionGraph, ConnectionNode } from './research-repository.js';

const NODE_CAP = 6000;
const EDGE_CAP = 2400;
const CLAIM_CAP = 20000;
const ARTIST_CAP = 6000;
const RELATION_TYPES: Record<string, ConnectionEdgeType> = {
  samples: 'samples', sampled_in: 'sampled-in', cover_of: 'cover-of', covered_by: 'covered-by',
};
const LABELS: Partial<Record<ConnectionEdgeType, string>> = {
  samples: 'samples tracks by', 'sampled-in': 'has tracks sampled by',
  'cover-of': 'covers tracks by', 'covered-by': 'has tracks covered by',
  writer: 'has tracks written by', producer: 'has tracks produced by',
};
function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function parse(value: string): Record<string, unknown> | null {
  try { return object(JSON.parse(value)); } catch { return null; }
}
function text(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }
function sourceUrl(value: unknown): string | null {
  const url = text(value);
  return /^https?:\/\//iu.test(url) ? url : null;
}

export function researchConnectionsOverviewInDatabase(
  db: Database.Database, edgeTypes?: readonly ConnectionEdgeType[],
): ConnectionGraph {
  const allowed = edgeTypes ? new Set(edgeTypes) : null;
  const nodes = new Map<string, ConnectionNode>();
  const edges = new Map<string, ConnectionEdge>();
  const aggregateEdges = new Map<string, ConnectionEdge & { examples: Set<string> }>();
  const scan = db.prepare('SELECT completed_at AS completedAt FROM sleeve_connection_library_scan WHERE id = 1')
    .get() as { completedAt: string | null } | undefined;
  const artists = db.prepare(`SELECT artist.id, artist.name, artist.musicbrainz_id AS mbid,
      COUNT(DISTINCT CASE WHEN ? THEN catalogue.local_track_id ELSE attachment.local_track_id END) AS trackCount
    FROM sleeve_artists artist LEFT JOIN sleeve_recordings recording ON recording.artist_id = artist.id
    LEFT JOIN sleeve_local_attachments attachment ON attachment.recording_id = recording.id AND attachment.match_state = 'matched'
    LEFT JOIN sleeve_connection_library_tracks catalogue ON catalogue.local_track_id = attachment.local_track_id
    GROUP BY artist.id ORDER BY trackCount DESC, artist.id LIMIT ?`).all(scan?.completedAt ? 1 : 0, ARTIST_CAP + 1) as Array<{
      id: string; name: string; mbid: string | null; trackCount: number;
    }>;
  let truncated = artists.length > ARTIST_CAP;
  const byArtistKey = new Map<string, ConnectionNode[]>();
  for (const artist of artists.slice(0, ARTIST_CAP)) {
    const node: ConnectionNode = { id: `artist:${artist.id}`, kind: 'artist', entityType: 'artist',
      entityId: artist.id, title: artist.name, subtitle: 'Artist', local: artist.trackCount > 0,
      expandable: true, sourceUrl: artist.mbid ? `https://musicbrainz.org/artist/${artist.mbid}` : null,
      trackCount: artist.trackCount, connectionCount: 0, researched: true };
    nodes.set(node.id, node);
    const key = connectionNameKey(artist.name);
    byArtistKey.set(key, [...byArtistKey.get(key) ?? [], node]);
  }
  const identifiedArtists = new Set(artists.filter(artist => artist.mbid).map(artist => artist.id));
  const preferredArtists = (key: string) => {
    const group = byArtistKey.get(key);
    const identified = group?.filter(node => identifiedArtists.has(node.entityId));
    return identified?.length ? identified : group;
  };
  const catalogue = db.prepare(`SELECT artist_key AS key, MIN(artist) AS name, COUNT(*) AS trackCount
    FROM sleeve_connection_library_tracks GROUP BY artist_key ORDER BY trackCount DESC, artist_key LIMIT ?`)
    .all(ARTIST_CAP + 1) as Array<{ key: string; name: string; trackCount: number }>;
  truncated ||= catalogue.length > ARTIST_CAP;
  const catalogueArtists = new Map<string, ConnectionNode>();
  const index = db.prepare(`SELECT local_artist_id AS id, name, name_key AS key
    FROM sleeve_connection_library_artists ORDER BY name COLLATE NOCASE, local_artist_id LIMIT ?`)
    .all(ARTIST_CAP + 1) as Array<{ id: string; name: string; key: string }>;
  truncated ||= index.length > ARTIST_CAP;
  const byLocalName = new Map<string, typeof index>();
  for (const artist of index.slice(0, ARTIST_CAP)) {
    byLocalName.set(artist.key, [...byLocalName.get(artist.key) ?? [], artist]);
  }
  for (const artist of catalogue.slice(0, ARTIST_CAP)) {
    // Library names are display groups, not a new provider identity. A name
    // shared by two canonical artists remains a separate library group.
    const canonical = preferredArtists(artist.key);
    const local = byLocalName.get(artist.key);
    const localId = local?.length === 1 ? local[0].id : null;
    const node: ConnectionNode = canonical?.length === 1 ? canonical[0] : {
      id: `library-artist:${localId ?? artist.key}`, kind: 'artist', entityType: 'library-artist',
      entityId: localId ?? artist.key, title: artist.name, subtitle: 'Library artist · not yet researched',
      local: true, expandable: false, sourceUrl: null, trackCount: 0, connectionCount: 0,
      researched: false,
    };
    if (localId) { node.localArtistId = localId; node.expandable = true; }
    node.trackCount = Math.max(node.trackCount ?? 0, artist.trackCount);
    node.local = true;
    catalogueArtists.set(artist.key, node);
    nodes.set(node.id, node);
  }
  for (const artist of index.slice(0, ARTIST_CAP)) {
    const canonical = preferredArtists(artist.key);
    const unambiguous = byLocalName.get(artist.key)?.length === 1;
    const node: ConnectionNode = unambiguous && canonical?.length === 1 ? canonical[0]
      : nodes.get(`library-artist:${artist.id}`) ?? {
        id: `library-artist:${artist.id}`, kind: 'artist', entityType: 'library-artist', entityId: artist.id,
        title: artist.name, subtitle: 'Library artist · not yet researched', local: true,
        expandable: true, sourceUrl: null, researched: false, connectionCount: 0,
      };
    node.localArtistId = artist.id;
    node.local = true;
    node.expandable = true;
    nodes.set(node.id, node);
    if (unambiguous) catalogueArtists.set(artist.key, node);
  }
  // Provisional per-song artist rows are not distinct artist identities. Fold
  // them into an unambiguous library display group without rewriting evidence.
  const artistDisplayNodes = new Map<string, ConnectionNode>();
  for (const [key, group] of byArtistKey) {
    const library = catalogueArtists.get(key);
    for (const node of group) {
      const display = library && (byLocalName.get(key)?.length ?? 0) <= 1
        && !identifiedArtists.has(node.entityId) ? library : node;
      artistDisplayNodes.set(node.entityId, display);
      if (display.id !== node.id) nodes.delete(node.id);
    }
  }
  const recordingRows = db.prepare('SELECT id, artist_id AS artistId FROM sleeve_recordings')
    .all() as Array<{ id: string; artistId: string | null }>;
  const recordingArtists = new Map(recordingRows.map((row) => [row.id, artistDisplayNodes.get(row.artistId ?? '')]));
  const providerRecordings = new Map<string, Set<string>>();
  // Read just the identity projection rather than materialising every saved
  // provider document in the HTTP process's heap.
  const identities = db.prepare(`SELECT entity_id AS recordingId,
      CASE WHEN json_valid(content) THEN json_extract(content, '$.identity.providerId') ELSE NULL END AS providerId
    FROM sleeve_source_documents WHERE provider = 'genius' AND entity_type = 'recording'`)
    .all() as Array<{ recordingId: string; providerId: unknown }>;
  for (const row of identities) {
    const id = text(row.providerId);
    if (!id) continue;
    const recordings = providerRecordings.get(id) ?? new Set<string>();
    recordings.add(row.recordingId);
    providerRecordings.set(id, recordings);
  }
  const indexed = db.prepare(`SELECT edge.claim_id AS claimId, edge.match_state AS state,
      match.recording_id AS recordingId, track.artist_key AS artistKey
    FROM sleeve_connection_edges edge JOIN sleeve_claims claim ON claim.id = edge.claim_id
    LEFT JOIN sleeve_connection_library_matches match ON match.edge_id = edge.id
    LEFT JOIN sleeve_connection_library_tracks track ON track.local_track_id = match.local_track_id
    WHERE edge.target_kind = 'recording' AND claim.enabled = 1 AND claim.evidence = edge.claim_evidence
    ORDER BY claim.updated_at DESC, claim.id LIMIT ?`)
    .all(CLAIM_CAP) as Array<{ claimId: string; state: string; recordingId: string | null; artistKey: string | null }>;
  const matches = new Map(indexed.map((row) => [row.claimId, row]));
  const claims = db.prepare(`SELECT claim.id, claim.entity_id AS recordingId, claim.category, claim.evidence,
      recording.title, source.source_url AS sourceUrl, source.attribution
    FROM sleeve_claims claim JOIN sleeve_source_documents source ON source.id = claim.source_document_id
    JOIN sleeve_recordings recording ON recording.id = claim.entity_id
    WHERE claim.enabled = 1 AND claim.entity_type = 'recording' AND source.provider = 'genius'
      AND claim.category IN ('musical-connections', 'credits')
    ORDER BY claim.updated_at DESC, claim.id LIMIT ?`).all(CLAIM_CAP + 1) as Array<{
      id: string; recordingId: string; category: string; evidence: string; title: string;
      sourceUrl: string; attribution: string;
    }>;
  truncated ||= claims.length > CLAIM_CAP;
  const addEdge = (from: ConnectionNode, to: ConnectionNode, type: ConnectionEdgeType,
    evidence: string, url: string | null, attribution: string | null, identity: string) => {
    if (from.id === to.id || (allowed && !allowed.has(type))) return;
    const id = JSON.stringify([from.id, to.id, type]);
    const saved = aggregateEdges.get(id);
    if (saved) {
      // Reciprocal provider records can repeat a fact. Count distinct evidence,
      // and retain a bounded set of real examples for the evidence drawer.
      if (saved.examples.has(identity)) return;
      saved.examples.add(identity);
      saved.count = saved.examples.size;
      if (saved.sources!.length < 5) saved.sources!.push({ evidence, sourceUrl: url, attribution });
      return;
    }
    nodes.set(to.id, to);
    const edge = { id, source: from.id, target: to.id, type, label: LABELS[type] ?? type,
      provider: 'genius', sourceUrl: url, evidence, attribution, count: 1,
      sources: [{ evidence, sourceUrl: url, attribution }], examples: new Set([identity]) };
    aggregateEdges.set(id, edge);
    edges.set(id, edge);
  };
  // The internal sets never cross the JSON boundary.
  for (const claim of claims.slice(0, CLAIM_CAP)) {
    const from = recordingArtists.get(claim.recordingId);
    const evidence = parse(claim.evidence);
    if (!from || !evidence) continue;
    if (claim.category === 'musical-connections') {
      const type = RELATION_TYPES[text(evidence.type)];
      const target = object(evidence.target);
      const providerId = text(target?.providerId), title = text(target?.title), name = text(target?.artist);
      if (!type || !providerId || !title || !name || (allowed && !allowed.has(type))) continue;
      const match = matches.get(claim.id);
      const known = providerRecordings.get(providerId);
      let to = match?.state === 'matched'
        ? recordingArtists.get(match.recordingId ?? '') ?? catalogueArtists.get(match.artistKey ?? '')
        : !match && known?.size === 1 ? recordingArtists.get([...known][0]) : undefined;
      if (!to) {
        // This is an unverified display group, not a resolved artist/recording.
        // Different songs naming the same external artist share one label.
        const id = `external-artist:label:${encodeURIComponent(connectionNameKey(name))}`;
        to = nodes.get(id) ?? { id, kind: 'artist', entityType: 'external-artist', entityId: connectionNameKey(name),
          title: name, subtitle: 'External artist references · identity unverified', local: false, expandable: false,
          sourceUrl: sourceUrl(target?.canonicalUrl), trackCount: 0, connectionCount: 0 };
      }
      const labels: Partial<Record<ConnectionEdgeType, string>> = {
        samples: 'samples', 'sampled-in': 'is sampled in', 'cover-of': 'is a cover of', 'covered-by': 'is covered by',
      };
      const label = labels[type];
      addEdge(from, to, type, `${claim.title} by ${from.title} ${label} ${title} by ${name}.`,
        sourceUrl(claim.sourceUrl), claim.attribution, JSON.stringify([claim.recordingId, providerId, type]));
    } else {
      const type = evidence.role === 'Writer' ? 'writer' : evidence.role === 'Producer' ? 'producer' : null;
      if (!type || (allowed && !allowed.has(type)) || !Array.isArray(evidence.contributors) || !Array.isArray(evidence.names)) continue;
      const names = new Set(evidence.names.map(connectionNameKey));
      for (const item of evidence.contributors) {
        const contributor = object(item), id = text(contributor?.providerId), name = text(contributor?.name);
        if (!id || !name || !names.has(connectionNameKey(name))) continue;
        const nodeId = `genius-contributor:${id}`;
        const to: ConnectionNode = nodes.get(nodeId) ?? { id: nodeId, kind: 'contributor', entityType: 'contributor',
          entityId: id, title: name, subtitle: 'Shared writer / producer', local: false, expandable: false,
          sourceUrl: sourceUrl(contributor?.canonicalUrl), connectionCount: 0 };
        addEdge(from, to, type, `${claim.title} by ${from.title} is ${type === 'writer' ? 'written' : 'produced'} by ${name}.`,
          sourceUrl(claim.sourceUrl), claim.attribution, `${claim.recordingId}:${id}:${type}`);
      }
    }
  }
  const people = new Map<string, Set<string>>();
  for (const edge of edges.values()) if (edge.type === 'writer' || edge.type === 'producer') {
    const artists = people.get(edge.target) ?? new Set<string>();
    artists.add(edge.source); people.set(edge.target, artists);
  }
  for (const [id, edge] of edges) if ((edge.type === 'writer' || edge.type === 'producer') && (people.get(edge.target)?.size ?? 0) < 2) edges.delete(id);
  for (const [id, node] of nodes) if (node.kind === 'contributor' && (people.get(id)?.size ?? 0) < 2) nodes.delete(id);
  const sharedLocalCredits = new Set<string>();
  for (const [id, artists] of people) {
    let localCount = 0;
    for (const artist of artists) if (nodes.get(artist)?.local && ++localCount > 1) {
      sharedLocalCredits.add(id);
      break;
    }
  }
  for (const edge of edges.values()) {
    for (const id of [edge.source, edge.target]) {
      const node = nodes.get(id)!;
      node.connectionCount = (node.connectionCount ?? 0) + (edge.count ?? 1);
      const source = nodes.get(edge.source)!;
      const target = nodes.get(edge.target)!;
      const sharedLocalCredit = target.kind === 'contributor' && sharedLocalCredits.has(target.id);
      if (source.local && (target.local || sharedLocalCredit)) {
        node.verifiedConnectionCount = (node.verifiedConnectionCount ?? 0) + (edge.count ?? 1);
      }
    }
  }
  // The populated library is the opening constellation. Supplemental external
  // references and credit hubs must not displace its unplayed artists.
  const visible = [...nodes.values()].sort((a, b) => Number(!!b.localArtistId) - Number(!!a.localArtistId)
    || Number((b.connectionCount ?? 0) > 0) - Number((a.connectionCount ?? 0) > 0)
    || Number(b.local) - Number(a.local)
    || (b.connectionCount ?? 0) - (a.connectionCount ?? 0)
    || (b.trackCount ?? 0) - (a.trackCount ?? 0) || a.id.localeCompare(b.id)).slice(0, NODE_CAP);
  const ids = new Set(visible.map((node) => node.id));
  const visibleEdges = [...edges.values()].filter((edge) => ids.has(edge.source) && ids.has(edge.target))
    .slice(0, EDGE_CAP).map((edge) => {
      // Explicit projection omits the private deduplication set.
      const { id, source, target, type, label, provider, sourceUrl, evidence, attribution, count, sources } = edge;
      return { id, source, target, type, label, provider, sourceUrl, evidence, attribution, count, sources };
    });
  truncated ||= nodes.size > visible.length || edges.size > visibleEdges.length;
  return { focusId: '', nodes: visible, edges: visibleEdges, truncated };
}
