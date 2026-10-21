import express from 'express';
import { SkillBuilders, escapeXmlCharacters } from 'ask-sdk-core';
import { ExpressAdapter } from 'ask-sdk-express-adapter';
import * as settings from '../settings.js';
import { getStreamStatus } from '../broadcast/listeners.js';
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

const router = express.Router();
const ALEXA_SKILL_ID_RE = /^amzn1\.ask\.skill\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  return escapeXmlCharacters(runtime.getSettings().station.trim() || 'SUB/WAVE');
}

function offlineResponse(input: any) {
  return input.responseBuilder
    .speak('The station is currently offline.')
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

function playResponse(input: any, runtime: AlexaRuntime, opening: string) {
  const station = stationName(runtime);
  const streamUrl = playbackStreamUrl(runtime);
  if (!runtime.isStreamOnline() || !streamUrl) return offlineResponse(input);

  return input.responseBuilder
    .speak(`${opening} ${station}.`)
    .addAudioPlayerPlayDirective(
      'REPLACE_ALL',
      streamUrl,
      'subwave-live-stream',
      0,
    )
    .withShouldEndSession(true)
    .getResponse();
}

function stopResponse(input: any, message: string) {
  return input.responseBuilder
    .speak(message)
    .addAudioPlayerStopDirective()
    .withShouldEndSession(true)
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

/**
 * Build the official Alexa Custom Skill SDK dispatcher.
 *
 * The runtime is injected so this public behavior can be tested without an
 * Icecast process and so every request observes the current station name and
 * settings rather than a value captured at controller startup.
 */
export function createAlexaSkill(runtime: AlexaRuntime = defaultRuntime()) {
  const configured = runtime.getSettings();
  const builder = SkillBuilders.custom().withSkillId(configured.skillId || '__disabled__');

  return builder
    .addRequestHandler('LaunchRequest', (input: any) => playResponse(input, runtime, 'Starting'))
    .addRequestHandlers(
      intentHandler(['StartRadioIntent', 'PlayRadioIntent'], input =>
        playResponse(input, runtime, 'Starting')),
      intentHandler(['AMAZON.ResumeIntent'], input =>
        playResponse(input, runtime, 'Resuming')),
      intentHandler(['AMAZON.PauseIntent'], input =>
        stopResponse(input, 'Radio paused.')),
      intentHandler(['AMAZON.StopIntent', 'AMAZON.CancelIntent'], input =>
        stopResponse(input, 'Radio stopped.')),
      intentHandler(['AMAZON.HelpIntent'], (input: any) =>
        input.responseBuilder
          .speak('You can say start, pause, resume, or stop the radio.')
          .withShouldEndSession(false)
          .getResponse()),
      intentHandler(['AMAZON.FallbackIntent'], (input: any) =>
        input.responseBuilder
          .speak('You can say start, pause, resume, or stop the radio.')
          .withShouldEndSession(false)
          .getResponse()),
      {
        canHandle: (input: any) => input.requestEnvelope.request.type === 'SessionEndedRequest',
        handle: () => ({}),
      },
      intentHandler(['AMAZON.NavigateHomeIntent'], (input: any) =>
        stopResponse(input, 'Radio stopped.')),
      {
        canHandle: (input: any) => input.requestEnvelope.request.type === 'IntentRequest',
        handle: (input: any) =>
          input.responseBuilder
            .speak('You can say start, pause, resume, or stop the radio.')
            .withShouldEndSession(false)
            .getResponse(),
      },
    )
    .addErrorHandler(
      () => true,
      (input: any) =>
        input.responseBuilder
          .speak('Sorry, I could not control the radio.')
          .withShouldEndSession(true)
          .getResponse(),
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
