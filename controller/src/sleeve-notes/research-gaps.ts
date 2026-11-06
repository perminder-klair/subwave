// Display-only reconciliation of saved knowledge. No provider requests, queue
// admission or identity merging: names group diagnostics, never authorise facts.
import type Database from 'better-sqlite3';
import { connectionNameKey } from './library-connections.js';
import type { ResearchGapStatus, ResearchGapSnapshot } from '../schemas/sleeve-notes-research-gaps.js';

type Artist = { id: string; name: string; mbid: string | null };
type Job = { subjectId: string; provider: string; capability: string; state: string; updatedAt: string };
const active = new Set(['queued', 'running', 'retry-at']);

export function researchGapsInDatabase(db: Database.Database): ResearchGapSnapshot {
  const checkedAt = new Date().toISOString();
  const empty: ResearchGapSnapshot = { checkedAt, libraryIndexedAt: null, libraryArtists: 0,
    counts: { attention: 0, pending: 0, unexplored: 0, covered: 0, empty: 0, related: 0 }, items: [] };
  const has = (name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  if (!has('sleeve_artists') || !has('sleeve_research_jobs')) return empty;
  const artists = db.prepare('SELECT id,name,musicbrainz_id AS mbid FROM sleeve_artists').all() as Artist[];
  const artistById = new Map(artists.map(a => [a.id, a]));
  const byName = new Map<string, Artist[]>();
  for (const a of artists) {
    const key = connectionNameKey(a.name);
    const group = byName.get(key) ?? []; group.push(a); byName.set(key, group);
  }
  const library = has('sleeve_connection_library_artists') ? db.prepare(
    'SELECT local_artist_id AS id,name FROM sleeve_connection_library_artists ORDER BY name,local_artist_id',
  ).all() as Array<{id: string; name: string}> : [];
  const groups = new Map<string, {name: string; libraryIds: string[]; ids: Set<string>; tracks: Map<string, number>}>();
  const groupFor = (name: string) => {
    const key = connectionNameKey(name);
    let group = groups.get(key);
    if (!group) { group = {name, libraryIds: [], ids: new Set((byName.get(key) ?? []).map(a => a.id)), tracks: new Map()}; groups.set(key, group); }
    return group;
  };
  for (const row of library) groupFor(row.name).libraryIds.push(row.id);
  // Matched performers can differ from a library credit filed under a composer.
  // Keep their own identity visible, with the actual recording as its bridge.
  const owners = db.prepare(`SELECT local.artist AS credit, artist.id, artist.name, COUNT(*) AS tracks
    FROM sleeve_local_attachments local JOIN sleeve_recordings recording ON recording.id=local.recording_id
    JOIN sleeve_artists artist ON artist.id=recording.artist_id
    WHERE local.match_state='matched' AND recording.match_state='matched'
    GROUP BY local.artist,artist.id`).all() as Array<{credit: string | null; id: string; name: string; tracks: number}>;
  for (const row of owners) {
    const own = groupFor(row.name); own.ids.add(row.id); own.tracks.set(row.id, (own.tracks.get(row.id) ?? 0) + row.tracks);
    if (row.credit && connectionNameKey(row.credit) !== connectionNameKey(row.name)) {
      const credit = groupFor(row.credit); credit.ids.add(row.id); credit.tracks.set(row.id, (credit.tracks.get(row.id) ?? 0) + row.tracks);
    }
  }
  const correctionSources=has('sleeve_artist_research_overrides');
  const sourceRows = db.prepare(`SELECT source.entity_id AS id,source.source_url AS url,source.retrieved_at AS retrievedAt FROM sleeve_source_documents source
    ${correctionSources?'LEFT JOIN sleeve_artist_research_overrides correction ON correction.artist_id=source.entity_id':''}
    WHERE source.entity_type='artist' AND source.provider='wikipedia'
    ${correctionSources?'AND (correction.updated_at IS NULL OR source.retrieved_at>=correction.updated_at)':''} ORDER BY source.retrieved_at DESC`).all() as Array<{id: string; url: string;retrievedAt:string}>;
  const sources = new Map<string, string>(),sourceDates=new Map<string,string>();
  for (const row of sourceRows) if (!sources.has(row.id)) {sources.set(row.id, row.url);sourceDates.set(row.id,row.retrievedAt);}
  const narrativeFilter = `claim.enabled=1 AND claim.operator_state<>'deleted' AND claim.feedback_hold=0
    AND claim.category NOT IN ('credits','musical-connections') AND length(trim(source.source_url))>0
    AND length(trim(claim.wording))>0 AND length(trim(claim.evidence))>0`;
  const facts = db.prepare(`WITH owners AS (
    SELECT id AS id,'artist' AS type,id AS artist FROM sleeve_artists
    UNION SELECT id,'recording',artist_id FROM sleeve_recordings WHERE artist_id IS NOT NULL
    UNION SELECT rr.release_id,'release',r.artist_id FROM sleeve_recording_releases rr JOIN sleeve_recordings r ON r.id=rr.recording_id WHERE rr.is_canonical_home=1
    UNION SELECT rel.musicbrainz_release_group_id,'release-group',r.artist_id FROM sleeve_recording_releases rr JOIN sleeve_releases rel ON rel.id=rr.release_id JOIN sleeve_recordings r ON r.id=rr.recording_id WHERE rr.is_canonical_home=1
  ) SELECT DISTINCT owners.artist,NULL AS credit,claim.id FROM owners
    JOIN sleeve_claims claim ON claim.entity_type=owners.type AND claim.entity_id=owners.id
    JOIN sleeve_source_documents source ON source.id=claim.source_document_id WHERE ${narrativeFilter}
  UNION SELECT NULL,local.artist,claim.id FROM (
    SELECT local_track_id,recording_id FROM sleeve_genius_local_tracks
    UNION SELECT local_track_id,recording_id FROM sleeve_genius_library_seeds
  ) genius JOIN sleeve_local_attachments local ON local.local_track_id=genius.local_track_id
    JOIN sleeve_claims claim ON claim.entity_type='recording' AND claim.entity_id=genius.recording_id
    JOIN sleeve_source_documents source ON source.id=claim.source_document_id
    WHERE source.provider='genius' AND local.artist IS NOT NULL AND ${narrativeFilter}`).all() as Array<{artist: string | null; credit: string | null; id: string}>;
  const stories = new Map<string, Set<string>>(), creditStories = new Map<string, Set<string>>();
  for (const row of facts) {
    const map = row.credit ? creditStories : stories;
    const key = row.credit ? connectionNameKey(row.credit) : row.artist;
    if (!key) continue;
    const ids = map.get(key) ?? new Set<string>(); ids.add(row.id); map.set(key, ids);
    if (row.credit) groupFor(row.credit);
  }
  const jobs = db.prepare(`SELECT subject_id AS subjectId,provider,capability,state,updated_at AS updatedAt
    FROM sleeve_research_jobs WHERE subject_type='artist' AND
    ((provider='wikipedia' AND capability='biography') OR (provider='researcher' AND capability='extract-wikipedia'))`).all() as Job[];
  const jobsById = new Map<string, Job[]>();
  for (const row of jobs) { const list = jobsById.get(row.subjectId) ?? []; list.push(row); jobsById.set(row.subjectId, list); }
  // Unresolved library-track match jobs are normal work, not biography failures.
  const matchJobs = db.prepare(`SELECT local.artist AS name,job.state FROM sleeve_research_jobs job
    JOIN sleeve_local_attachments local ON local.local_track_id=job.subject_id
    WHERE job.subject_type='local-track' AND job.provider='musicbrainz' AND job.capability='match'`).all() as Array<{name: string | null; state: string}>;
  const pendingNames = new Set(matchJobs.filter(j => active.has(j.state)).map(j => connectionNameKey(j.name)));
  const failedNames = new Set(matchJobs.filter(j => j.state==='failed').map(j => connectionNameKey(j.name)));
  const corrections=has('sleeve_artist_research_overrides') ? db.prepare('SELECT artist_id AS id,musicbrainz_id AS musicBrainzId,wikipedia_url AS wikipediaUrl FROM sleeve_artist_research_overrides').all() as Array<{id:string;musicBrainzId:string|null;wikipediaUrl:string|null}> : [];
  const overrides=new Map(corrections.filter(row=>row.musicBrainzId||row.wikipediaUrl).map(row=>[row.id,{musicBrainzId:row.musicBrainzId??'',wikipediaUrl:row.wikipediaUrl??''}]));
  const checks=has('sleeve_artist_verification') ? db.prepare('SELECT artist_id AS id,state,source_url AS sourceUrl,checked_at AS checkedAt,last_error AS lastError FROM sleeve_artist_verification').all() as Array<{id:string;state:string;sourceUrl:string|null;checkedAt:string|null;lastError:string|null}> : [];
  const verified=new Map(checks.map(row=>[row.id,row]));
  const items: ResearchGapSnapshot['items'] = [];
  for (const [key, group] of groups) {
    const identities = [...group.ids].map(id => artistById.get(id)).filter((a): a is Artist => !!a);
    const named = identities.filter(a => connectionNameKey(a.name) === key);
    const namedJobs = named.flatMap(a => jobsById.get(a.id) ?? []);
    const relevant = identities.flatMap(a => jobsById.get(a.id) ?? []);
    const coveredIds = identities.filter(a => sources.has(a.id));
    const storyIds = new Set([...(creditStories.get(key) ?? []), ...identities.flatMap(a => [...stories.get(a.id) ?? []])]);
    const failed = (a: Artist, provider: string) => (jobsById.get(a.id) ?? []).some(j => j.provider===provider && j.state==='failed');
    const partial = named.some(a => sources.has(a.id)) && named.some(a => (group.tracks.get(a.id) ?? 0)>0 && !sources.has(a.id) && failed(a, 'wikipedia'));
    const sourceIssue=(a:Artist,state:string)=>verified.get(a.id)?.state===state
      && (verified.get(a.id)?.checkedAt??'') > (sourceDates.get(a.id)??'')
      && (!coveredIds.length || (group.tracks.get(a.id)??0)>0);
    let status: ResearchGapStatus;
    if (relevant.some(j => active.has(j.state)) || pendingNames.has(key)) status='pending';
    else if (named.some(a=>sourceIssue(a,'missing'))) status='source-missing';
    else if (named.some(a=>sourceIssue(a,'failed'))) status='source-error';
    else if (!coveredIds.length && named.some(a=>verified.get(a.id)?.state==='found')) status='source-available';
    else if (partial) status='partial-coverage';
    else if (!coveredIds.length && namedJobs.some(j => j.provider==='wikipedia' && j.state==='failed')) status='source-not-found';
    else if (named.some(a => sources.has(a.id) && failed(a, 'researcher'))) status='extraction-failed';
    else if (!coveredIds.length && !storyIds.size && failedNames.has(key)) status='identity-unresolved';
    else if (storyIds.size) status='covered';
    else if (relevant.some(j => j.provider==='researcher' && j.state==='complete')) status='empty';
    else if (relevant.some(j => j.provider==='researcher' && j.state==='cancelled')) status='stopped';
    else if (coveredIds.length) status='pending';
    else if (identities.some(a => connectionNameKey(a.name) !== key)) status='related-credit';
    else status='unexplored';
    const attention = ['source-not-found','partial-coverage','extraction-failed','identity-unresolved','source-missing','source-error','source-available'].includes(status);
    empty.counts[attention ? 'attention' : status === 'pending' ? 'pending' : status === 'covered' ? 'covered' : status === 'related-credit' ? 'related' : ['empty','stopped'].includes(status) ? 'empty' : 'unexplored']++;
    items.push({id: key, name: group.name, status, libraryArtistIds: group.libraryIds, storyCount: storyIds.size,
      lastAttemptAt: relevant.map(j => j.updatedAt).sort().at(-1) ?? null,
      identities: identities.map(a => ({...a, override:overrides.get(a.id)??null,verification:verified.get(a.id)??null, articleUrl: sources.get(a.id) ?? null,
        storyCount: stories.get(a.id)?.size ?? 0, matchedTracks: group.tracks.get(a.id) ?? 0,
        canRetry: !!(a.mbid || overrides.get(a.id)?.musicBrainzId || overrides.get(a.id)?.wikipediaUrl) && (jobsById.get(a.id) ?? []).some(j => j.state==='failed')
          && !(jobsById.get(a.id) ?? []).some(j => active.has(j.state)),
      })),
    });
  }
  items.sort((a,b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const indexed = has('sleeve_connection_artist_population') ? db.prepare('SELECT completed_at AS at FROM sleeve_connection_artist_population WHERE id=1').get() as {at: string} | undefined : undefined;
  return {...empty, libraryIndexedAt: indexed?.at ?? null, libraryArtists: library.length, items};
}
