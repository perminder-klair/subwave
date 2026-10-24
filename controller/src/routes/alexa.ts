import express from 'express';
import { DefaultApiClient, SkillBuilders, escapeXmlCharacters } from 'ask-sdk-core';
import { ExpressAdapter } from 'ask-sdk-express-adapter';
import * as settings from '../settings.js';
import { getStreamStatus } from '../broadcast/listeners.js';
import { queue } from '../broadcast/queue.js';
import { requireAdmin } from '../middleware/auth.js';
import {
  alexaStreamOptions,
  alexaStreamUrl,
  effectiveAlexaStreamMount,
} from '../alexa/stream.js';
import {
  createAlexaStreamToken,
  DEFAULT_ALEXA_TOKEN_TTL_HOURS,
} from '../alexa/token.js';
import { alexaPatchSchema } from '../schemas/settings.js';
import { listenerRequestSchema } from '../schemas/request.js';
import { alexaIdentityKey } from '../broadcast/request-ledger.js';
import { type RequestReminder, type RequestReminderConsent } from '../broadcast/request-ledger.js';
import {
  audioPlayerMetadata,
  etaSpeech,
  messages,
  trackSpeech,
  type AlexaPresentationTrack,
} from '../alexa/experience.js';
import { previewAlexaRequest, type AlexaRequestCandidate } from '../alexa/request-preview.js';
import {
  createAlexaListenerFeatureService,
  verifiedCandidateFor,
  verifiedRequestText,
  type AlexaCurrentShow,
  type AlexaListenerFeatureService,
  type AlexaListenerTrack,
  type AlexaTrackDetails,
  type AlexaVerifiedCandidate,
} from '../alexa/listener-features.js';
import {
  getLatestAlexaRequestStatus,
  getAlexaRequestStatus,
  saveAlexaRequestReminder,
  clearAlexaRequestReminder,
  saveAlexaReminderConsent,
  getAlexaReminderConsent,
  clearAlexaReminderConsent,
  cancelLatestAlexaRequest,
  replaceLatestAlexaRequest,
  submitListenerRequest,
  type ListenerRequestStatus,
} from './request.js';
import { cleanDedicationTarget } from '../util/request-guard.js';
import { isGenericDedicationSong } from '../alexa/dedications.js';
import {
  REMINDER_PERMISSION,
  reminderClientFor,
  reminderEtaAllowed,
  reminderOffsetSeconds,
  type AlexaReminderClient,
} from '../alexa/reminders.js';

const router = express.Router();
const ALEXA_SKILL_ID_RE = /^amzn1\.ask\.skill\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AlexaSubmitResult = {
  accepted: true;
  statusCode: 202;
  requestId: string;
  status: 'pending';
} | {
  accepted: false;
  statusCode: number;
  message?: string;
  error?: string;
  retryAfter?: number;
};

export interface AlexaRuntime {
  getSettings: () => {
    enabled: boolean;
    skillId: string;
    station: string;
    streamUrl: string;
    streamMount?: string;
    listenerAuth?: boolean;
    listenerPassword?: string;
    tokenTtlSeconds?: number;
  };
  isStreamOnline: () => boolean;
  nowPlaying?: () => Promise<AlexaTrack | null> | AlexaTrack | null;
  upcoming?: () => Promise<AlexaTrack[]> | AlexaTrack[];
  previous?: () => Promise<AlexaTrack | null> | AlexaTrack | null;
  submitRequest?: (input: {
    text: string;
    userId: string;
    verifiedCandidate?: AlexaVerifiedCandidate;
    personId?: string;
    dedication?: { target: string; locale: 'en-US' | 'en-IN' | 'hi-IN' };
  }) => Promise<AlexaSubmitResult>;
  latestRequestStatus?: (identity: string) => Promise<ListenerRequestStatus | null>;
  requestStatus?: (identity: string, requestId: string) => Promise<ListenerRequestStatus | null>;
  saveReminder?: (identity: string, requestId: string, reminder: RequestReminder) => Promise<ListenerRequestStatus | null>;
  clearReminder?: (identity: string, requestId: string) => Promise<boolean>;
  saveReminderConsent?: (identity: string, requestId: string, consent: RequestReminderConsent) => Promise<boolean>;
  findReminderConsent?: (identity: string, permissionToken: string) => Promise<AlexaReminderPending | null>;
  clearReminderConsent?: (identity: string, requestId: string) => Promise<boolean>;
  reminderClient?: AlexaReminderClient;
  cancelRequest?: (identity: string) => Promise<ListenerRequestStatus | null>;
  replaceRequest?: (identity: string, text: string) => Promise<AlexaSubmitResult>;
  previewRequest?: (text: string) => Promise<AlexaRequestCandidate[]>;
  listenerFeatures?: AlexaListenerFeatureService;
}

export interface AlexaTrack extends AlexaPresentationTrack {
  title: string;
  artist: string;
}

export interface AlexaConnectionCheck {
  id: 'site-url' | 'skill' | 'listener-access' | 'stream' | 'webhook';
  label: string;
  ok: boolean;
  message: string;
}

export interface AlexaConnectionTestResult {
  ok: boolean;
  checks: AlexaConnectionCheck[];
  testedAt: string;
}

export interface AlexaConnectionTestDraft {
  enabled: boolean;
  skillId: string;
  streamMount: string;
  tokenTtlHours?: number;
}

function configuredSiteUrl(): string {
  return (process.env.SITE_URL || '').trim().replace(/\/+$/, '');
}

function defaultRuntime(): AlexaRuntime {
  const siteUrl = configuredSiteUrl();
  const toAlexaTrack = (track: any): AlexaTrack | null => {
    const title = String(track?.title || '').trim();
    const artist = String(track?.artist || '').trim();
    if (!title || !artist) return null;
    const id = String(track?.id || track?.subsonic_id || '').trim() || null;
    return {
      id,
      title,
      artist,
      album: String(track?.album || '').trim() || null,
      artworkUrl: id && siteUrl ? `${siteUrl}/cover/${encodeURIComponent(id)}` : null,
    };
  };
  return {
    getSettings: () => {
      const current = settings.get();
      const streamMount = effectiveAlexaStreamMount(current.alexa?.streamMount, current.stream);
      return {
        enabled: current.alexa?.enabled === true,
        skillId: typeof current.alexa?.skillId === 'string' ? current.alexa.skillId : '',
        station: current.station || 'SUB/WAVE',
        streamMount,
        streamUrl: alexaStreamUrl(siteUrl, streamMount),
        listenerAuth: current.privacy?.listenerAuth === true,
        listenerPassword: current.privacy?.password || '',
        tokenTtlSeconds: (current.alexa?.tokenTtlHours || DEFAULT_ALEXA_TOKEN_TTL_HOURS) * 3600,
      };
    },
    isStreamOnline: () => getStreamStatus().online,
    nowPlaying: async () => {
      const track = await queue.getNowPlaying();
      return toAlexaTrack(track);
    },
    upcoming: () => queue.upcoming
      .map(item => toAlexaTrack(item.track))
      .filter((track): track is AlexaTrack => track !== null),
    previous: () => toAlexaTrack(queue.history[0]?.track),
    submitRequest: ({ text, userId, verifiedCandidate, personId, dedication }) => {
      const identity = personId
        ? `person:${personId}`
        : alexaIdentityKey(userId || 'unknown');
      return submitListenerRequest({
        text,
        name: '',
        ip: `alexa:${identity}`,
        source: 'alexa',
        alexaIdentity: identity,
        verifiedCandidate,
        dedication,
      }).then(result => result.accepted
        ? { accepted: true, statusCode: 202 as const, requestId: result.requestId, status: 'pending' as const }
        : result);
    },
    latestRequestStatus: identity => getLatestAlexaRequestStatus(identity),
    requestStatus: (identity, requestId) => getAlexaRequestStatus(identity, requestId),
    saveReminder: (identity, requestId, reminder) => saveAlexaRequestReminder(identity, requestId, reminder),
    clearReminder: (identity, requestId) => clearAlexaRequestReminder(identity, requestId),
    saveReminderConsent: (identity, requestId, consent) => saveAlexaReminderConsent(identity, requestId, consent),
    findReminderConsent: (identity, permissionToken) => getAlexaReminderConsent(identity, permissionToken),
    clearReminderConsent: (identity, requestId) => clearAlexaReminderConsent(identity, requestId),
    cancelRequest: identity => cancelLatestAlexaRequest(identity),
    replaceRequest: (identity, text) => replaceLatestAlexaRequest(identity, text).then(result => result.accepted
      ? { accepted: true, statusCode: 202 as const, requestId: result.requestId, status: 'pending' as const }
      : result),
    previewRequest: previewAlexaRequest,
    listenerFeatures: createAlexaListenerFeatureService(),
  };
}

function validPublicSiteUrl(siteUrl: string): boolean {
  try {
    const parsed = new URL(siteUrl);
    return parsed.protocol === 'https:'
      && !parsed.username
      && !parsed.password
      && !parsed.search
      && !parsed.hash
      && parsed.pathname === '/';
  } catch {
    return false;
  }
}

async function closeProbe(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The probe has already answered; an aborted live stream body is expected.
  }
}

/**
 * Probe the direct Alexa setup from the station's public edge.
 *
 * The webhook probe deliberately sends an unsigned Alexa-shaped request. A
 * healthy endpoint rejects that request with HTTP 400 during Alexa signature
 * verification; that proves the public route is reachable without pretending
 * that SUB/WAVE can forge an Alexa request signature.
 */
export async function testAlexaConnection(
  runtime: AlexaRuntime = defaultRuntime(),
  fetcher: typeof fetch = fetch,
  draft?: AlexaConnectionTestDraft,
): Promise<AlexaConnectionTestResult> {
  const siteUrl = configuredSiteUrl();
  const saved = runtime.getSettings();
  const current = draft
    ? {
        ...saved,
        enabled: draft.enabled,
        skillId: draft.skillId.trim(),
        streamMount: draft.streamMount,
        streamUrl: alexaStreamUrl(siteUrl, draft.streamMount),
        tokenTtlSeconds: (draft.tokenTtlHours || DEFAULT_ALEXA_TOKEN_TTL_HOURS) * 3600,
      }
    : saved;
  const siteOk = validPublicSiteUrl(siteUrl);
  const skillOk = !current.enabled || ALEXA_SKILL_ID_RE.test(current.skillId);
  const listenerOk = current.listenerAuth !== true
    || Boolean(current.listenerPassword && (current.tokenTtlSeconds || 0) > 0);
  const webhookProbeDeferred = draft?.enabled === true && saved.enabled !== true;
  const playbackRuntime: AlexaRuntime = {
    getSettings: () => current,
    isStreamOnline: runtime.isStreamOnline,
  };
  const streamUrl = siteUrl
    ? playbackStreamUrl(playbackRuntime)
    : current.streamUrl;
  const webhookUrl = siteUrl ? `${siteUrl}/api/alexa` : '';
  const checks: AlexaConnectionCheck[] = [
    {
      id: 'site-url',
      label: 'Public URL',
      ok: siteOk,
      message: siteOk
        ? `${siteUrl} is a valid HTTPS origin.`
        : 'SITE_URL must be a public HTTPS origin without a path, query, or hash.',
    },
    {
      id: 'skill',
      label: 'Skill configuration',
      ok: skillOk,
      message: skillOk
        ? current.enabled
          ? 'Direct Alexa skill is enabled and has a valid Skill ID format.'
          : 'Direct Alexa skill is disabled; endpoint checks can still be tested.'
        : 'Enter the complete Alexa Skill ID in the amzn1.ask.skill.<uuid> format.',
    },
    {
      id: 'listener-access',
      label: 'Public listener access',
      ok: listenerOk,
      message: listenerOk
        ? current.listenerAuth === true
          ? 'Listener authentication is enabled; Alexa will use a temporary signed stream URL.'
          : 'The stream is not password-protected.'
        : 'Listener authentication is enabled but no signing secret is available.',
    },
  ];

  if (!siteOk || !streamUrl) {
    checks.push({
      id: 'stream',
      label: 'Public stream',
      ok: false,
      message: 'Skipped because the public station URL is not configured correctly.',
    });
  } else {
    try {
      const response = await fetcher(streamUrl, {
        headers: { Range: 'bytes=0-1' },
        signal: AbortSignal.timeout(8_000),
      });
      const contentType = response.headers.get('content-type') || '';
      const httpOk = response.status >= 200 && response.status < 300;
      const audioOk = /audio\//i.test(contentType)
        || /application\/(?:octet-stream|ogg)/i.test(contentType);
      await closeProbe(response);
      const online = runtime.isStreamOnline();
      checks.push({
        id: 'stream',
        label: 'Public stream',
        ok: online && httpOk && audioOk,
        message: !online
          ? 'The controller reports that the station is offline.'
          : !httpOk
            ? `The stream returned HTTP ${response.status}.`
            : !audioOk
              ? `The stream returned an unexpected content type: ${contentType || 'unknown'}.`
              : 'The public stream is online and returns audio.',
      });
    } catch (error) {
      checks.push({
        id: 'stream',
        label: 'Public stream',
        ok: false,
        message: `Could not reach the public stream: ${error instanceof Error ? error.message : 'request failed'}.`,
      });
    }
  }

  if (webhookProbeDeferred) {
    checks.push({
      id: 'webhook',
      label: 'Alexa webhook',
      ok: true,
      message: 'Deferred until the enabled direct skill settings are saved; then test the public webhook again.',
    });
  } else if (!siteOk || !webhookUrl) {
    checks.push({
      id: 'webhook',
      label: 'Alexa webhook',
      ok: false,
      message: 'Skipped because the public station URL is not configured correctly.',
    });
  } else {
    try {
      const response = await fetcher(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: '1.0',
          session: { new: true, sessionId: 'subwave-connection-test', application: { applicationId: current.skillId } },
          context: { System: { application: { applicationId: current.skillId } } },
          request: { type: 'LaunchRequest', requestId: 'subwave-connection-test', locale: 'en-US', timestamp: new Date().toISOString() },
        }),
        signal: AbortSignal.timeout(8_000),
      });
      const body = await response.text();
      const expectedSignatureRejection = response.status === 400
        && /verification|signature/i.test(body);
      checks.push({
        id: 'webhook',
        label: 'Alexa webhook',
        ok: expectedSignatureRejection,
        message: expectedSignatureRejection
          ? 'The public endpoint is reachable and is validating Alexa requests.'
          : response.status === 404
            ? 'The public endpoint returned 404. Check the Alexa webhook path and that the direct skill is enabled.'
            : `The public endpoint returned HTTP ${response.status}; expected Alexa signature validation (HTTP 400).`,
      });
    } catch (error) {
      checks.push({
        id: 'webhook',
        label: 'Alexa webhook',
        ok: false,
        message: `Could not reach the public endpoint: ${error instanceof Error ? error.message : 'request failed'}.`,
      });
    }
  }

  return {
    ok: checks.every(check => check.ok),
    checks,
    testedAt: new Date().toISOString(),
  };
}

function stationName(runtime: AlexaRuntime): string {
  return runtime.getSettings().station.trim() || 'SUB/WAVE';
}

function inputLocale(input: any): string {
  return String(input.requestEnvelope?.request?.locale || 'en-IN');
}

function offlineResponse(input: any) {
  const copy = messages(inputLocale(input));
  return input.responseBuilder
    .speak(copy.offline)
    .withShouldEndSession(true)
    .getResponse();
}

function playbackStreamUrl(runtime: AlexaRuntime): string {
  const current = runtime.getSettings();
  if (!current.streamUrl) return '';
  if (current.listenerAuth !== true) return current.streamUrl;

  const mount = current.streamMount || '/stream.mp3';
  const token = createAlexaStreamToken(
    current.listenerPassword || '',
    mount,
    current.tokenTtlSeconds || DEFAULT_ALEXA_TOKEN_TTL_HOURS * 3600,
  );
  if (!token) return '';
  const separator = current.streamUrl.includes('?') ? '&' : '?';
  return `${current.streamUrl}${separator}auth=${encodeURIComponent(token)}`;
}

async function playResponse(input: any, runtime: AlexaRuntime, opening: string) {
  const station = stationName(runtime);
  const streamUrl = playbackStreamUrl(runtime);
  if (!runtime.isStreamOnline() || !streamUrl) return offlineResponse(input);

  let track: AlexaTrack | null = null;
  try {
    track = runtime.nowPlaying ? await runtime.nowPlaying() : null;
  } catch {
    // Metadata is optional. Do not prevent live playback when the catalogue is unavailable.
  }
  const response = input.responseBuilder
    .speak(`${escapeXmlCharacters(opening)} ${escapeXmlCharacters(station)}.`)
    .addDirective({
      type: 'AudioPlayer.Play',
      playBehavior: 'REPLACE_ALL',
      audioItem: {
        stream: {
          url: streamUrl,
          token: 'subwave-live-stream',
          offsetInMilliseconds: 0,
        },
        metadata: audioPlayerMetadata(track, station),
      },
    });
  return response.withShouldEndSession(true).getResponse();
}

function stopResponse(input: any, message: string) {
  return input.responseBuilder
    .speak(message)
    .addAudioPlayerStopDirective()
    .withShouldEndSession(true)
    .getResponse();
}

function helpResponse(input: any) {
  return input.responseBuilder
    .speak(messages(inputLocale(input)).help)
    .withShouldEndSession(false)
    .getResponse();
}

function intentHandler(names: readonly string[], handle: (input: any) => any) {
  return {
    canHandle: (input: any) =>
      input.requestEnvelope.request.type === 'IntentRequest' &&
      names.includes(input.requestEnvelope.request.intent?.name),
    handle,
  };
}

function alexaUserId(input: any): string {
  return String(
    input.requestEnvelope?.session?.user?.userId
      || input.requestEnvelope?.context?.System?.user?.userId
      || '',
  ).trim();
}

function alexaPersonId(input: any): string {
  return String(
    input.requestEnvelope?.context?.System?.person?.personId
      || input.requestEnvelope?.session?.user?.personId
      || '',
  ).trim();
}

// Person IDs are stable for Alexa's person-aware requests. When Alexa does not
// provide one, keep the existing skill-scoped account fallback: the ledger
// stores only its salted, non-reversible identity key.
function alexaRequestIdentity(input: any): string {
  const personId = alexaPersonId(input);
  return personId ? `person:${personId}` : alexaIdentityKey(alexaUserId(input) || 'unknown');
}

function listenerFeatures(runtime: AlexaRuntime): AlexaListenerFeatureService {
  return runtime.listenerFeatures || createAlexaListenerFeatureService();
}

function featureTrack(track: AlexaListenerTrack): AlexaTrack {
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    album: track.album,
    artworkUrl: track.artworkUrl || null,
  };
}

function requestSpeech(input: any, text: string) {
  return input.responseBuilder
    .speak(text)
    .withShouldEndSession(true)
    .getResponse();
}

function dynamicSpeech(value: string | null | undefined, fallback: string): string {
  return value ? escapeXmlCharacters(value) : fallback;
}

type AlexaReminderPending = {
  requestId: string;
  identity: string;
  locale: 'en-US' | 'en-IN' | 'hi-IN';
  permissionToken?: string;
};

type ReminderCreationState = {
  cancelled: boolean;
  alertToken?: string;
  deleted: boolean;
  done: Promise<void>;
  resolveDone: () => void;
};

const reminderCreations = new Map<string, ReminderCreationState>();
const REMINDER_CONSENT_TTL_MS = 15 * 60 * 1000;

function sessionAttributes(input: any): Record<string, unknown> {
  return input.attributesManager?.getSessionAttributes?.() || {};
}

function saveSessionAttributes(input: any, attributes: Record<string, unknown>): void {
  input.attributesManager?.setSessionAttributes?.(attributes);
}

function pendingReminder(input: any): AlexaReminderPending | null {
  const value = sessionAttributes(input).alexaReminderPending;
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<AlexaReminderPending>;
  if (typeof candidate.requestId !== 'string' || typeof candidate.identity !== 'string') return null;
  if (candidate.locale !== 'en-US' && candidate.locale !== 'en-IN' && candidate.locale !== 'hi-IN') return null;
  return {
    requestId: candidate.requestId,
    identity: candidate.identity,
    locale: candidate.locale,
    ...(typeof candidate.permissionToken === 'string' ? { permissionToken: candidate.permissionToken } : {}),
  };
}

function savePendingReminder(input: any, pending: AlexaReminderPending): void {
  const attributes = sessionAttributes(input);
  attributes.alexaReminderPending = pending;
  saveSessionAttributes(input, attributes);
}

function clearPendingReminder(input: any): void {
  const attributes = sessionAttributes(input);
  delete attributes.alexaReminderPending;
  saveSessionAttributes(input, attributes);
}

async function clearReminderConsentState(runtime: AlexaRuntime, pending: AlexaReminderPending): Promise<void> {
  if (!runtime.clearReminderConsent) return;
  try {
    await runtime.clearReminderConsent(pending.identity, pending.requestId);
  } catch (error) {
    console.error(`[alexa] reminder consent cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function pendingReminderForResponse(
  input: any,
  runtime: AlexaRuntime,
  permissionToken: string | undefined,
): Promise<AlexaReminderPending | null> {
  const sessionPending = pendingReminder(input);
  if (sessionPending?.permissionToken === permissionToken) return sessionPending;
  if (!permissionToken || !runtime.findReminderConsent) return sessionPending;
  const durable = await runtime.findReminderConsent(alexaRequestIdentity(input), permissionToken);
  if (!durable) return sessionPending;
  const restored: AlexaReminderPending = {
    requestId: durable.requestId,
    identity: durable.identity,
    locale: durable.locale,
    permissionToken: durable.permissionToken,
  };
  // Keep a retry in the current session (for example NOT_ANSWERED) working,
  // while the durable record remains the source of truth across the Alexa
  // Connections handoff that ended the original session.
  savePendingReminder(input, restored);
  return restored;
}

function isRequestCandidate(value: unknown): value is AlexaRequestCandidate {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<AlexaRequestCandidate>;
  return typeof candidate.id === 'string'
    && typeof candidate.title === 'string'
    && typeof candidate.artist === 'string';
}

function requestCandidates(input: any): AlexaRequestCandidate[] {
  const candidates = sessionAttributes(input).alexaRequestCandidates;
  return Array.isArray(candidates) ? candidates.filter(isRequestCandidate).slice(0, 3) : [];
}

function clearRequestClarification(input: any): void {
  const attributes = sessionAttributes(input);
  delete attributes.alexaRequestCandidates;
  delete attributes.alexaRequestText;
  saveSessionAttributes(input, attributes);
}

function candidateTrack(candidate: AlexaRequestCandidate): AlexaTrack {
  return {
    id: candidate.id,
    title: candidate.title,
    artist: candidate.artist,
    album: candidate.album || null,
    artworkUrl: candidate.artworkUrl || null,
  };
}

function clarificationResponse(
  input: any,
  runtime: AlexaRuntime,
  candidate: AlexaRequestCandidate,
  remaining: AlexaRequestCandidate[],
) {
  const copy = messages(inputLocale(input));
  const attributes = sessionAttributes(input);
  attributes.alexaRequestCandidates = [candidate, ...remaining];
  saveSessionAttributes(input, attributes);
  const track = candidateTrack(candidate);
  const response = input.responseBuilder
    .speak(copy.candidate(trackSpeech(track)))
    .reprompt(copy.candidateReprompt)
    .withShouldEndSession(false);
  return response.getResponse();
}

async function nowPlayingResponse(input: any, runtime: AlexaRuntime) {
  const track = runtime.nowPlaying
    ? await runtime.nowPlaying()
    : await defaultRuntime().nowPlaying!();
  const copy = messages(inputLocale(input));
  return requestSpeech(
    input,
    track ? copy.current(trackSpeech(track)) : copy.noCurrent,
  );
}

async function upcomingResponse(input: any, runtime: AlexaRuntime) {
  const tracks = runtime.upcoming
    ? await runtime.upcoming()
    : await defaultRuntime().upcoming!();
  const next = tracks.find(track => track.title.trim() && track.artist.trim());
  const copy = messages(inputLocale(input));
  return requestSpeech(
    input,
    next ? copy.next(trackSpeech(next)) : copy.noNext,
  );
}

async function previousResponse(input: any, runtime: AlexaRuntime) {
  const track = runtime.previous
    ? await runtime.previous()
    : await defaultRuntime().previous!();
  const copy = messages(inputLocale(input));
  return requestSpeech(
    input,
    track ? copy.previous(trackSpeech(track)) : copy.noPrevious,
  );
}

async function queuePreviewResponse(input: any, runtime: AlexaRuntime) {
  const tracks = runtime.upcoming
    ? await runtime.upcoming()
    : await defaultRuntime().upcoming!();
  const copy = messages(inputLocale(input));
  const selected = tracks.filter(track => track.title.trim() && track.artist.trim()).slice(0, 3);
  return requestSpeech(
    input,
    selected.length ? copy.nextMany(selected.map(trackSpeech).join(', ')) : copy.noNext,
  );
}

type AlexaDetailType = 'album' | 'artist' | 'year' | 'genre' | 'language' | 'all';

function detailType(input: any): AlexaDetailType {
  const value = String(input.requestEnvelope?.request?.intent?.slots?.detailType?.value || '')
    .trim().toLocaleLowerCase();
  if (value === 'album' || value === 'artist' || value === 'year' || value === 'genre' || value === 'language') {
    return value;
  }
  return 'all';
}

function detailLabels(locale: string | null | undefined): { unavailable: string; all: string; labels: Record<AlexaDetailType, string> } {
  if (inputLocale({ requestEnvelope: { request: { locale } } }) === 'hi-IN') {
    return {
      unavailable: 'उपलब्ध नहीं',
      all: 'सारी जानकारी',
      labels: { album: 'album', artist: 'artist', year: 'year', genre: 'genre', language: 'language', all: 'सारी जानकारी' },
    };
  }
  return {
    unavailable: 'unavailable',
    all: 'all details',
    labels: { album: 'album', artist: 'artist', year: 'year', genre: 'genre', language: 'language', all: 'all details' },
  };
}

function detailFields(details: AlexaTrackDetails, requested: AlexaDetailType, locale: string | null | undefined): string {
  const labels = detailLabels(locale);
  const values: Record<Exclude<AlexaDetailType, 'all'>, string | null> = {
    album: details.album,
    artist: details.artist,
    year: details.year == null ? null : String(details.year),
    genre: details.genre,
    language: details.language,
  };
  const keys: Array<Exclude<AlexaDetailType, 'all'>> = requested === 'all'
    ? ['album', 'artist', 'year', 'genre', 'language']
    : [requested];
  return keys.map(key => `${labels.labels[key]} ${values[key] ? `"${escapeXmlCharacters(values[key] as string)}"` : labels.unavailable}`).join(', ');
}

async function listenerFeatureRequestResponse(
  input: any,
  runtime: AlexaRuntime,
  kind: 'moreLikeThis' | 'anotherByArtist',
) {
  const copy = messages(inputLocale(input));
  let result;
  try {
    result = kind === 'moreLikeThis'
      ? await listenerFeatures(runtime).moreLikeThis()
      : await listenerFeatures(runtime).anotherByArtist();
  } catch {
    return requestSpeech(input, copy.featureFailed);
  }
  if (result.kind === 'no-current') return requestSpeech(input, copy.noCurrent);
  if (result.kind === 'no-match') return requestSpeech(input, copy.featureNoMatch);

  const candidate = result.value;
  const userId = alexaUserId(input) || 'unknown';
  const personId = alexaPersonId(input) || undefined;
  const requestText = verifiedRequestText(candidate);
  const verified = verifiedCandidateFor(candidate);
  let submitted: AlexaSubmitResult;
  try {
    submitted = runtime.submitRequest
      ? await runtime.submitRequest({ text: requestText, userId, verifiedCandidate: verified, personId })
      : await defaultRuntime().submitRequest!({ text: requestText, userId, verifiedCandidate: verified, personId });
  } catch {
    return requestSpeech(input, copy.featureFailed);
  }
  if (!submitted.accepted) {
    return requestSpeech(input, dynamicSpeech(submitted.message || submitted.error, copy.featureFailed));
  }
  return requestSpeech(
    input,
    kind === 'moreLikeThis'
      ? copy.moreLikeThis(trackSpeech(featureTrack(candidate)))
      : copy.anotherByArtist(escapeXmlCharacters(candidate.artist)),
  );
}

async function recentTracksResponse(input: any, runtime: AlexaRuntime) {
  const copy = messages(inputLocale(input));
  try {
    const tracks = await listenerFeatures(runtime).recentTracks();
    return requestSpeech(input, tracks.length
      ? copy.recent(tracks.map(track => trackSpeech(featureTrack(track))).join(', '))
      : copy.recentEmpty);
  } catch {
    return requestSpeech(input, copy.recentEmpty);
  }
}

async function trackDetailsResponse(input: any, runtime: AlexaRuntime) {
  const copy = messages(inputLocale(input));
  let result;
  try {
    result = await listenerFeatures(runtime).trackDetails();
  } catch {
    return requestSpeech(input, copy.featureFailed);
  }
  if (result.kind === 'no-current') return requestSpeech(input, copy.noCurrent);
  if (result.kind === 'no-match') return requestSpeech(input, copy.featureNoMatch);
  const requested = detailType(input);
  const labels = detailLabels(inputLocale(input));
  const details = result.value;
  return requestSpeech(
    input,
    copy.details(
      escapeXmlCharacters(details.title),
      labels.labels[requested],
      detailFields(details, requested, inputLocale(input)),
    ),
  );
}

async function currentShowResponse(input: any, runtime: AlexaRuntime) {
  const copy = messages(inputLocale(input));
  let show: AlexaCurrentShow | null = null;
  try {
    show = await listenerFeatures(runtime).currentShow();
  } catch {
    // A show lookup is informational; use the same grounded no-show response
    // when schedule state is unavailable instead of inventing a programme.
  }
  if (!show?.name) {
    return requestSpeech(input, copy.noShow(show?.dj ? escapeXmlCharacters(show.dj) : null));
  }
  const dj = dynamicSpeech(show.dj, 'the DJ');
  const guests = (Array.isArray(show.guests) ? show.guests : [])
    .map(guest => escapeXmlCharacters(guest)).join(', ');
  return requestSpeech(input, copy.currentShow(escapeXmlCharacters(show.name), dj, guests));
}

function dedicationDialogResponse(input: any, copy: ReturnType<typeof messages>) {
  const dialogState = input.requestEnvelope?.request?.dialogState;
  const requestText = String(input.requestEnvelope?.request?.intent?.slots?.requestText?.value || '').trim();
  const hasSong = Boolean(requestText) && !isGenericDedicationSong(requestText);
  const hasTarget = Boolean(input.requestEnvelope?.request?.intent?.slots?.dedicationTarget?.value);
  if (isGenericDedicationSong(requestText)) {
    return input.responseBuilder
      .speak(copy.dedicationPrompt)
      .addElicitSlotDirective('requestText')
      .withShouldEndSession(false)
      .getResponse();
  }
  if (dialogState && dialogState !== 'COMPLETED') {
    return input.responseBuilder.addDelegateDirective().getResponse();
  }
  if (!hasSong) {
    return input.responseBuilder
      .speak(copy.dedicationPrompt)
      .addElicitSlotDirective('requestText')
      .withShouldEndSession(false)
      .getResponse();
  }
  if (!hasTarget) {
    return input.responseBuilder
      .speak(copy.dedicationTargetPrompt)
      .addElicitSlotDirective('dedicationTarget')
      .withShouldEndSession(false)
      .getResponse();
  }
  return null;
}

async function dedicationResponse(input: any, runtime: AlexaRuntime) {
  const copy = messages(inputLocale(input));
  const delegated = dedicationDialogResponse(input, copy);
  if (delegated) return delegated;

  const requestText = String(input.requestEnvelope.request.intent?.slots?.requestText?.value || '').trim();
  const rawTarget = String(input.requestEnvelope.request.intent?.slots?.dedicationTarget?.value || '').trim();
  const target = cleanDedicationTarget(rawTarget);
  const parsed = listenerRequestSchema.safeParse({ text: requestText, name: '' });
  if (!parsed.success || !target) {
    return requestSpeech(input, !parsed.success ? copy.dedicationPrompt : copy.dedicationTargetPrompt);
  }
  const userId = alexaUserId(input) || 'unknown';
  const personId = alexaPersonId(input) || undefined;
  const dedication = { target, locale: inputLocale(input) as 'en-US' | 'en-IN' | 'hi-IN' };
  const result = runtime.submitRequest
    ? await runtime.submitRequest({ text: parsed.data.text, userId, personId, dedication })
    : await defaultRuntime().submitRequest!({ text: parsed.data.text, userId, personId, dedication });
  return requestSpeech(
    input,
    result.accepted ? copy.dedicationAccepted : dynamicSpeech(result.message || result.error, copy.dedicationFailed),
  );
}

function reminderStatus(runtime: AlexaRuntime, identity: string, requestId: string) {
  return runtime.requestStatus
    ? runtime.requestStatus(identity, requestId)
    : defaultRuntime().requestStatus!(identity, requestId);
}

function reminderClient(runtime: AlexaRuntime, input: any): AlexaReminderClient {
  return runtime.reminderClient || reminderClientFor(input);
}

async function removeRequestReminder(
  input: any,
  runtime: AlexaRuntime,
  identity: string,
  status: ListenerRequestStatus | null,
): Promise<void> {
  const requestId = status?.requestId;
  if (!requestId) return;
  const creation = reminderCreations.get(requestId);
  if (creation) {
    creation.cancelled = true;
    await creation.done;
  }
  const alertToken = status?.reminder?.alertToken || creation?.alertToken;
  if (alertToken) {
    try {
      if (!creation?.deleted) {
        await reminderClient(runtime, input).delete(alertToken);
        if (creation) creation.deleted = true;
      }
      const cleared = runtime.clearReminder
        ? await runtime.clearReminder(identity, requestId)
        : await defaultRuntime().clearReminder!(identity, requestId);
      if (!cleared) console.error(`[alexa] reminder ledger cleanup found no record for ${requestId}`);
    } catch (error) {
      console.error(`[alexa] reminder cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await clearReminderConsentState(runtime, { requestId, identity, locale: inputLocale(input) as AlexaReminderPending['locale'] });
}

async function createPendingReminder(input: any, runtime: AlexaRuntime, pending: AlexaReminderPending) {
  const copy = messages(pending.locale);
  if (reminderCreations.has(pending.requestId)) return requestSpeech(input, copy.reminderAlreadySet);
  let resolveDone!: () => void;
  const state: ReminderCreationState = {
    cancelled: false,
    deleted: false,
    done: new Promise(resolve => { resolveDone = resolve; }),
    resolveDone: () => resolveDone(),
  };
  reminderCreations.set(pending.requestId, state);
  let created: { alertToken: string } | null = null;
  try {
    const client = reminderClient(runtime, input);
    const status = await reminderStatus(runtime, pending.identity, pending.requestId);
    if (!status || status.phase !== 'queued' || !status.track?.title || !reminderEtaAllowed(status.etaSeconds)) {
      await clearReminderConsentState(runtime, pending);
      clearPendingReminder(input);
      return requestSpeech(input, copy.reminderStale);
    }
    if (status.reminder?.alertToken) {
      await clearReminderConsentState(runtime, pending);
      clearPendingReminder(input);
      return requestSpeech(input, copy.reminderAlreadySet);
    }

    const offsetInSeconds = reminderOffsetSeconds(status.etaSeconds!);
    const createdAt = Date.now();
    const triggerAt = createdAt + offsetInSeconds * 1000;
    const reminderRequest = {
      requestTime: new Date(createdAt).toISOString(),
      trigger: { type: 'SCHEDULED_RELATIVE' as const, offsetInSeconds },
      alertInfo: {
        spokenInfo: {
          content: [{
            locale: pending.locale,
            text: pending.locale === 'hi-IN'
              ? `${status.track.title} की request जल्द बजने वाली है।`
              : `Your requested song ${status.track.title} is expected to play soon.`,
          }],
        },
      },
      pushNotification: { status: 'DISABLED' as const },
    };

    created = await client.create(reminderRequest);
    state.alertToken = created.alertToken;

    // Cancellation can happen while Alexa is creating the external reminder.
    // Re-read queue state before persisting the token so cancelled requests
    // cannot acquire a reminder after the cancellation cleanup raced us.
    const current = await reminderStatus(runtime, pending.identity, pending.requestId);
    if (state.cancelled || !current || current.phase !== 'queued' || !reminderEtaAllowed(current.etaSeconds) || current.reminder?.alertToken) {
      await client.delete(created.alertToken);
      state.deleted = true;
      await clearReminderConsentState(runtime, pending);
      clearPendingReminder(input);
      return requestSpeech(input, copy.reminderStale);
    }

    const reminder: RequestReminder = {
      alertToken: created.alertToken,
      createdAt,
      triggerAt,
      forecastSeconds: status.etaSeconds!,
      leadSeconds: 60,
    };
    const saved = runtime.saveReminder
      ? await runtime.saveReminder(pending.identity, pending.requestId, reminder)
      : await defaultRuntime().saveReminder!(pending.identity, pending.requestId, reminder);
    if (!saved) throw new Error('request reminder ownership check failed');
    await clearReminderConsentState(runtime, pending);
    clearPendingReminder(input);
    return requestSpeech(input, copy.reminderSet(escapeXmlCharacters(status.track.title)));
  } catch (error) {
    if (created && !state.deleted) {
      try { await reminderClient(runtime, input).delete(created.alertToken); } catch {}
      state.deleted = true;
    }
    console.error(`[alexa] reminder ledger save failed: ${error instanceof Error ? error.message : String(error)}`);
    await clearReminderConsentState(runtime, pending);
    clearPendingReminder(input);
    return requestSpeech(input, copy.reminderFailed);
  } finally {
    if (reminderCreations.get(pending.requestId) === state) reminderCreations.delete(pending.requestId);
    state.resolveDone();
  }
}

async function requestReminderResponse(input: any, runtime: AlexaRuntime) {
  const copy = messages(inputLocale(input));
  const identity = alexaRequestIdentity(input);
  const status = runtime.latestRequestStatus
    ? await runtime.latestRequestStatus(identity)
    : await defaultRuntime().latestRequestStatus!(identity);
  if (!status) return requestSpeech(input, copy.reminderEmpty);
  if (status.phase === 'pending') return requestSpeech(input, copy.reminderPending);
  if (status.reminder?.alertToken) return requestSpeech(input, copy.reminderAlreadySet);
  if (status.phase !== 'queued' || !reminderEtaAllowed(status.etaSeconds) || !status.track?.title) {
    return requestSpeech(input, copy.reminderUnavailable);
  }
  const pending = {
    requestId: status.requestId!,
    identity,
    locale: inputLocale(input) as 'en-US' | 'en-IN' | 'hi-IN',
  };
  savePendingReminder(input, pending);
  return input.responseBuilder
    .speak(copy.reminderConfirm(
      escapeXmlCharacters(status.track.title),
      etaSpeech(status.etaSeconds, pending.locale) || 'soon',
    ))
    .reprompt(copy.reminderConfirm(escapeXmlCharacters(status.track.title), etaSpeech(status.etaSeconds, pending.locale) || 'soon'))
    .withShouldEndSession(false)
    .getResponse();
}

async function reminderConfirmationResponse(input: any, runtime: AlexaRuntime, confirmed: boolean) {
  const pending = pendingReminder(input);
  if (!pending) return null;
  if (!confirmed) {
    clearPendingReminder(input);
    return requestSpeech(input, messages(pending.locale).reminderDenied);
  }
  const copy = messages(pending.locale);
  // Alexa's consentToken is the skill's global reminders permission. A
  // separate voice-consent response is required for every reminder, even
  // when that global token is already present.
  const permissionToken = pending.permissionToken || `request-reminder:${pending.requestId}`;
  const createdAt = Date.now();
  const consentSaved = runtime.saveReminderConsent
    ? await runtime.saveReminderConsent(pending.identity, pending.requestId, {
      permissionToken,
      locale: pending.locale,
      createdAt,
      expiresAt: createdAt + REMINDER_CONSENT_TTL_MS,
    })
    : true;
  if (!consentSaved) {
    clearPendingReminder(input);
    return requestSpeech(input, copy.reminderStale);
  }
  savePendingReminder(input, { ...pending, permissionToken });
  return input.responseBuilder
    .speak(copy.reminderPermission)
    .addDirective({
      type: 'Connections.SendRequest',
      name: 'AskFor',
      payload: {
        '@type': 'AskForPermissionsConsentRequest',
        '@version': '2',
        permissionScopes: [{ permissionScope: REMINDER_PERMISSION, consentLevel: 'ACCOUNT' }],
      },
      token: permissionToken,
    })
    // Alexa owns the follow-up consent conversation. Ending the skill session
    // here is required for the Connections.Response workflow to be delivered.
    .withShouldEndSession(true)
    .getResponse();
}

async function reminderPermissionResponse(input: any, runtime: AlexaRuntime) {
  const responseToken = input.requestEnvelope?.request?.token;
  const pending = await pendingReminderForResponse(input, runtime, responseToken);
  if (!pending) return requestSpeech(input, messages(inputLocale(input)).reminderStale);
  if (!pending.permissionToken || responseToken !== pending.permissionToken) {
    console.error('[alexa] ignoring reminder permission response with an unexpected token');
    return requestSpeech(input, messages(pending.locale).reminderStale);
  }
  const body = input.requestEnvelope?.request?.payload || input.requestEnvelope?.request?.body || {};
  const scopes = Array.isArray(body.permissionScopes) ? body.permissionScopes : [body.permissionScopes];
  const scope = scopes.find((candidate: any) => candidate?.permissionScope === REMINDER_PERMISSION);
  // Alexa puts the consent result on the payload, alongside permissionScopes.
  // It is not a field on the individual scope object.
  const status = body.status;
  if (!scope) {
    await clearReminderConsentState(runtime, pending);
    clearPendingReminder(input);
    return requestSpeech(input, messages(pending.locale).reminderFailed);
  }
  if (status !== 'ACCEPTED') {
    if (status === 'NOT_ANSWERED') {
      return input.responseBuilder
        .speak(messages(pending.locale).reminderPermissionRetry)
        .reprompt(messages(pending.locale).reminderPermissionRetry)
        .withShouldEndSession(false)
        .getResponse();
    }
    await clearReminderConsentState(runtime, pending);
    clearPendingReminder(input);
    return requestSpeech(input, status === 'DENIED'
      ? messages(pending.locale).reminderDenied
      : messages(pending.locale).reminderFailed);
  }
  return createPendingReminder(input, runtime, pending);
}

async function requestSongResponse(input: any, runtime: AlexaRuntime) {
  const rawText = String(input.requestEnvelope.request.intent?.slots?.requestText?.value || '').trim();
  const parsed = listenerRequestSchema.safeParse({ text: rawText, name: '' });
  const copy = messages(inputLocale(input));
  clearRequestClarification(input);
  if (!parsed.success) {
    return requestSpeech(input, copy.requestPrompt);
  }
  if (runtime.previewRequest) {
    try {
      const candidates = await runtime.previewRequest(parsed.data.text);
      if (candidates.length > 1) {
        return clarificationResponse(input, runtime, candidates[0], candidates.slice(1));
      }
    } catch {
      // Preview is an optional voice convenience. The normal request pipeline
      // remains authoritative when the catalogue search is unavailable.
    }
  }
  const userId = alexaUserId(input) || 'unknown';
  const personId = alexaPersonId(input) || undefined;
  const result = runtime.submitRequest
    ? await runtime.submitRequest({ text: parsed.data.text, userId, personId })
    : await defaultRuntime().submitRequest!({ text: parsed.data.text, userId, personId });
  if (result.accepted) {
    return requestSpeech(input, copy.requestAccepted);
  }
  return requestSpeech(input, dynamicSpeech(result.message || result.error, copy.requestFailed));
}

async function confirmationResponse(input: any, runtime: AlexaRuntime, confirmed: boolean) {
  const candidates = requestCandidates(input);
  if (!candidates.length) return helpResponse(input);
  const copy = messages(inputLocale(input));
  if (!confirmed) {
    const [, ...remaining] = candidates;
    if (!remaining.length) {
      clearRequestClarification(input);
      return requestSpeech(input, copy.candidateNo);
    }
    const [next, ...rest] = remaining;
    return clarificationResponse(input, runtime, next, rest);
  }

  const selected = candidates[0];
  clearRequestClarification(input);
  const userId = alexaUserId(input) || 'unknown';
  const personId = alexaPersonId(input) || undefined;
  const text = `play "${selected.title}" by "${selected.artist}"`;
  const result = runtime.submitRequest
    ? await runtime.submitRequest!({ text, userId, personId })
    : await defaultRuntime().submitRequest!({ text, userId, personId });
  return requestSpeech(input, result.accepted ? copy.requestAccepted : dynamicSpeech(result.message || result.error, copy.requestFailed));
}

function statusSpeech(status: ListenerRequestStatus | null, locale?: string | null): string {
  const copy = messages(locale);
  if (!status) return copy.statusEmpty;
  const title = status.track?.title ? ` for ${escapeXmlCharacters(status.track.title)}` : '';
  const trackTitle = dynamicSpeech(status.track?.title, 'your song');
  switch (status.phase) {
    case 'queued':
      return copy.requestQueued(
        trackTitle,
        status.queuePosition ?? null,
        etaSpeech(status.etaSeconds, locale),
      );
    case 'playing':
      return copy.requestPlaying(trackTitle);
    case 'finished':
      return copy.requestFinished(trackTitle);
    case 'cancelled':
      return copy.requestCancelled(trackTitle);
    case 'interrupted':
      return copy.requestInterrupted;
    case 'failed':
      return dynamicSpeech(status.message, copy.requestFailedStatus);
    case 'resolved':
      return status.ack ? dynamicSpeech(status.ack, copy.requestFailedStatus) : copy.requestResolved(title);
    case 'pending':
    default:
      return copy.requestPending;
  }
}

async function requestStatusResponse(input: any, runtime: AlexaRuntime) {
  const identity = alexaRequestIdentity(input);
  const status = runtime.latestRequestStatus
    ? await runtime.latestRequestStatus(identity)
    : await defaultRuntime().latestRequestStatus!(identity);
  return requestSpeech(
    input,
    statusSpeech(status, inputLocale(input)),
  );
}

async function cancelRequestResponse(input: any, runtime: AlexaRuntime) {
  const identity = alexaRequestIdentity(input);
  const before = runtime.latestRequestStatus
    ? await runtime.latestRequestStatus(identity)
    : await defaultRuntime().latestRequestStatus!(identity);
  const status = runtime.cancelRequest
    ? await runtime.cancelRequest(identity)
    : await defaultRuntime().cancelRequest!(identity);
  const copy = messages(inputLocale(input));
  if (!status) return requestSpeech(input, copy.cancelEmpty);
  if (status.phase === 'cancelled') {
    await removeRequestReminder(input, runtime, identity, before);
    return requestSpeech(input, copy.cancelSuccess(dynamicSpeech(status.track?.title, 'song')));
  }
  return requestSpeech(input, copy.cancelTooLate);
}

async function replaceRequestResponse(input: any, runtime: AlexaRuntime) {
  const rawText = String(input.requestEnvelope.request.intent?.slots?.requestText?.value || '').trim();
  const parsed = listenerRequestSchema.safeParse({ text: rawText, name: '' });
  const copy = messages(inputLocale(input));
  if (!parsed.success) return requestSpeech(input, copy.replacePrompt);
  const identity = alexaRequestIdentity(input);
  const before = runtime.latestRequestStatus
    ? await runtime.latestRequestStatus(identity)
    : await defaultRuntime().latestRequestStatus!(identity);
  const result = runtime.replaceRequest
    ? await runtime.replaceRequest(identity, parsed.data.text)
    : await defaultRuntime().replaceRequest!(identity, parsed.data.text);
  if (before?.requestId) {
    const after = result.accepted ? null : await reminderStatus(runtime, identity, before.requestId);
    if (result.accepted || after?.phase === 'cancelled') {
      await removeRequestReminder(input, runtime, identity, before);
    }
  }
  return requestSpeech(
    input,
    result.accepted ? copy.replaceAccepted : dynamicSpeech(result.message || result.error, copy.requestFailed),
  );
}

async function stationStatusResponse(input: any, runtime: AlexaRuntime) {
  const copy = messages(inputLocale(input));
  return requestSpeech(input, runtime.isStreamOnline() ? copy.stationOnline : copy.stationOffline);
}

async function yesResponse(input: any, runtime: AlexaRuntime) {
  const reminder = await reminderConfirmationResponse(input, runtime, true);
  return reminder || confirmationResponse(input, runtime, true);
}

async function noResponse(input: any, runtime: AlexaRuntime) {
  const reminder = await reminderConfirmationResponse(input, runtime, false);
  return reminder || confirmationResponse(input, runtime, false);
}

/**
 * Build the official Alexa Custom Skill SDK dispatcher.
 *
 * The runtime is injected so this public behavior can be tested without an
 * Icecast process and so every request observes the current station name and
 * settings rather than a value captured at controller startup.
 */
export function createAlexaSkill(runtime: AlexaRuntime = defaultRuntime()) {
  const configured = runtime.getSettings();
  const builder = SkillBuilders.custom()
    .withSkillId(configured.skillId || '__disabled__')
    .withApiClient(new DefaultApiClient());

  return builder
    .addRequestHandler('LaunchRequest', (input: any) => playResponse(input, runtime, messages(inputLocale(input)).starting))
    .addRequestHandlers(
      intentHandler(['RequestSongIntent'], input => requestSongResponse(input, runtime)),
      intentHandler(['DedicationIntent'], input => dedicationResponse(input, runtime)),
      intentHandler(['RequestReminderIntent'], input => requestReminderResponse(input, runtime)),
      intentHandler(['AMAZON.YesIntent'], input => yesResponse(input, runtime)),
      intentHandler(['AMAZON.NoIntent'], input => noResponse(input, runtime)),
      intentHandler(['RequestStatusIntent'], input => requestStatusResponse(input, runtime)),
      intentHandler(['CancelRequestIntent'], input => cancelRequestResponse(input, runtime)),
      intentHandler(['ReplaceRequestIntent'], input => replaceRequestResponse(input, runtime)),
      intentHandler(['NowPlayingIntent', 'WhatIsPlayingIntent', 'CurrentSongIntent'], input =>
        nowPlayingResponse(input, runtime)),
      intentHandler(['PreviousTrackIntent'], input => previousResponse(input, runtime)),
      intentHandler(['UpcomingIntent', 'NextSongIntent', 'WhatIsNextIntent'], input =>
        upcomingResponse(input, runtime)),
      intentHandler(['QueuePreviewIntent'], input => queuePreviewResponse(input, runtime)),
      intentHandler(['MoreLikeThisIntent'], input => listenerFeatureRequestResponse(input, runtime, 'moreLikeThis')),
      intentHandler(['AnotherByArtistIntent'], input => listenerFeatureRequestResponse(input, runtime, 'anotherByArtist')),
      intentHandler(['RecentTracksIntent'], input => recentTracksResponse(input, runtime)),
      intentHandler(['TrackDetailsIntent'], input => trackDetailsResponse(input, runtime)),
      intentHandler(['CurrentShowIntent'], input => currentShowResponse(input, runtime)),
      intentHandler(['StationStatusIntent'], input => stationStatusResponse(input, runtime)),
      intentHandler(['StartRadioIntent', 'PlayRadioIntent'], input =>
        playResponse(input, runtime, messages(inputLocale(input)).starting)),
      intentHandler(['AMAZON.ResumeIntent'], input =>
        playResponse(input, runtime, messages(inputLocale(input)).resuming)),
      intentHandler(['AMAZON.PauseIntent'], input =>
        stopResponse(input, messages(inputLocale(input)).paused)),
      intentHandler(['AMAZON.StopIntent'], input =>
        stopResponse(input, messages(inputLocale(input)).stopped)),
      intentHandler(['AMAZON.CancelIntent'], input => cancelRequestResponse(input, runtime)),
      intentHandler(['AMAZON.HelpIntent'], (input: any) =>
        helpResponse(input)),
      intentHandler(['AMAZON.FallbackIntent'], (input: any) =>
        helpResponse(input)),
      {
        canHandle: (input: any) => input.requestEnvelope.request.type === 'SessionEndedRequest',
        handle: () => ({}),
      },
      intentHandler(['AMAZON.NavigateHomeIntent'], (input: any) =>
        stopResponse(input, messages(inputLocale(input)).stopped)),
      {
        canHandle: (input: any) => input.requestEnvelope.request.type === 'Connections.Response'
          && input.requestEnvelope.request.name === 'AskFor',
        handle: (input: any) => reminderPermissionResponse(input, runtime),
      },
      {
        canHandle: (input: any) => input.requestEnvelope.request.type === 'IntentRequest',
        handle: (input: any) => helpResponse(input),
      },
    )
    .addErrorHandler(
      () => true,
      (input: any) => requestSpeech(input, messages(inputLocale(input)).error),
    )
    .create();
}

function runAdapter(req: express.Request, res: express.Response, next: express.NextFunction) {
  const runtime = defaultRuntime();
  const adapterHandlers = new ExpressAdapter(createAlexaSkill(runtime)).getRequestHandlers();
  let index = 0;
  const run: express.NextFunction = (error?: unknown) => {
    if (error) return next(error);
    const handler = adapterHandlers[index++];
    if (!handler) return next();
    void handler(req, res, run);
  };
  run();
}

router.post('/alexa', (req, res, next) => {
  const current = defaultRuntime().getSettings();
  if (!current.enabled || !current.skillId) {
    return res.status(404).json({ error: 'Alexa integration is disabled' });
  }
  if (!current.streamUrl) {
    return res.status(503).json({ error: 'Alexa requires SITE_URL to point to the public station URL' });
  }
  return runAdapter(req, res, next);
});

router.get('/alexa/connection', requireAdmin, (_req, res) => {
  const current = settings.get();
  const siteUrl = configuredSiteUrl();
  const streamMount = effectiveAlexaStreamMount(current.alexa?.streamMount, current.stream);
  res.json({
    station: current.station || 'SUB/WAVE',
    stationDescription: current.stationDescription || '',
    siteUrl,
    webhookUrl: siteUrl ? `${siteUrl}/api/alexa` : '',
    streamMount,
    streamUrl: alexaStreamUrl(siteUrl, streamMount),
    streamOptions: alexaStreamOptions(current.stream),
    listenerAuth: current.privacy?.listenerAuth === true,
    directSkill: {
      enabled: current.alexa?.enabled === true,
      skillId: typeof current.alexa?.skillId === 'string' ? current.alexa.skillId : '',
      tokenTtlHours: current.alexa?.tokenTtlHours || DEFAULT_ALEXA_TOKEN_TTL_HOURS,
    },
  });
});

// This route shares the Alexa router with the raw-body skill webhook. The
// router is mounted before the controller-wide JSON parser so Amazon's
// signature verification sees the original bytes; parse this small admin-only
// draft explicitly instead of letting it fall through as an empty object.
router.post('/alexa/connection/test', requireAdmin, express.json({ limit: '10kb' }), async (req, res) => {
  try {
    const saved = defaultRuntime().getSettings();
    const parsed = alexaPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: parsed.error.issues[0]?.message || 'Invalid Alexa draft settings',
      });
    }
    const draft: AlexaConnectionTestDraft = {
      enabled: parsed.data.enabled ?? saved.enabled,
      skillId: parsed.data.skillId ?? saved.skillId,
      streamMount: parsed.data.streamMount ?? saved.streamMount ?? '/stream.mp3',
      tokenTtlHours: parsed.data.tokenTtlHours ?? Math.round((saved.tokenTtlSeconds || DEFAULT_ALEXA_TOKEN_TTL_HOURS * 3600) / 3600),
    };
    return res.json(await testAlexaConnection(undefined, undefined, draft));
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Alexa connection test failed' });
  }
});

export { router };
