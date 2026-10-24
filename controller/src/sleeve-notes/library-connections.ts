import { invalidateChangedLocalIdentity } from './local-identity.js';
// Cached provider facts resolved against a separate, periodically refreshed
// Navidrome catalogue. This module performs no provider or LLM calls.
import type Database from 'better-sqlite3';
import { open } from './db.js';
import type { SleeveRelationshipType } from './provider.js';

export type LibraryConnectionType = SleeveRelationshipType | 'writer' | 'producer';
export interface ConnectionLibraryTrack {
  id: string;
  title: string;
  artist: string;
  album?: string | null;
  musicbrainzId?: string | null;
}
export interface ResolvedConnectionTrack extends ConnectionLibraryTrack {
  recordingId: string | null;
  matchBasis: string;
}
export interface LibraryConnection {
  id: string;
  claimId: string;
  sourceRecordingId: string;
  sourceLocalTrackId?: string | null;
  type: LibraryConnectionType;
  targetKind: 'recording' | 'contributor';
  targetProviderId: string;
  targetTitle: string;
  targetArtist: string | null;
  targetUrl: string | null;
  matchState: 'unresolved' | 'matched' | 'ambiguous';
  tracks: ResolvedConnectionTrack[];
}

// Keep version/remix/live qualifiers and punctuation. Folding them would make
// a different recording queueable as the provider's named target.
export function connectionNameKey(value: unknown): string {
  return typeof value === 'string' ? value.normalize('NFKC').replace(/[‘’]/gu, "'")
    .toLocaleLowerCase().replace(/\s+/gu, ' ').trim() : '';
}

/** Artist spelling only, including an optional leading "The". Never fold recording titles. */
export function connectionArtistVariantKey(value: unknown): string {
  return connectionNameKey(value).replace(/^the (?=\S)/u, '').replace(/[.\s\p{Pd}]/gu, '');
}

export function connectionArtistNames(db: Database.Database) {
  const local = new Map<string, Map<string, string>>();
  const identified = new Map<string, Map<string, string>>();
  for (const row of db.prepare('SELECT local_artist_id AS id,name FROM sleeve_connection_library_artists').all() as {id:string;name:string}[]) {
    const variant=connectionArtistVariantKey(row.name);
    if(!variant)continue;
    const group=local.get(variant)??new Map<string,string>();
    group.set(row.id,row.name);local.set(variant,group);
  }
  for (const row of db.prepare('SELECT name,musicbrainz_id AS id FROM sleeve_artists WHERE musicbrainz_id IS NOT NULL').all() as {name:string;id:string}[]) {
    const variant=connectionArtistVariantKey(row.name);
    if(!variant)continue;
    const group=identified.get(variant)??new Map<string,string>();
    group.set(row.id,row.name);identified.set(variant,group);
  }
  return {
    key(value:unknown) {
      const variant=connectionArtistVariantKey(value);
      // Multiple possible identities keep strict spelling; no alias is inferred.
      return variant&&(local.get(variant)?.size??0)<=1&&(identified.get(variant)?.size??0)<=1
        ? variant : connectionNameKey(value);
    },
    canonicalName(value:unknown):string|null {
      const group=identified.get(connectionArtistVariantKey(value));
      return group?.size===1 ? [...group.values()][0] : null;
    },
    libraryName(value:unknown):string|null {
      const group=local.get(connectionArtistVariantKey(value));
      if(group?.size!==1 || (identified.get(connectionArtistVariantKey(value))?.size ?? 0)>1)return null;
      return [...group.values()][0];
    },

  };
}

export function cacheConnectionLibraryTracks(
  db: Database.Database, tracks: readonly ConnectionLibraryTrack[], generation: string,
): void {
  const insert = db.prepare(`INSERT INTO sleeve_connection_library_tracks
    (local_track_id, title, artist, album, musicbrainz_recording_id, title_key, artist_key, scan_generation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(local_track_id) DO UPDATE SET
      title = excluded.title, artist = excluded.artist, album = excluded.album,
      musicbrainz_recording_id = excluded.musicbrainz_recording_id,
      title_key = excluded.title_key, artist_key = excluded.artist_key,
      scan_generation = excluded.scan_generation`);
  db.transaction(() => {
    for (const track of tracks) {
      if (!track.id) continue;
      const mbid = typeof track.musicbrainzId === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(track.musicbrainzId.trim())
        ? track.musicbrainzId.trim().toLowerCase() : null;
      invalidateChangedLocalIdentity(db,track.id,{title:track.title,artist:track.artist,album:track.album,mbid},true);
      if (!connectionNameKey(track.title) || !connectionNameKey(track.artist)) continue;
      insert.run(track.id, track.title, track.artist, track.album ?? null, mbid,
        connectionNameKey(track.title), connectionNameKey(track.artist), generation);
    }
  })();
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function parse(value: string): Record<string, unknown> | null {
  try { return object(JSON.parse(value)); } catch { return null; }
}
function string(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
const TYPES = new Set(['samples', 'sampled_in', 'cover_of', 'covered_by']);

/** Rebuild only the derived index. Stored source claims and operator edits survive. */
function calculateLibraryConnections(db: Database.Database): { edges: LibraryConnection[]; evidence: Map<string, string> } {
  const rows = db.prepare(`SELECT claim.id, claim.entity_id AS recordingId, claim.category,
      claim.evidence, recording.title, artist.name AS artist
    FROM sleeve_claims claim
    JOIN sleeve_source_documents source ON source.id = claim.source_document_id
    JOIN sleeve_recordings recording ON recording.id = claim.entity_id
    LEFT JOIN sleeve_artists artist ON artist.id = recording.artist_id
    WHERE claim.enabled = 1 AND claim.entity_type = 'recording'
      AND source.provider = 'genius' AND claim.category IN ('credits', 'musical-connections') ORDER BY claim.id`)
    .all() as Array<{ id: string; recordingId: string; category: string; evidence: string; title: string; artist: string | null }>;
  const claimRows = new Map(rows.map((row) => [row.id, row]));
  const tracks = db.prepare(`SELECT local_track_id AS id, title, artist, album, musicbrainz_recording_id AS musicbrainzId
    FROM sleeve_connection_library_tracks ORDER BY local_track_id`).all() as ConnectionLibraryTrack[];
  const byId = new Map(tracks.map((track) => [track.id, track]));
  const byMbid = new Map<string, ConnectionLibraryTrack[]>();
  for (const track of tracks) if (track.musicbrainzId) {
    const group = byMbid.get(track.musicbrainzId) ?? []; group.push(track); byMbid.set(track.musicbrainzId, group);
  }
  const recordingRows = db.prepare('SELECT id, musicbrainz_id AS mbid FROM sleeve_recordings').all() as Array<{ id: string; mbid: string | null }>;
  const recordingMbids = new Map(recordingRows.map((row) => [row.id, row.mbid?.toLowerCase() ?? null]));
  const sleeveRecordingForMbid = new Map([...recordingMbids].filter((entry): entry is [string, string] => !!entry[1])
    .map(([id, mbid]) => [mbid, id]));
  const byName = new Map<string, ConnectionLibraryTrack[]>();
  const artistNames=connectionArtistNames(db);
  const key = (title: unknown, artist: unknown) => JSON.stringify([connectionNameKey(title), artistNames.key(artist)]);
  for (const track of tracks) {
    const identity = key(track.title, track.artist);
    const group = byName.get(identity) ?? []; group.push(track); byName.set(identity, group);
  }
  const hasGeniusLocal = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sleeve_genius_local_tracks'").get();
  const hasGeniusSeeds = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sleeve_genius_library_seeds'").get();
  const attachments = db.prepare(`SELECT local_track_id AS localTrackId, recording_id AS recordingId
    FROM sleeve_local_attachments WHERE match_state = 'matched' AND recording_id IS NOT NULL
    ${hasGeniusLocal ? 'UNION SELECT local_track_id AS localTrackId, recording_id AS recordingId FROM sleeve_genius_local_tracks' : ''}
    ${hasGeniusSeeds ? 'UNION SELECT local_track_id AS localTrackId, recording_id AS recordingId FROM sleeve_genius_library_seeds' : ''}`)
    .all() as Array<{ localTrackId: string; recordingId: string }>;
  const byRecording = new Map<string, ConnectionLibraryTrack[]>();
  const recordingForTrack = new Map<string, string>();
  for (const attachment of attachments) {
    const track = byId.get(attachment.localTrackId);
    if (!track) continue;
    if (!recordingForTrack.has(track.id) || recordingMbids.get(attachment.recordingId)) {
      recordingForTrack.set(track.id, attachment.recordingId);
    }
    const group = byRecording.get(attachment.recordingId) ?? []; group.push(track); byRecording.set(attachment.recordingId, group);
  }
  const providerRecordings = new Map<string, Set<string>>();
  const identities = db.prepare(`SELECT entity_id AS recordingId,
      CASE WHEN json_valid(content) THEN json_extract(content, '$.identity.providerId') END AS providerId
    FROM sleeve_source_documents WHERE provider = 'genius' AND entity_type = 'recording'`).all() as Array<{
      recordingId: string; providerId: unknown;
    }>;
  for (const identity of identities) {
    const providerId = string(identity.providerId);
    if (!providerId) continue;
    const ids = providerRecordings.get(providerId) ?? new Set<string>();
    ids.add(identity.recordingId);
    providerRecordings.set(providerId, ids);
  }
  const edges: LibraryConnection[] = [];
  for (const row of rows) {
    const evidence = parse(row.evidence);
    if (!evidence) continue;
    if (row.category === 'musical-connections') {
      const type = string(evidence.type);
      const target = object(evidence.target);
      if (!TYPES.has(type) || !string(target?.providerId) || !string(target?.title)) continue;
      edges.push({ id: `${row.id}:recording`, claimId: row.id, sourceRecordingId: row.recordingId, sourceLocalTrackId: null,
        type: type as SleeveRelationshipType, targetKind: 'recording',
        targetProviderId: string(target?.providerId), targetTitle: string(target?.title),
        targetArtist: string(target?.artist) || null, targetUrl: string(target?.canonicalUrl) || null,
        matchState: 'unresolved', tracks: [] });
    } else {
      const type = evidence.role === 'Writer' ? 'writer' : evidence.role === 'Producer' ? 'producer' : null;
      if (!type || !Array.isArray(evidence.contributors) || !Array.isArray(evidence.names)) continue;
      const names = new Set(evidence.names.map(connectionNameKey));
      // Contributor IDs are the shared identity. Legacy names alone cannot
      // establish that credits on two recordings refer to the same person.
      for (const value of evidence.contributors) {
        const contributor = object(value);
        const id = string(contributor?.providerId);
        const name = string(contributor?.name);
        if (!id || !name || !names.has(connectionNameKey(name))) continue;
        edges.push({ id: `${row.id}:contributor:${id}`, claimId: row.id, sourceRecordingId: row.recordingId, sourceLocalTrackId: null,
          type, targetKind: 'contributor', targetProviderId: id, targetTitle: name,
          targetArtist: null, targetUrl: string(contributor?.canonicalUrl) || null,
          matchState: 'unresolved', tracks: [] });
      }
    }
  }
  const peers = new Map<string, LibraryConnection[]>();
  for (const edge of edges.filter((edge) => edge.targetKind === 'contributor')) {
    const identity = `${edge.type}:${edge.targetProviderId}`;
    const group = peers.get(identity) ?? []; group.push(edge); peers.set(identity, group);
  }
  const localRecordingId = (track: ConnectionLibraryTrack) => recordingForTrack.get(track.id)
    ?? (track.musicbrainzId ? sleeveRecordingForMbid.get(track.musicbrainzId) : null) ?? null;
  const recordingTracks = (id: string): ConnectionLibraryTrack[] => {
    const mbid = recordingMbids.get(id);
    return mbid && byMbid.has(mbid) ? byMbid.get(mbid)! : byRecording.get(id) ?? [];
  };
  const resolve = (candidates: ConnectionLibraryTrack[], basis: string, expectedRecordingId?: string): ResolvedConnectionTrack[] => {
    if (!candidates.length) return [];
    if (expectedRecordingId && candidates.some((track) => {
      const identified = localRecordingId(track);
      const mbid = track.musicbrainzId ?? (identified ? recordingMbids.get(identified) : null);
      const expectedMbid = recordingMbids.get(expectedRecordingId);
      return (identified && identified !== expectedRecordingId
        && !byRecording.get(expectedRecordingId)?.some(candidate => candidate.id === track.id))
        || (mbid && expectedMbid && mbid !== expectedMbid);
    })) return [];
    const identities = candidates.map((track) => {
      const recordingId = localRecordingId(track);
      return track.musicbrainzId ?? (recordingId ? recordingMbids.get(recordingId) ?? `sleeve:${recordingId}` : null);
    });
    // Duplicate album/compilation copies are safe only when a stable recording
    // identity proves they are the same recording, rather than another version.
    if (candidates.length > 1 && (!identities[0] || identities.some((id) => id !== identities[0]))) return [];
    const track = candidates[0];
    return [{ ...track, recordingId: localRecordingId(track),
      matchBasis: candidates.length > 1 ? `${basis}:same-recording-copies` : basis }];
  };
  const contributorGroups = new Map<string, { tracks: ResolvedConnectionTrack[]; ambiguous: Set<string> }>();
  for (const [identity, group] of peers) {
    const tracks: ResolvedConnectionTrack[] = [], ambiguous = new Set<string>(), seen = new Set<string>();
    for (const peer of group) {
      if (seen.has(peer.sourceRecordingId)) continue;
      seen.add(peer.sourceRecordingId);
      const row = claimRows.get(peer.claimId)!;
      const identified = recordingTracks(peer.sourceRecordingId);
      const candidates = identified.length ? identified : row.artist ? byName.get(key(row.title, row.artist)) ?? [] : [];
      if (candidates.length > 1) ambiguous.add(peer.sourceRecordingId);
      for (const match of resolve(candidates, 'shared-contributor-id', peer.sourceRecordingId)) {
        tracks.push({ ...match, recordingId: peer.sourceRecordingId });
      }
    }
    contributorGroups.set(identity, { tracks, ambiguous });
  }
  for (const edge of edges) {
    const sourceRow = claimRows.get(edge.claimId)!;
    const sourceTracks = recordingTracks(edge.sourceRecordingId).length ? recordingTracks(edge.sourceRecordingId)
      : byName.get(key(sourceRow.title, sourceRow.artist)) ?? [];
    // Resolve both ends through the same identity/version/duplicate-copy guards.
    edge.sourceLocalTrackId = resolve(sourceTracks, 'source-library-identity', edge.sourceRecordingId)[0]?.id ?? null;
    const sourceTrackIds = new Set(sourceTracks.map((track) => track.id));
    if (edge.targetKind === 'recording') {
      const known = providerRecordings.get(edge.targetProviderId);
      if (known && known.size > 1) { edge.matchState = 'ambiguous'; continue; }
      const identified = known?.size === 1 ? recordingTracks([...known][0]) : [];
      const candidates = identified.length ? identified : edge.targetArtist
        ? byName.get(key(edge.targetTitle, edge.targetArtist)) ?? [] : [];
      const basis=identified.length?'genius-identity':candidates.some(track=>connectionNameKey(track.artist)!==connectionNameKey(edge.targetArtist))
        ?'exact-title-and-artist-variant':'exact-title-and-artist';
      edge.tracks = resolve(candidates, basis, known?.size === 1 ? [...known][0] : undefined)
        .filter((track) => !sourceTrackIds.has(track.id));
      edge.matchState = edge.tracks.length ? 'matched' : candidates.length > 1 ? 'ambiguous' : 'unresolved';
    } else {
      const found = new Map<string, ResolvedConnectionTrack>();
      const group = contributorGroups.get(`${edge.type}:${edge.targetProviderId}`);
      const ambiguous = [...group?.ambiguous ?? []].some((id) => id !== edge.sourceRecordingId);
      for (const match of group?.tracks ?? []) {
        if (match.recordingId === edge.sourceRecordingId || sourceTrackIds.has(match.id)) continue;
        found.set(match.id, match);
        if (found.size >= 24) break;
      }
      edge.tracks = [...found.values()].slice(0, 24);
      edge.matchState = edge.tracks.length ? 'matched' : ambiguous ? 'ambiguous' : 'unresolved';
    }
  }
  return { edges: [...new Map(edges.map((edge) => [edge.id, edge])).values()],
    evidence: new Map(rows.map((row) => [row.id, row.evidence])) };
}

export interface ConnectionLibraryPatch {
  factsRevision: number;
  remove: string[];
  upsert: Array<LibraryConnection & { claimEvidence: string }>;
  matches: Array<{ edgeId: string; tracks: ResolvedConnectionTrack[] }>;
  summary: { edges: number; matched: number; ambiguous: number };
}

export function connectionRevision(db: Database.Database, kind: 'facts' | 'overview'): number {
  return (db.prepare(`SELECT ${kind} AS revision FROM sleeve_connection_revisions WHERE id = 1`)
    .get() as { revision: number }).revision;
}

/** Read/compute in a background process, then publish only changed rows. */
export function buildConnectionLibraryPatch(db: Database.Database): ConnectionLibraryPatch {
  const factsRevision = connectionRevision(db, 'facts');
  const calculated = calculateLibraryConnections(db);
  const existing = db.prepare(`SELECT id, claim_id AS claimId, claim_evidence AS claimEvidence,
    source_recording_id AS sourceRecordingId, source_local_track_id AS sourceLocalTrackId, relationship_type AS type, target_kind AS targetKind,
    target_provider_id AS targetProviderId, target_title AS targetTitle, target_artist AS targetArtist,
    target_url AS targetUrl, match_state AS matchState FROM sleeve_connection_edges`).all() as
    Array<LibraryConnection & { claimEvidence: string }>;
  const previous = new Map(existing.map((edge) => [edge.id, edge]));
  const savedMatches = new Map<string, string[]>();
  for (const row of db.prepare(`SELECT edge_id AS edgeId, local_track_id AS trackId,
    recording_id AS recordingId, match_basis AS basis FROM sleeve_connection_library_matches`).iterate() as
    Iterable<{ edgeId: string; trackId: string; recordingId: string | null; basis: string }>) {
    const group = savedMatches.get(row.edgeId) ?? [];
    group.push(JSON.stringify([row.trackId, row.recordingId, row.basis])); savedMatches.set(row.edgeId, group);
  }
  const signature = (edge: LibraryConnection & { claimEvidence: string }) => JSON.stringify([
    edge.claimId, edge.claimEvidence, edge.sourceRecordingId, edge.sourceLocalTrackId, edge.type, edge.targetKind,
    edge.targetProviderId, edge.targetTitle, edge.targetArtist, edge.targetUrl, edge.matchState,
  ]);
  const upsert: ConnectionLibraryPatch['upsert'] = [];
  const matches: ConnectionLibraryPatch['matches'] = [];
  for (const edge of calculated.edges) {
    const desired = { ...edge, claimEvidence: calculated.evidence.get(edge.claimId)! };
    const saved = previous.get(edge.id);
    if (!saved || signature(saved) !== signature(desired)) upsert.push(desired);
    const before = (savedMatches.get(edge.id) ?? []).sort();
    const after = edge.tracks.map((track) => JSON.stringify([track.id, track.recordingId, track.matchBasis])).sort();
    if (JSON.stringify(before) !== JSON.stringify(after)) matches.push({ edgeId: edge.id, tracks: edge.tracks });
    previous.delete(edge.id);
  }
  return { factsRevision, remove: [...previous.keys()], upsert, matches,
    summary: { edges: calculated.edges.length, matched: calculated.edges.filter((edge) => edge.matchState === 'matched').length,
      ambiguous: calculated.edges.filter((edge) => edge.matchState === 'ambiguous').length } };
}

export function publishConnectionLibraryPatch(db: Database.Database, patch: ConnectionLibraryPatch,
  now = new Date().toISOString()): boolean {
  return db.transaction(() => {
    // Facts/attachments can change while the child is computing. A stale patch
    // never replaces the current index; the next quiet pass recomputes it.
    if (connectionRevision(db, 'facts') !== patch.factsRevision) return false;
    const removeMatches = db.prepare('DELETE FROM sleeve_connection_library_matches WHERE edge_id = ?');
    const removeEdge = db.prepare('DELETE FROM sleeve_connection_edges WHERE id = ?');
    for (const id of patch.remove) { removeMatches.run(id); removeEdge.run(id); }
    const insert = db.prepare(`INSERT INTO sleeve_connection_edges
      (id, claim_id, claim_evidence, source_recording_id, source_local_track_id, relationship_type, target_kind, target_provider_id,
        target_title, target_artist, target_url, match_state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET claim_id=excluded.claim_id, claim_evidence=excluded.claim_evidence,
        source_recording_id=excluded.source_recording_id, source_local_track_id=excluded.source_local_track_id, relationship_type=excluded.relationship_type,
        target_kind=excluded.target_kind, target_provider_id=excluded.target_provider_id,
        target_title=excluded.target_title, target_artist=excluded.target_artist, target_url=excluded.target_url,
        match_state=excluded.match_state, updated_at=excluded.updated_at`);
    for (const edge of patch.upsert) insert.run(edge.id, edge.claimId, edge.claimEvidence, edge.sourceRecordingId,
      edge.sourceLocalTrackId, edge.type, edge.targetKind, edge.targetProviderId, edge.targetTitle, edge.targetArtist, edge.targetUrl, edge.matchState, now);
    const insertMatch = db.prepare(`INSERT INTO sleeve_connection_library_matches
      (edge_id, local_track_id, recording_id, match_basis) VALUES (?, ?, ?, ?)`);
    for (const group of patch.matches) {
      removeMatches.run(group.edgeId);
      for (const track of group.tracks) insertMatch.run(group.edgeId, track.id, track.recordingId, track.matchBasis);
    }
    return true;
  })();
}

export function reconcileLibraryConnections(db: Database.Database, now = new Date().toISOString()): ConnectionLibraryPatch['summary'] {
  const patch = buildConnectionLibraryPatch(db);
  publishConnectionLibraryPatch(db, patch, now);
  return patch.summary;
}

/** Shared read seam for Spark selection, the Graph and future connection skills. */
export function libraryConnectionsInDatabase(db: Database.Database, recordingId: string): LibraryConnection[] {
  const rows = db.prepare(`SELECT edge.id, edge.claim_id AS claimId, edge.source_recording_id AS sourceRecordingId,
      edge.relationship_type AS type, edge.target_kind AS targetKind,
      edge.target_provider_id AS targetProviderId, edge.target_title AS targetTitle,
      edge.target_artist AS targetArtist, edge.target_url AS targetUrl, edge.match_state AS matchState
    FROM sleeve_connection_edges edge JOIN sleeve_claims claim ON claim.id = edge.claim_id
    WHERE edge.source_recording_id = ? AND claim.enabled = 1 AND claim.evidence = edge.claim_evidence
      ORDER BY edge.id`).all(recordingId) as Omit<LibraryConnection, 'tracks'>[];
  const matches = db.prepare(`SELECT track.local_track_id AS id, track.title, track.artist, track.album,
      match.recording_id AS recordingId, match.match_basis AS matchBasis
    FROM sleeve_connection_library_matches match
    JOIN sleeve_connection_library_tracks track ON track.local_track_id = match.local_track_id
    JOIN sleeve_connection_edges edge ON edge.id = match.edge_id
    WHERE match.edge_id = ? AND (edge.target_kind = 'recording' OR EXISTS (
      SELECT 1 FROM sleeve_connection_edges peer JOIN sleeve_claims claim ON claim.id = peer.claim_id
      WHERE peer.source_recording_id = match.recording_id AND claim.enabled = 1 AND claim.evidence = peer.claim_evidence
        AND peer.target_kind = 'contributor' AND peer.target_provider_id = edge.target_provider_id
        AND peer.relationship_type = edge.relationship_type
    )) ORDER BY track.artist, track.title, track.local_track_id`);
  return rows.map((row) => {
    const tracks = matches.all(row.id) as ResolvedConnectionTrack[];
    return { ...row, tracks, matchState: row.matchState === 'matched' && !tracks.length ? 'unresolved' : row.matchState };
  });
}
export function libraryConnectionsForRecording(recordingId: string): LibraryConnection[] {
  return libraryConnectionsInDatabase(open(), recordingId);
}

export function connectionDirectionGuidance(type: LibraryConnectionType): string {
  return {
    samples: 'The current track samples the linked song. The linked song is the sample source.',
    sampled_in: 'The linked song samples the current track. The current track is the sample source.',
    cover_of: 'The current track is a cover version of the linked song.',
    covered_by: 'The linked song is a cover version of the current track.',
    writer: 'These recordings share the identified writer. This does not establish a cover or sample relationship.',
    producer: 'These recordings share the identified producer. This does not establish a cover or sample relationship.',
  }[type];
}
