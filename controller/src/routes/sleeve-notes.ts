import {researchBlockReason} from '../sleeve-notes/research-availability.js';
import { manageQueuedJob } from '../sleeve-notes/queue-actions.js';
import {loadExtendedSleeveNoteCandidatesInDatabase} from '../sleeve-notes/link-selection.js';
import {getPlaybackMeta} from '../music/library.js';
import { researchAllowed } from '../broadcast/dj-budget.js';
// Feature routes require admin authentication. While off, only the explicit
// saved-data GET allowlist is available; research and writes remain gated.
import express from 'express';
import { getStationTimezone } from '../time.js';
import { brainAlbumCoverageInDatabase, queueBrainAlbumInDatabase, queueBrainLibraryAlbumInDatabase, type BrainAlbumType } from '../sleeve-notes/brain-album-research.js';
import { addLegacySegmentConversations } from '../sleeve-notes/legacy-segment-transcripts.js';
import { brainCoverageInDatabase, queueBrainArtistInDatabase, queueBrainLibrarySeedInDatabase } from '../sleeve-notes/brain-coverage.js';
import { randomUUID } from 'node:crypto';
import { seriesCheckSchema } from '../schemas/sleeve-notes-series.js';
import { sparkFeedbackSchema } from '../schemas/sleeve-notes-feedback.js';
import { saveSparkFeedback } from '../sleeve-notes/heard-on-air.js';
import { lookupMusicBrainzSeries, type MusicBrainzSeriesSnapshot } from '../music/musicbrainz.js';
import { seriesCatalogInDatabase, parseSeriesId, seedSuppliedSeries, updateSeriesInDatabase } from '../sleeve-notes/series-catalog-store.js';
import * as settings from '../settings.js';
import { recentCalls } from '../llm/log.js';
import { gatedListenerCount } from '../broadcast/listeners.js';
import { activeWikipediaExtractPrompt, DEFAULT_WIKIPEDIA_EXTRACT_PROMPT } from '../sleeve-notes/wikipedia-prompt.js';
import { requireAdmin } from '../middleware/auth.js';
import { geniusWorkerStatus } from '../sleeve-notes/genius-worker.js';
import { geniusAccessToken } from '../sleeve-notes/genius-token.js';
import { libraryConnectionsForRecording } from '../sleeve-notes/library-connections.js';
import { researchConnectionsOverviewInDatabase } from '../sleeve-notes/connections-overview.js';
import { cachedDashboardRead, cachedConnectionsOverview, libraryConnectionStoriesInBackground } from '../sleeve-notes/connection-compute.js';
import { brainLibraryResearchSeed, brainLibraryAlbumResearchSeed, brainLibraryGraph, cachedBrainLibraryGraph, localBrainArtistId, populateBrainArtists, searchBrainArtists } from '../sleeve-notes/brain-library.js';
import { runResearchDatabaseWork, withCachedRead, open as openSleeveNotesDb } from '../sleeve-notes/db.js';
import {
  adaptiveWikipediaChunkCharacters, requestWikipediaRefresh,
  wikipediaCalibrationProfileHash, type WikipediaRefreshMode,
} from '../sleeve-notes/research-worker.js';
import { LlmResearcher } from '../sleeve-notes/llm-researcher.js';
import { wikipediaNoteCategories } from '../sleeve-notes/researcher.js';
import { allocateWikipediaClaims, planWikipediaChunks } from '../sleeve-notes/wikipedia-extract.js';
import { listModeration, moderateCandidate, moderationSource, setClaimAvailability } from '../sleeve-notes/moderation.js';
import {
  rebuildWikipediaClaims,
  rebuildWikipediaClaimsForArtist,
  requeueCachedWikipediaResearch,
  researchConnectionsGraph,
  researchEntityDossier,
  resolveConnectionLocalTrack,
  researchStoreCoverage,
  researchStoreExplore,
  searchResearchStoriesInDatabase,
  reconcileConfiguredSeries,
  researchStoreSummary,
  latestSourceDocumentForResearch,
  searchConnections,
  type ConnectionEdgeType,
  type ResearchExploreLevel,
  type ResearchEntityType,
} from '../sleeve-notes/research-repository.js';

import { airingReviewDecisionSchema } from '../schemas/sleeve-notes-feedback.js';
import { airingReviewKey, flagAiredUse, listAiringReviews, decideAiringReview, reviewReadyCount, flagStoredClaim, storedClaimReviews } from '../sleeve-notes/airing-review.js';

export const router = express.Router();

// Only explicitly read-only views may bypass the master switch. Their handlers
// use withCachedRead, which neither creates nor upgrades the on-disk database.
const CACHED_VIEWS = new Set([
  '/readout', '/stories', '/explore', '/heard-on-air', '/airing-reviews', '/series',
  '/moderation', '/live-summary', '/storage', '/connections/search',
  '/connections/coverage', '/connections/album-coverage', '/connections/discoveries',
  '/connections/overview', '/connections/graph',
]);
router.use('/sleeve-notes', requireAdmin, async (req,res,next)=>{
  await settings.load();
  if (['/status', '/dash-stories'].includes(req.path) || settings.get().djBehaviour.extendedSleeveNotes === true) return next();
  if (req.method === 'GET' && (CACHED_VIEWS.has(req.path)
    || /^\/dossier\/[^/]+\/[^/]+$/.test(req.path)
    || /^\/moderation\/source\/[^/]+$/.test(req.path)
    || /^\/connections\/resolve\/[^/]+$/.test(req.path))) return next();
  return res.status(409).json({error:'Enable Extended Sleeve Notes in Settings → DJ Behaviour to use this feature'});
});

router.get('/sleeve-notes/heard-on-air', requireAdmin, async (req, res) => {
  await settings.load();
  const offset = Math.max(0, Math.min(100_000, Number.parseInt(String(req.query.offset), 10) || 0));
  const enabled = settings.get().djBehaviour.extendedSleeveNotes === true;
  const read = () => cachedDashboardRead({kind: 'heard-on-air', offset, filters: {
    search: String(req.query.search ?? ''), kind: String(req.query.kind ?? ''), period: String(req.query.period ?? ''), usage: String(req.query.usage ?? ''),
  }});
  const shelf=await addLegacySegmentConversations({...JSON.parse(await (enabled ? read() : withCachedRead(read))), readOnly: !enabled});
  const attach=()=>{
    const db=openSleeveNotesDb();
    const keys=[...new Set(shelf.items.map(airingReviewKey))];
    const reviews=keys.length && db.prepare("SELECT 1 FROM sqlite_master WHERE name='sleeve_airing_reviews'").get()
      ? db.prepare(`SELECT id,state,airing_key AS key FROM sleeve_airing_reviews WHERE airing_key IN (${keys.map(()=>'?').join(',')})`).all(...keys) as Array<{id:string;state:string;key:string}> : [];
    const byKey=new Map(reviews.map(review=>[review.key,{id:review.id,state:review.state}]));
    return {...shelf,items:shelf.items.map(item=>({...item,review:byKey.get(airingReviewKey(item))??null}))};
  };
  return res.json(enabled ? attach() : withCachedRead(attach));
});

router.post('/sleeve-notes/heard-on-air/:id/flag', requireAdmin, async (req,res)=>{
  await settings.load();
  if (!settings.get().djBehaviour.extendedSleeveNotes) return res.status(409).json({error:'Enable Sleeve Notes before flagging speech'});
  try {
    let flagged: Awaited<ReturnType<typeof flagAiredUse>> | undefined;
    const ran=await runResearchDatabaseWork(async()=>{flagged=await flagAiredUse(String(req.params.id));return true;});
    if (!ran) return res.status(409).json({error:'Sleeve Notes restore is in progress; try again shortly'});
    return res.json(flagged);
  }
  catch(error){return res.status(400).json({error:error instanceof Error?error.message:'Could not flag this airing'});}
});
router.get('/sleeve-notes/airing-reviews', requireAdmin, async (req,res)=>{
  await settings.load();
  const offset=Math.max(0,Math.min(100000,Number.parseInt(String(req.query.offset),10)||0));
  const read=()=>({...listAiringReviews(String(req.query.status??'active'),offset),readOnly:!settings.get().djBehaviour.extendedSleeveNotes});
  return res.json(settings.get().djBehaviour.extendedSleeveNotes?read():withCachedRead(read));
});
router.post('/sleeve-notes/airing-reviews/:id/decision', requireAdmin, async (req,res)=>{
  await settings.load();
  if (!settings.get().djBehaviour.extendedSleeveNotes) return res.status(409).json({error:'Enable Sleeve Notes before saving a review decision'});
  const parsed=airingReviewDecisionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({error:parsed.error.issues[0]?.message??'Choose a review action'});
  try {decideAiringReview(String(req.params.id),parsed.data.action,parsed.data.correction);return res.json({ok:true});}
  catch(error){return res.status(409).json({error:error instanceof Error?error.message:'Could not save this decision'});}
});

router.post('/sleeve-notes/heard-on-air/:id/feedback', requireAdmin, async (req, res) => {
  await settings.load();
  if (settings.get().djBehaviour.extendedSleeveNotes !== true) return res.status(409).json({ error: 'Enable Sleeve Notes before saving feedback' });
  const parsed = sparkFeedbackSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid feedback',
    fieldErrors: Object.fromEntries(parsed.error.issues.map(issue => [issue.path.join('.'), issue.message])) });
  const result = saveSparkFeedback(String(req.params.id), parsed.data);
  if (!result) return res.status(404).json({ error: 'No confirmed aired story was found' });
  return res.json({ ok: true, ...result });
});

// Preview metadata is held briefly server-side; Add never trusts client-supplied names/types.
const checkedSeries = new Map<string, { snapshot: MusicBrainzSeriesSnapshot; checkedAt: number }>();

router.get('/sleeve-notes/series', requireAdmin, async (_req, res) => {
  await settings.load();
  const read = () => {
    const db = openSleeveNotesDb();
    return { enabled: settings.get().djBehaviour.extendedSleeveNotes === true, lists: seriesCatalogInDatabase(db).map((item) => ({
      ...item,
      members: (db.prepare('SELECT COUNT(*) AS count FROM sleeve_musicbrainz_series_members WHERE series_mbid = ?').get(item.id) as { count: number }).count,
      matches: (db.prepare('SELECT COUNT(DISTINCT local_track_id) AS count FROM sleeve_series_library_claims WHERE series_mbid = ?').get(item.id) as { count: number }).count,
    })) };
  };
  return res.json(settings.get().djBehaviour.extendedSleeveNotes === true ? read() : withCachedRead(read));
});

router.post('/sleeve-notes/series/check', requireAdmin, async (req, res) => {
  try {
    const input = seriesCheckSchema.safeParse(req.body);
    if (!input.success) return res.status(400).json({ error: input.error.issues[0]?.message ?? 'Paste a Series URL or MBID' });
    const id = parseSeriesId(input.data.input);
    const existing = withCachedRead(() => seriesCatalogInDatabase(openSleeveNotesDb()).find((item) => item.id === id));
    if (existing) return res.json({ existing });
    const snapshot = await lookupMusicBrainzSeries(id);
    if (!snapshot) return res.status(404).json({ error: 'No supported MusicBrainz Series was found for that MBID' });
    const checkId = randomUUID();
    for (const [key, value] of checkedSeries) if (Date.now() - value.checkedAt > 10 * 60_000) checkedSeries.delete(key);
    while (checkedSeries.size >= 32) checkedSeries.delete(checkedSeries.keys().next().value!);
    checkedSeries.set(checkId, { snapshot, checkedAt: Date.now() });
    return res.json({ checkId, id, name: snapshot.name, entityType: /recording/i.test(snapshot.type ?? '') ? 'recording' : 'release-group',
      members: snapshot.members.length, sample: snapshot.members.slice(0, 5), numberedMembers: snapshot.members.filter((member) => member.rank).length });
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : 'Could not check this list' });
  }
});

router.post('/sleeve-notes/series', requireAdmin, async (req, res) => {
  const checkId = typeof req.body?.checkId === 'string' ? req.body.checkId : '';
  const checked = checkedSeries.get(checkId);
  if (!checked || Date.now() - checked.checkedAt > 10 * 60_000) return res.status(400).json({ error: 'Check this list again before adding it' });
  if (typeof req.body?.ranked !== 'boolean') return res.status(400).json({ error: 'Choose membership or ranking wording' });
  const { snapshot } = checked;
  const db = openSleeveNotesDb();
  try {
    db.transaction(() => {
      seedSuppliedSeries(db);
      const catalog = seriesCatalogInDatabase(db);
      if (catalog.some((item) => item.id === snapshot.id)) throw new Error('This list is already added; use its enable switch');
      if (catalog.length >= 64) throw new Error('The station supports up to 64 lists. Remove a custom list before adding another.');
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO sleeve_musicbrainz_series (series_mbid, series_name, entity_type, ranked, series_order, next_refresh_at, updated_at, origin)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'custom') ON CONFLICT(series_mbid) DO UPDATE SET
        series_name = excluded.series_name, entity_type = excluded.entity_type, ranked = excluded.ranked,
        enabled = 1, removed = 0, next_refresh_at = excluded.next_refresh_at, updated_at = excluded.updated_at`)
        .run(snapshot.id, snapshot.name, /recording/i.test(snapshot.type ?? '') ? 'recording' : 'release-group',
          Number(req.body.ranked), Math.max(0, ...catalog.map((item) => item.order)) + 1, new Date(0).toISOString(), now);
      db.prepare('UPDATE sleeve_series_library_scan SET album_offset = 0, next_scan_at = ?, updated_at = ? WHERE id = 1').run(now, now);
      reconcileConfiguredSeries([snapshot.id]);
    }).immediate();
    checkedSeries.delete(checkId);
    return res.status(201).json({ id: snapshot.id });
  } catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : 'Could not add list' }); }
});

router.post('/sleeve-notes/series/configure', requireAdmin, async (req, res) => {
  try {
    if (!Array.isArray(req.body?.ids) || !req.body.ids.length || req.body.ids.length > 64) throw new Error('Choose one or more lists');
    const ids = [...new Set<string>(req.body.ids.map(parseSeriesId))];
    const fields = ['enabled', 'ranked', 'removed'] as const;
    if (!fields.some((key) => typeof req.body[key] === 'boolean') || fields.some((key) => req.body[key] !== undefined && typeof req.body[key] !== 'boolean')) throw new Error('Choose a supported list setting');
    const db = openSleeveNotesDb();
    db.transaction(() => {
      updateSeriesInDatabase(db, ids, { enabled: req.body.enabled, ranked: req.body.ranked, removed: req.body.removed });
      reconcileConfiguredSeries(ids);
    }).immediate();
    return res.json({ ok: true });
  } catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : 'Could not update list' }); }
});

router.get('/sleeve-notes/moderation', requireAdmin, async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : 'pending';
  if (status !== 'pending' && status !== 'approved' && status !== 'deleted'
    && status !== 'retained') {
    return res.status(400).json({ error: 'Unsupported moderation status' });
  }
  const number = (value: unknown, fallback: number, max: number) => {
    const parsed = typeof value === 'string' ? Number(value) : fallback;
    return Number.isFinite(parsed) ? Math.max(0, Math.min(max, Math.trunc(parsed))) : fallback;
  };
  const search = typeof req.query.search === 'string' ? req.query.search.slice(0, 120).trim() : '';
  const provider = typeof req.query.provider === 'string' ? req.query.provider.slice(0, 40) : '';
  const limit = Math.max(1, number(req.query.limit, 25, 100));
  const offset = number(req.query.offset, 0, 1_000_000);
  await settings.load();
  const read = () => listModeration({ status, search, provider,
    reason: typeof req.query.reason === 'string' ? req.query.reason.slice(0, 40) : '',
    limit, offset,
  });
  return res.json(settings.get().djBehaviour.extendedSleeveNotes === true ? read() : withCachedRead(read));
});

router.get('/sleeve-notes/moderation/source/:id', requireAdmin, async (req, res) => {
  await settings.load();
  const read = () => moderationSource(String(req.params.id));
  const source = settings.get().djBehaviour.extendedSleeveNotes === true ? read() : withCachedRead(read);
  if (!source) return res.status(404).json({ error: 'Source not found' });
  return res.json(source);
});

function moderationEdit(body: unknown) {
  if (!body || typeof body !== 'object') return null;
  const value = body as Record<string, unknown>;
  const fields = ['category', 'topic', 'wording', 'shortWording', 'evidence'] as const;
  if (fields.some((field) => typeof value[field] !== 'string')) return null;
  return {
    category: value.category as import('../sleeve-notes/researcher.js').SleeveNoteCategory,
    topic: value.topic as string,
    wording: value.wording as string,
    shortWording: value.shortWording as string,
    evidence: value.evidence as string,
  };
}

router.post('/sleeve-notes/moderation/:id/:action', requireAdmin, async (req, res) => {
  const action = String(req.params.action);
  if (action !== 'approved' && action !== 'deleted') return res.status(400).json({ error: 'Unsupported decision' });
  const edit = moderationEdit(req.body);
  if (action === 'approved' && !edit) return res.status(400).json({ error: 'Complete claim fields are required' });
  try {
    return res.json(moderateCandidate(String(req.params.id), action, edit));
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : 'Could not review claim' });
  }
});

router.post('/sleeve-notes/queue/:id/:action', requireAdmin, async (req,res)=>{
  const action=String(req.params.action),id=String(req.params.id);
  if(!['top','cancel'].includes(action)||!id||id.length>300)return res.status(400).json({error:'Choose a queued job and supported action'});
  try{manageQueuedJob(openSleeveNotesDb(),id,action as 'top'|'cancel');return res.json({ok:true});}
  catch(error){return res.status(409).json({error:error instanceof Error?error.message:'Could not update queued job'});}
});

router.post('/sleeve-notes/claims/:id/review', requireAdmin, async (req, res) => {
  await settings.load();
  if (settings.get().djBehaviour.extendedSleeveNotes !== true) return res.status(409).json({ error: 'Extended Sleeve Notes is disabled' });
  try {
    return res.json(flagStoredClaim(String(req.params.id)));
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : 'Could not send story to Review' });
  }
});

router.post('/sleeve-notes/claims/:id/:action', requireAdmin, async (req, res) => {
  await settings.load();
  if (!settings.get().djBehaviour.extendedSleeveNotes) return res.status(409).json({error:'Extended Sleeve Notes is disabled'});
  const action = String(req.params.action);
  if (action==='withdraw'||action==='restore') {
    try {setClaimAvailability(String(req.params.id),action);return res.json({ok:true});}
    catch(error){return res.status(400).json({error:error instanceof Error?error.message:'Could not update fact availability'});}
  }
  if (action === 'approved' || action === 'deleted') {
    return res.status(410).json({ error: 'Direct story editing is retired; use the story review workflow so changes are checked before applying a decision' });
  }
  return res.status(400).json({ error: 'Unsupported decision' });
});

router.post('/sleeve-notes/segment/run', requireAdmin, async (_req,res)=>{
  try {
    await settings.load();
    const {runSleeveNotesSegmentNow}=await import('../skills/_agent.js');
    const run=await runSleeveNotesSegmentNow();
    return res.json({ok:true,queued:run.queued,deferred:run.deferred,spoken:run.text,reason:run.reason});
  } catch (error) {
    return res.status(500).json({error:error instanceof Error?error.message:'Could not run Sleeve Notes segment'});
  }
});

router.get('/sleeve-notes/dash-stories', requireAdmin, async (_req,res)=>{
  await settings.load();
  const enabled=settings.get().djBehaviour.extendedSleeveNotes===true;
  if(!enabled)return res.json({enabled:false,trackId:null,items:[]});
  const {queue}=await import('../broadcast/queue.js');
  const track=await queue.getNowPlaying();
  const trackId=track?.subsonic_id??track?.id??null;
  const items=trackId?withCachedRead(()=>{
    const facts=loadExtendedSleeveNoteCandidatesInDatabase(openSleeveNotesDb(),trackId,track?.artist);
    const reviews=storedClaimReviews(facts.map(fact=>fact.claimId));
    return facts.map(fact=>({id:fact.claimId,category:fact.category,text:fact.wording,sourceUrl:fact.sourceUrl,
      entityType:fact.entityType,entityId:fact.entityId,review:reviews[fact.claimId]??null}));
  }):[];
  const metadata=trackId?getPlaybackMeta(trackId):null;
  const artistId=metadata?.artistId??(typeof track?.artistId==='string'?track.artistId:null)
    ??(track?.artist?withCachedRead(()=>localBrainArtistId(track.artist)):null);
  return res.json({enabled,trackId,artistId,items});
});

router.get('/sleeve-notes/live-summary', requireAdmin, async (_req, res) => {
  const { queue } = await import('../broadcast/queue.js');
  const nowPlaying = await queue.getNowPlaying();
  const id=nowPlaying?.subsonic_id??nowPlaying?.id;
  const metadata=id?getPlaybackMeta(id):null;
  const playing=nowPlaying?{...nowPlaying,artistId:metadata?.artistId??nowPlaying.artistId,albumId:metadata?.albumId??nowPlaying.albumId}:null;
  const next=queue.upcoming[0]??null;
  const nextId=typeof next?.track.subsonic_id==='string'?next.track.subsonic_id:next?.track.id;
  const nextMetadata=nextId?getPlaybackMeta(nextId):null;
  const upcoming=next?{...next,track:{...next.track,artistId:nextMetadata?.artistId??(typeof next.track.artistId==='string'?next.track.artistId:null),albumId:nextMetadata?.albumId??(typeof next.track.albumId==='string'?next.track.albumId:null)}}:null;
  const json = await withCachedRead(() => cachedDashboardRead({kind: 'live-summary', args: [playing, queue.current, upcoming]}));
  return res.type('json').send(json);
});

router.get('/sleeve-notes/storage', requireAdmin, async (_req,res) => {
  await settings.load();
  const read = () => cachedDashboardRead({kind:'storage'});
  const result = settings.get().djBehaviour.extendedSleeveNotes ? await read() : await withCachedRead(read);
  return res.type('json').send(result);
});

router.get('/sleeve-notes/status', requireAdmin, async (_req, res) => {
  await settings.load();
  const value = settings.get();
  const enabled = value.djBehaviour.extendedSleeveNotes === true;
  const customPrompt = value.sleeveNotes.wikipedia.extractPrompt;
  const providerEnabled = value.sleeveNotes.providers.genius.enabled === true;
  const savedToken = value.sleeveNotes.providers.genius.accessToken;
  const environmentToken = process.env.GENIUS_ACCESS_TOKEN;
  const providerConfigured = !!geniusAccessToken();
  const providerTokenSource = savedToken ? 'settings' : environmentToken ? 'environment' : 'missing';
  const collectionPaused = value.djBehaviour.sleeveNotesCollectionPaused === true;
  const blockedReason = researchBlockReason();
  const collectionRunning = blockedReason === null;
  res.json({
    enabled,
    timezone: getStationTimezone(),
    wikipediaPrompt: activeWikipediaExtractPrompt(customPrompt),
    wikipediaDefaultPrompt: DEFAULT_WIKIPEDIA_EXTRACT_PROMPT,
    wikipediaPromptIsCustom: !!customPrompt.trim(),
    provider: 'genius',
    providerEnabled,
    providerConfigured,
    providerTokenSource,
    collectionRunning,
    reviewReady: enabled ? reviewReadyCount() : withCachedRead(reviewReadyCount),
    collectionPaused,
    collectionBlockedReason: blockedReason,
    coverage: enabled ? researchStoreCoverage() : {},
    // Temporary development readout for the live MusicBrainz → Wikipedia → LLM
    // path. It remains read-only and deliberately does not expose notes on air.
    replacement: enabled ? {
      admissionActive: true,
      researchWorkerActive: collectionRunning,
      ...researchStoreSummary(),
    } : null,
    onAirExposure: enabled,
  });
});

router.get('/sleeve-notes/wikipedia-refresh-preview', requireAdmin, async (_req, res) => {
  const db = openSleeveNotesDb();
  const rows = db.prepare(`SELECT entity_type AS entityType, COUNT(DISTINCT entity_id) AS entities,
      (SELECT COUNT(*) FROM sleeve_claims claim WHERE claim.entity_type = source.entity_type
        AND claim.operator_state = 'auto' AND claim.enabled = 1
        AND claim.entity_id IN (SELECT DISTINCT matching.entity_id FROM sleeve_source_documents matching
          WHERE matching.provider = 'wikipedia' AND matching.entity_type = source.entity_type)) AS claims
    FROM sleeve_source_documents source WHERE provider = 'wikipedia'
      AND entity_type IN ('artist', 'release-group') GROUP BY entity_type`).all() as Array<{
        entityType: string; entities: number; claims: number;
      }>;
  const artists = rows.find((row) => row.entityType === 'artist');
  const albums = rows.find((row) => row.entityType === 'release-group');
  return res.json({ artists: artists?.entities ?? 0, albums: albums?.entities ?? 0,
    claims: (artists?.claims ?? 0) + (albums?.claims ?? 0) });
});

router.post('/sleeve-notes/wikipedia-refresh', requireAdmin, async (req, res) => {
  await settings.load();
  if (settings.get().djBehaviour.extendedSleeveNotes !== true) return res.status(409).json({ error: 'Enable Sleeve Notes before starting research' });
  const mode = req.body?.mode;
  if (mode !== 'clear' && mode !== 'replace') {
    return res.status(400).json({ error: 'Refresh mode must be clear or replace' });
  }
  return res.json({ active: true, mode: mode as WikipediaRefreshMode, ...requestWikipediaRefresh(mode) });
});

router.get('/sleeve-notes/wikipedia-preview-artists', requireAdmin, async (_req, res) => {
  const artists = openSleeveNotesDb().prepare(`SELECT DISTINCT artist.id AS id, artist.name AS name,
      EXISTS (SELECT 1 FROM sleeve_source_documents source WHERE source.provider = 'wikipedia'
        AND source.entity_type = 'artist' AND source.entity_id = artist.id) AS hasCachedArticle
    FROM sleeve_encounters encounter
    JOIN sleeve_local_attachments local ON local.local_track_id = encounter.local_track_id
    JOIN sleeve_recordings recording ON recording.id = local.recording_id
    JOIN sleeve_artists artist ON artist.id = recording.artist_id
    WHERE encounter.source = 'played'
    ORDER BY artist.name COLLATE NOCASE`).all() as Array<{ id: string; name: string; hasCachedArticle: number }>;
  return res.json({ artists: artists.map((artist) => ({
    ...artist, hasCachedArticle: Boolean(artist.hasCachedArticle),
  })) });
});

router.get('/sleeve-notes/wikipedia-preview-albums/:artistId', requireAdmin, async (req, res) => {
  const artistId = String(req.params.artistId ?? '').trim();
  if (!artistId || artistId.length > 300) return res.status(400).json({ error: 'Choose an encountered artist' });
  const albums = openSleeveNotesDb().prepare(`SELECT release.musicbrainz_release_group_id AS id,
      MIN(release.title) AS name,
      EXISTS (SELECT 1 FROM sleeve_source_documents source WHERE source.provider = 'wikipedia'
        AND source.entity_type = 'release-group'
        AND source.entity_id = release.musicbrainz_release_group_id) AS hasCachedArticle
    FROM sleeve_encounters encounter
    JOIN sleeve_local_attachments local ON local.local_track_id = encounter.local_track_id
    JOIN sleeve_recordings recording ON recording.id = local.recording_id
    JOIN sleeve_recording_releases recordingRelease ON recordingRelease.recording_id = recording.id
    JOIN sleeve_releases release ON release.id = recordingRelease.release_id
    WHERE encounter.source = 'played' AND recording.artist_id = ?
      AND release.musicbrainz_release_group_id IS NOT NULL
    GROUP BY release.musicbrainz_release_group_id
    ORDER BY name COLLATE NOCASE`).all(artistId) as Array<{
      id: string; name: string; hasCachedArticle: number;
    }>;
  return res.json({ albums: albums.map((album) => ({
    ...album, hasCachedArticle: Boolean(album.hasCachedArticle),
  })) });
});

router.post('/sleeve-notes/wikipedia-prompt-preview', requireAdmin, async (req, res) => {
  await settings.load();
  if (settings.get().djBehaviour.extendedSleeveNotes !== true) return res.status(409).json({ error: 'Enable Sleeve Notes before starting research' });
  const entityType = req.body?.entityType === 'release-group' ? 'release-group'
    : req.body?.entityType === 'artist' ? 'artist' : null;
  const entityId = typeof req.body?.entityId === 'string' ? req.body.entityId.trim() : '';
  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt : null;
  if (!entityType || !entityId || entityId.length > 300 || prompt === null || prompt.length > 8000) {
    return res.status(400).json({ error: 'Choose an encountered artist or album and provide a prompt of at most 8,000 characters' });
  }
  const source = latestSourceDocumentForResearch(entityType, entityId, 'wikipedia');
  if (!source) return res.status(404).json({ error: `No cached Wikipedia article is available for this ${entityType === 'artist' ? 'artist' : 'album'}` });
  if (source.wikipediaPrunedAt) return res.status(409).json({ error: 'Full article text was cleared after research. Request research again from Station Brain, then retry this preview once the article has been fetched.' });
  const profileHash = wikipediaCalibrationProfileHash(prompt);
  const chunks = planWikipediaChunks(source.content, adaptiveWikipediaChunkCharacters(
    profileHash, entityType === 'artist' ? 'artist' : 'release',
  ));
  const chunk = chunks[0];
  if (!chunk) return res.status(422).json({ error: 'The cached article has no extractable text' });
  const job = {
    id: `wikipedia-prompt-preview:${entityType}:${entityId}`,
    document: { ...source, text: chunk.text },
    subjectKind: entityType === 'artist' ? 'artist' as const : 'album' as const,
    categories: entityType === 'artist' ? wikipediaNoteCategories('artist') : wikipediaNoteCategories('release-group'),
    maxCandidates: 64,
    wikiNumber: (() => {
      const limit = entityType === 'artist' ? settings.get().sleeveNotes.wikipedia.artistClaimLimit
        : settings.get().sleeveNotes.wikipedia.albumClaimLimit;
      return allocateWikipediaClaims(chunks, limit)[0] ?? 0;
    })(),
    requireShortWording: false,
  };
  const controller = new AbortController();
  const disconnect = () => controller.abort(new Error('Preview client disconnected'));
  req.on('aborted', disconnect);
  res.on('close', () => { if (!res.writableEnded) disconnect(); });
  const timeout = setTimeout(() => controller.abort(new Error('45-second preview limit reached')), 45_000);
  const startedAt = Date.now();
  try {
    const extraction = await new LlmResearcher().extractWikipediaSparks(job, chunk.sectionPath,
      controller.signal, prompt);
    if (!controller.signal.aborted && !res.destroyed) {
      return res.json({ entityType, subject: source.entityName, section: chunk.sectionPath,
        output: extraction.rawResponse,
        wikiNumber: job.wikiNumber,
        elapsedMs: Date.now() - startedAt, inputCharacters: chunk.text.length });
    }
  } catch (error) {
    if (!controller.signal.aborted && !res.destroyed) {
      return res.status(502).json({ error: error instanceof Error ? error.message : 'Wikipedia prompt preview failed' });
    }
  } finally {
    clearTimeout(timeout);
    req.off('aborted', disconnect);
  }
  return undefined;
});

// This is intentionally a temporary admin inspection surface, not an API for
// DJ consumers. Disabled-feature browsing requires explicit cached=1.
router.get('/sleeve-notes/readout', requireAdmin, async (req, res) => {
  await settings.load();
  if (settings.get().djBehaviour.extendedSleeveNotes !== true) {
    if (req.query.cached === '1') return res.json({ active: false, cached: true, readAt: Date.now(), ...JSON.parse(await withCachedRead(() => cachedDashboardRead({kind: 'readout'}))) });
    return res.json({ active: false, artists: [], claims: [], jobs: [] });
  }
  const wikipediaCalls = recentCalls.filter((call) => call.kind === 'sleeveNotesWikipediaExtract'
    && typeof call.ms === 'number');
  const wikipediaExtractAverageLatencyMs = wikipediaCalls.length
    ? Math.round(wikipediaCalls.reduce((total, call) => total + call.ms, 0) / wikipediaCalls.length)
    : null;
  const allowIdleRescans = settings.get().djBehaviour.sleeveNotesMaintenanceWhenEmpty === true
    && gatedListenerCount() === 0;
  const {activity, ...stored} = JSON.parse(await cachedDashboardRead({kind: 'readout', queue: allowIdleRescans}));
  const workQueueItems = activity.items as Array<{
    id: string; provider: string; capability: string; phase: string; subjectType: string;
    subjectTitle: string; subjectArtist: string | null; priority: number; attempts: number;
    runAfter: string | null; wikiNextChunk: number; researchNextSection: number;
  }>;
  const reviews = activity.reviews as Array<{id: string; state: string; artist: string | null; title: string | null}>;
  workQueueItems.push(...reviews.map(review => ({ id: `review:${review.id}`, provider: 'researcher',
    capability: 'review-flagged-speech', phase: review.state === 'running' ? 'running' as const : 'ready' as const,
    subjectType: 'recording', subjectTitle: review.title ?? 'Flagged speech', subjectArtist: review.artist,
    priority: 0, attempts: 0, runAfter: null, wikiNextChunk: 0, researchNextSection: 0 })));

  const promotions=new Map((activity.promotions as Array<{job_id:string;requested_at:string}>).map(row=>[row.job_id,row.requested_at]));
  const queueCounts = new Map<string, { provider: string; capability: string; phase: string; jobs: number }>();
  for (const item of workQueueItems) {
    const key = `${item.provider}\u0000${item.capability}\u0000${item.phase}`;
    const count = queueCounts.get(key) ?? {
      provider: item.provider, capability: item.capability, phase: item.phase, jobs: 0,
    };
    count.jobs++;
    queueCounts.set(key, count);
  }
  return res.json({
    active: true,
    researchPausedByBudget: !researchAllowed(),
    collectionPaused: settings.get().djBehaviour.sleeveNotesCollectionPaused === true,
    geniusQueue: { ...activity.genius, worker: geniusWorkerStatus(),
      enabled: settings.get().sleeveNotes.providers.genius.enabled === true, configured: !!geniusAccessToken() },
    readAt: Date.now(),
    ...stored,
    workQueue: [...queueCounts.values()],
    workQueueItems: workQueueItems.map(job=>({...job,promotedAt:promotions.get(job.id)??null})),
    wikipediaArtistChunkCharacterTarget: adaptiveWikipediaChunkCharacters(undefined, 'artist'),
    wikipediaAlbumChunkCharacterTarget: adaptiveWikipediaChunkCharacters(undefined, 'release'),
    wikipediaExtractAverageLatencyMs,
    wikipediaExtractCallCount: wikipediaCalls.length,
  });
});

// Paged, level-specific reads for the artist → album → track explorer. Keep
// the bounded recent readout above for Overview and Research.
router.get('/sleeve-notes/stories', requireAdmin, async (req,res) => {
  await settings.load();
  const number=(value:unknown,fallback:number)=>typeof value==='string'&&Number.isFinite(Number(value))?Math.trunc(Number(value)):fallback;
  const input={search:typeof req.query.search==='string'?req.query.search.slice(0,120):'',
    category:typeof req.query.category==='string'?req.query.category.slice(0,100):'',recent:req.query.recent==='1',withdrawn:req.query.withdrawn==='1',
    limit:Math.max(1,Math.min(100,number(req.query.limit,30))),offset:Math.max(0,number(req.query.offset,0))};
  if (input.category === 'library-connections') {
    const read = async () => {
      const result = await libraryConnectionStoriesInBackground(openSleeveNotesDb(), input);
      const reviews = storedClaimReviews(result.claims.map(claim => claim.id));
      return {...result, claims: result.claims.map(claim => ({...claim, review: reviews[claim.id] ?? null}))};
    };
    return res.json(await (settings.get().djBehaviour.extendedSleeveNotes === true ? read() : withCachedRead(read)));
  }
  const read=()=>{
    const result=searchResearchStoriesInDatabase(openSleeveNotesDb(),input);
    const reviews=storedClaimReviews(result.claims.map(claim=>claim.id));
    return {...result,claims:result.claims.map(claim=>({...claim,review:reviews[claim.id]??null}))};
  };
  return res.json(settings.get().djBehaviour.extendedSleeveNotes===true?read():withCachedRead(read));
});

router.get('/sleeve-notes/explore', requireAdmin, async (req, res) => {
  await settings.load();
  const validLevels: ResearchExploreLevel[] = ['artists', 'albums', 'tracks'];
  const rawLevel = typeof req.query.level === 'string' ? req.query.level : 'artists';
  if (!validLevels.includes(rawLevel as ResearchExploreLevel)) {
    return res.status(400).json({ error: 'A supported Explore level is required' });
  }
  const level = rawLevel as ResearchExploreLevel;
  const artistId = typeof req.query.artistId === 'string' ? req.query.artistId.trim() : '';
  const albumId = typeof req.query.albumId === 'string' ? req.query.albumId.trim() : '';
  const rawAlbumType = typeof req.query.albumType === 'string' ? req.query.albumType : '';
  const albumType = rawAlbumType === 'release-group' || rawAlbumType === 'release' ? rawAlbumType : undefined;
  const rawLetter = typeof req.query.letter === 'string' ? req.query.letter.trim() : '';
  if (rawLetter && !/^[a-z]$/i.test(rawLetter)) {
    return res.status(400).json({ error: 'Explore letter must be a single A–Z character' });
  }
  const letter = rawLetter.toLowerCase();
  if ((level === 'albums' || level === 'tracks') && (!artistId || artistId.length > 200)) {
    return res.status(400).json({ error: 'A supported artist id is required for this Explore level' });
  }
  if (level === 'tracks' && (!albumId || albumId.length > 200 || !albumType)) {
    return res.status(400).json({ error: 'A supported album id and type are required for track Explore' });
  }
  if (settings.get().djBehaviour.extendedSleeveNotes !== true && req.query.cached !== '1') {
    return res.json({ active: false, level, entities: [], total: 0, limit: 30, offset: 0 });
  }
  const rawLimit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 30;
  const rawOffset = typeof req.query.offset === 'string' ? Number(req.query.offset) : 0;
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(100, Math.trunc(rawLimit))) : 30;
  const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.trunc(rawOffset)) : 0;
  const search = typeof req.query.search === 'string' ? req.query.search.slice(0, 120) : '';
  const read = () => researchStoreExplore({ level, artistId, albumType, albumId, letter, search, limit, offset });
  const enabled = settings.get().djBehaviour.extendedSleeveNotes === true;
  return res.json({ active: enabled, level, ...(enabled ? read() : withCachedRead(read)) });
});

router.get('/sleeve-notes/dossier/:entityType/:entityId', requireAdmin, async (req, res) => {
  await settings.load();
  if (settings.get().djBehaviour.extendedSleeveNotes !== true && req.query.cached !== '1') {
    return res.status(409).json({ error: 'Extended Sleeve Notes is disabled' });
  }
  const entityType = String(req.params.entityType);
  const validTypes: ResearchEntityType[] = ['artist', 'recording', 'release', 'release-group'];
  const entityId = String(req.params.entityId ?? '').trim();
  if (!validTypes.includes(entityType as ResearchEntityType) || !entityId || entityId.length > 200) {
    return res.status(400).json({ error: 'A supported entity type and id are required' });
  }
  const read = () => {
    const result=researchEntityDossier(entityType as ResearchEntityType, entityId);
    if (!result) return null;
    const reviews=storedClaimReviews(result.claims.map(claim=>claim.id));
    return {...result,claims:result.claims.map(claim=>({...claim,review:reviews[claim.id]??null}))};
  };
  const dossier = settings.get().djBehaviour.extendedSleeveNotes === true ? read() : withCachedRead(read);
  if (!dossier) return res.status(404).json({ error: 'No saved stories exist for this artist, album or track' });
  return res.json({ active: settings.get().djBehaviour.extendedSleeveNotes === true, ...dossier });
});

const connectionEdgeTypes: ConnectionEdgeType[] = [
  'samples', 'sampled-in', 'cover-of', 'covered-by', 'producer', 'writer',
  'performed-by', 'appears-on', 'series-membership',
];

router.get('/sleeve-notes/connections/search', requireAdmin, async (req, res) => {
  await settings.load();
  if (settings.get().djBehaviour.extendedSleeveNotes !== true && req.query.cached !== '1') {
    return res.json({ active: false, results: [] });
  }
  const query = typeof req.query.q === 'string' ? req.query.q.slice(0, 120) : '';
  const rawLimit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 12;
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(30, Math.trunc(rawLimit))) : 12;
  const read = () => {
    const retained = searchConnections(query, limit);
    const names = new Set(retained.filter((item) => item.kind === 'artist').map((item) => item.title.toLocaleLowerCase()));
    const libraryArtists = searchBrainArtists(query, limit).filter((item) => !names.has(item.title.toLocaleLowerCase()));
    return { active: settings.get().djBehaviour.extendedSleeveNotes === true, results: [...retained, ...libraryArtists].slice(0, limit) };
  };
  return res.json(settings.get().djBehaviour.extendedSleeveNotes === true ? read() : withCachedRead(read));
});

router.get('/sleeve-notes/connections/resolve/:localTrackId', requireAdmin, async (req, res) => {
  await settings.load();
  if (settings.get().djBehaviour.extendedSleeveNotes !== true && req.query.cached !== '1') {
    return res.status(409).json({ error: 'Extended Sleeve Notes is disabled' });
  }
  const localTrackId = String(req.params.localTrackId ?? '').trim();
  if (!localTrackId || localTrackId.length > 300) {
    return res.status(400).json({ error: 'A supported local track id is required' });
  }
  const read = () => {
    const result = resolveConnectionLocalTrack(localTrackId);
    if (!result) return null;
    return { ...result, localArtistId: result.subtitle ? localBrainArtistId(result.subtitle) : null };
  };
  const result = settings.get().djBehaviour.extendedSleeveNotes === true ? read() : withCachedRead(read);
  if (!result) return res.status(404).json({ error: 'No saved match exists for this track' });
  return res.json({ active: settings.get().djBehaviour.extendedSleeveNotes === true, result });
});

router.post('/sleeve-notes/connections/populate', requireAdmin, async (_req, res) => {
  await settings.load();
  if (settings.get().djBehaviour.extendedSleeveNotes !== true) {
    return res.status(409).json({ error: 'Extended Sleeve Notes is disabled' });
  }
  try {
    return res.json({ active: true, ...await populateBrainArtists() });
  } catch (error) {
    return res.status(502).json({ error: error instanceof Error ? error.message : 'Could not populate library artists' });
  }
});

// Read-only foundation for later connection skills: IDs are queue candidates,
// and the ordinary queue guards still own any eventual playback action.
router.get('/sleeve-notes/connections/library/:recordingId', requireAdmin, async (req, res) => {
  await settings.load();
  if (settings.get().djBehaviour.extendedSleeveNotes !== true) {
    return res.status(409).json({ error: 'Extended Sleeve Notes is disabled' });
  }
  const id = String(req.params.recordingId ?? '').trim();
  if (!id || id.length > 300) return res.status(400).json({ error: 'A recording id is required' });
  return res.json({ active: true, connections: libraryConnectionsForRecording(id) });
});

router.get('/sleeve-notes/connections/coverage', requireAdmin, async (_req, res) => {
  await settings.load();
  const active = settings.get().djBehaviour.extendedSleeveNotes === true;
  const read = () => ({ active, artists: brainCoverageInDatabase(openSleeveNotesDb()) });
  return res.json(active ? read() : withCachedRead(read));
});

router.get('/sleeve-notes/connections/album-coverage', requireAdmin, async (req,res) => {
  const type=String(req.query.entityType??''),id=String(req.query.entityId??'').trim();
  if(!['release','release-group','library-album'].includes(type)||!id||id.length>300)return res.status(400).json({error:'Choose an album from Station Brain'});
  await settings.load(); const active=settings.get().djBehaviour.extendedSleeveNotes===true;
  const read=()=>({active,coverage:brainAlbumCoverageInDatabase(openSleeveNotesDb(),type as BrainAlbumType,id)});
  return res.json(active?read():withCachedRead(read));
});

router.post('/sleeve-notes/connections/research', requireAdmin, async (req, res) => {
  await settings.load();
  if (settings.get().djBehaviour.extendedSleeveNotes !== true) return res.status(409).json({ error: 'Enable Sleeve Notes before adding research to the queue' });
  const type = req.body?.entityType;
  const id = typeof req.body?.entityId === 'string' ? req.body.entityId.trim() : '';
  if (!['artist', 'library-artist', 'release', 'release-group', 'library-album'].includes(type) || !id || id.length > 300) return res.status(400).json({ error: 'Choose an artist or album from Station Brain' });
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(new Error('The library lookup timed out. Try again.')), 15_000);
  const disconnect = () => { if (!res.writableEnded) abort.abort(); };
  res.once('close', disconnect);
  try {
    const db = openSleeveNotesDb();
    if (type === 'artist' && !db.prepare('SELECT 1 FROM sleeve_artists WHERE id = ?').get(id)) return res.status(404).json({ error: 'This artist is no longer in Sleeve Notes' });
    if (type === 'library-artist' && !db.prepare('SELECT 1 FROM sleeve_connection_library_artists WHERE local_artist_id = ?').get(id)) return res.status(404).json({ error: 'This artist is no longer in the library index' });
    const seed = type === 'library-artist' ? await brainLibraryResearchSeed(id, abort.signal) : null;
    const albumSeed=type==='library-album'?await brainLibraryAlbumResearchSeed(id,abort.signal):null;
    abort.signal.throwIfAborted();
    if (settings.get().djBehaviour.extendedSleeveNotes !== true) return res.status(409).json({ error: 'Sleeve Notes was disabled before this research could be queued' });
    const result = albumSeed?queueBrainLibraryAlbumInDatabase(db,albumSeed):['release','release-group'].includes(type)
      ?queueBrainAlbumInDatabase(db,type,id):seed?queueBrainLibrarySeedInDatabase(db,seed):queueBrainArtistInDatabase(db,id);
    return res.json({ active: true, ...result });
  } catch (error) {
    if (res.destroyed) return;
    return res.status(422).json({ error: error instanceof Error ? error.message : 'Could not add this artist or album to the research queue' });
  } finally { clearTimeout(timeout); res.off('close', disconnect); }
});

// On-demand statistics share the existing read-only background graph worker.
router.get('/sleeve-notes/connections/discoveries', requireAdmin, async (req,res)=>{
  await settings.load();
  try {
    const read=()=>cachedConnectionsOverview([], 'discoveries', req.query.refresh==='1', openSleeveNotesDb());
    const result=settings.get().djBehaviour.extendedSleeveNotes===true?read():withCachedRead(read);
    return res.type('json').send(await result);
  } catch(error){
    return res.status(503).json({error:error instanceof Error?error.message:'Could not calculate discoveries'});
  }
});

router.get('/sleeve-notes/connections/overview', requireAdmin, async (req, res) => {
  await settings.load();
  if (settings.get().djBehaviour.extendedSleeveNotes !== true && req.query.cached !== '1') {
    return res.json({ active: false, focusId: '', nodes: [], edges: [], truncated: false });
  }
  const requestedEdges = typeof req.query.edges === 'string'
    ? [...new Set(req.query.edges.split(',').filter((value): value is ConnectionEdgeType =>
      connectionEdgeTypes.includes(value as ConnectionEdgeType)))]
    : connectionEdgeTypes;
  try {
    if (settings.get().djBehaviour.extendedSleeveNotes !== true) return res.json(withCachedRead(() => ({ active: false, ...researchConnectionsOverviewInDatabase(openSleeveNotesDb(), requestedEdges) })));
    return res.type('json').send(await cachedConnectionsOverview(requestedEdges));
  } catch (error) {
    return res.status(503).json({ error: error instanceof Error ? error.message : 'Could not build the artist map' });
  }
});

router.get('/sleeve-notes/connections/graph', requireAdmin, async (req, res) => {
  await settings.load();
  if (settings.get().djBehaviour.extendedSleeveNotes !== true && req.query.cached !== '1') {
    return res.status(409).json({ error: 'Extended Sleeve Notes is disabled' });
  }
  const entityType = typeof req.query.entityType === 'string' ? req.query.entityType : '';
  const entityId = typeof req.query.entityId === 'string' ? req.query.entityId.trim() : '';
  const validTypes = ['artist', 'recording', 'release', 'release-group', 'series'] as const;
  const libraryType = entityType === 'library-artist' || entityType === 'library-album';
  if ((!validTypes.includes(entityType as typeof validTypes[number]) && !libraryType) || !entityId || entityId.length > 300) {
    return res.status(400).json({ error: 'A supported Connections entity type and id are required' });
  }
  const requestedEdges = typeof req.query.edges === 'string'
    ? [...new Set(req.query.edges.split(',').filter((value): value is ConnectionEdgeType =>
      connectionEdgeTypes.includes(value as ConnectionEdgeType)))]
    : connectionEdgeTypes;
  if (settings.get().djBehaviour.extendedSleeveNotes !== true) {
    return withCachedRead(() => {
      if (libraryType) {
        const graph = cachedBrainLibraryGraph(entityType as 'library-artist' | 'library-album', entityId);
        if (!graph) return res.status(404).json({ error: 'This library layer has not been saved yet. Enable Sleeve Notes to load it.' });
        graph.edges = graph.edges.filter((edge) => requestedEdges.includes(edge.type));
        return res.json({ active: false, ...graph });
      }
      if (entityType === 'artist') {
        const artist = openSleeveNotesDb().prepare('SELECT name FROM sleeve_artists WHERE id = ?').get(entityId) as { name: string } | undefined;
        const localId = artist ? localBrainArtistId(artist.name) : null;
        const saved = localId ? cachedBrainLibraryGraph('library-artist', localId) : null;
        if (saved) {
          const previous = saved.focusId;
          saved.focusId = `artist:${entityId}`;
          saved.nodes[0] = { ...saved.nodes[0], id: saved.focusId, entityType: 'artist', entityId };
          for (const edge of saved.edges) if (edge.source === previous) edge.source = saved.focusId;
          saved.edges = saved.edges.filter((edge) => requestedEdges.includes(edge.type));
          return res.json({ active: false, ...saved });
        }
      }
      const graph = researchConnectionsGraph({ entityType: entityType as typeof validTypes[number], entityId, edgeTypes: requestedEdges });
      if (!graph) return res.status(404).json({ error: 'No saved connections were found for this entity' });
      return res.json({ active: false, ...graph });
    });
  }
  const artist = entityType === 'artist' ? openSleeveNotesDb().prepare(
    'SELECT name, musicbrainz_id AS mbid FROM sleeve_artists WHERE id = ?').get(entityId) as
    { name: string; mbid: string | null } | undefined : undefined;
  const localArtistId = artist ? localBrainArtistId(artist.name) : null;
  if (libraryType || localArtistId) {
    const abort = new AbortController();
    const disconnect = () => { if (!res.writableEnded) abort.abort(); };
    res.once('close', disconnect);
    try {
      const graph = await brainLibraryGraph(entityType === 'library-album' ? 'library-album' : 'library-artist',
        localArtistId ?? entityId, abort.signal, artist ? {
          id: `artist:${entityId}`, entityType: 'artist', entityId, kind: 'artist', title: artist.name,
          subtitle: 'Library artist', local: true, expandable: true, localArtistId, researched: true,
          sourceUrl: artist.mbid ? `https://musicbrainz.org/artist/${artist.mbid}` : null,
        } : undefined);
      graph.edges = graph.edges.filter((edge) => requestedEdges.includes(edge.type));
      return res.json({ active: true, ...graph });
    } catch (error) {
      if (abort.signal.aborted) return;
      return res.status(502).json({ error: error instanceof Error ? error.message : 'Could not load library neighbourhood' });
    } finally { res.off('close', disconnect); }
  }
  const graph = researchConnectionsGraph({
    entityType: entityType as typeof validTypes[number], entityId, edgeTypes: requestedEdges,
  });
  if (!graph) return res.status(404).json({ error: 'No retained Connections entity was found' });
  return res.json({ active: true, ...graph });
});

// Non-destructive replay from cached text. Existing claims and sources remain.
router.post('/sleeve-notes/requeue-wikipedia-research', requireAdmin, async (_req, res) => {
  await settings.load();
  if (settings.get().djBehaviour.extendedSleeveNotes !== true) {
    return res.status(409).json({ error: 'Extended Sleeve Notes is disabled' });
  }
  return res.json({ active: true, ...requeueCachedWikipediaResearch() });
});

// Deliberate rebuild after changing claim validation. This removes and
// re-extracts Wikipedia claims from cached documents.
router.post('/sleeve-notes/rebuild-wikipedia-claims', requireAdmin, async (_req, res) => {
  await settings.load();
  if (settings.get().djBehaviour.extendedSleeveNotes !== true) {
    return res.status(409).json({ error: 'Extended Sleeve Notes is disabled' });
  }
  return res.json({ active: true, ...rebuildWikipediaClaims() });
});

// Narrow maintenance path for a known editorial correction. Artist-scoped
// because extraction jobs select the latest cached Wikipedia source by artist.
router.post('/sleeve-notes/rebuild-wikipedia-artist/:artistId', requireAdmin, async (req, res) => {
  await settings.load();
  if (settings.get().djBehaviour.extendedSleeveNotes !== true) {
    return res.status(409).json({ error: 'Extended Sleeve Notes is disabled' });
  }
  const artistId = String(req.params.artistId ?? '');
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(artistId)) {
    return res.status(400).json({ error: 'artistId must be a UUID' });
  }
  return res.json({ active: true, artistId, ...rebuildWikipediaClaimsForArtist(artistId) });
});
