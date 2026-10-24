import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { RequestEnvelope } from 'ask-sdk-model';

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'subwave-alexa-'));
process.env.SITE_URL = 'https://radio.example';

const { DEFAULTS } = await import('../src/settings/defaults.js');
const { alexaPatchSchema } = await import('../src/schemas/settings.js');
const { verifyAlexaStreamToken } = await import('../src/alexa/token.js');
const { AlexaListenerFeatureService } = await import('../src/alexa/listener-features.js');
const { createAlexaSkill, router, testAlexaConnection } = await import('../src/routes/alexa.js');
const { verifiedCandidateMatches } = await import('../src/routes/request.js');
const settings = await import('../src/settings.js');

const skillId = 'amzn1.ask.skill.11111111-1111-4111-8111-111111111111';

function envelope(
  request: Record<string, unknown>,
  applicationId = skillId,
): RequestEnvelope {
  return {
    version: '1.0',
    session: {
      new: true,
      sessionId: 'SessionId.test',
      application: { applicationId },
      user: { userId: 'amzn1.ask.account.test' },
    },
    context: {
      System: {
        application: { applicationId },
        user: { userId: 'amzn1.ask.account.test' },
        device: {
          deviceId: 'amzn1.ask.device.test',
          supportedInterfaces: { AudioPlayer: {} },
        },
        apiEndpoint: 'https://api.amazonalexa.com',
      },
    },
    request,
  } as unknown as RequestEnvelope;
}

function launch() {
  return envelope({
    type: 'LaunchRequest',
    requestId: 'EdwRequestId.launch',
    timestamp: '2026-10-21T12:00:00Z',
    locale: 'en-IN',
  }, skillId);
}

function intent(name: string, slots: Record<string, unknown> = {}, attributes: Record<string, unknown> = {}, locale = 'en-IN') {
  const result = envelope({
    type: 'IntentRequest',
    requestId: `EdwRequestId.${name}`,
    timestamp: '2026-10-21T12:00:00Z',
    locale,
    intent: { name, confirmationStatus: 'NONE', slots },
  });
  (result.session as any).attributes = attributes;
  return result;
}

const runtime = {
  getSettings: () => ({
    enabled: true,
    skillId,
    station: 'EXAMPLE STATION',
    streamMount: '/stream.mp3',
    streamUrl: 'https://radio.example/stream.mp3',
  }),
  isStreamOnline: () => true,
};

test('Alexa is disabled by default and its patch accepts one skill id', () => {
  assert.deepEqual(DEFAULTS.alexa, { enabled: false, skillId: '', streamMount: '/stream.mp3', tokenTtlHours: 24 });
  assert.deepEqual(alexaPatchSchema.parse({ enabled: true, skillId: ` ${skillId} ` }), {
    enabled: true,
    skillId,
  });
});
test('Alexa cannot be enabled without a Skill ID and supports a private listener stream', async () => {
  await settings.load();
  await assert.rejects(
    settings.update({ alexa: { enabled: true } }),
    /requires a Skill ID/i,
  );

  await settings.update({ alexa: { enabled: true, skillId } });
  assert.equal(settings.get().alexa.enabled, true);

  await settings.update({ privacy: { listenerAuth: true, password: 'private-test-password' } });
  assert.equal(settings.get().privacy.listenerAuth, true);
});

test('Alexa launches the currently configured station and uses its public stream URL', async () => {
  const response = await createAlexaSkill(runtime).invoke(launch());
  const body = response.response as any;

  assert.equal(body.outputSpeech.ssml, '<speak>Starting EXAMPLE STATION.</speak>');
  assert.equal(body.shouldEndSession, true);
  assert.deepEqual(body.directives, [{
    type: 'AudioPlayer.Play',
    playBehavior: 'REPLACE_ALL',
    audioItem: {
      stream: {
        url: 'https://radio.example/stream.mp3',
        token: 'subwave-live-stream',
        offsetInMilliseconds: 0,
      },
      metadata: {
        title: 'EXAMPLE STATION',
        subtitle: 'Live station',
      },
    },
  }]);
});

test('Alexa keeps playback available when optional now-playing metadata fails', async () => {
  const response = (await createAlexaSkill({
    ...runtime,
    nowPlaying: async () => { throw new Error('catalogue unavailable'); },
  }).invoke(launch())).response as any;
  assert.equal(response.directives[0].type, 'AudioPlayer.Play');
  assert.equal(response.directives[0].audioItem.metadata.subtitle, 'Live station');
});

test('Alexa creates a fresh mount-bound token for protected playback', async () => {
  const protectedRuntime = {
    ...runtime,
    getSettings: () => ({
      ...runtime.getSettings(),
      listenerAuth: true,
      listenerPassword: 'private-test-password',
      tokenTtlSeconds: 3600,
    }),
  };
  const first = (await createAlexaSkill(protectedRuntime).invoke(launch())).response as any;
  const second = (await createAlexaSkill(protectedRuntime).invoke(launch())).response as any;
  const firstUrl = first.directives[0].audioItem.stream.url as string;
  const secondUrl = second.directives[0].audioItem.stream.url as string;
  const firstToken = new URL(firstUrl).searchParams.get('auth') || '';
  const secondToken = new URL(secondUrl).searchParams.get('auth') || '';

  assert.notEqual(firstToken, secondToken, 'each play response gets a fresh token');
  assert.equal(firstUrl.startsWith('https://radio.example/stream.mp3?auth='), true);
  assert.equal(verifyAlexaStreamToken(firstToken, 'private-test-password', '/stream.mp3'), true);
  assert.equal(verifyAlexaStreamToken(firstToken, 'private-test-password', '/stream.opus'), false);
});

test('Alexa refuses playback when the station is offline', async () => {
  const response = await createAlexaSkill({
    ...runtime,
    isStreamOnline: () => false,
  }).invoke(launch());
  const body = response.response as any;

  assert.equal(body.outputSpeech.ssml, '<speak>The station is currently offline.</speak>');
  assert.equal(body.directives, undefined);
});

test('pause and stop stop live playback, while resume starts at the live edge', async () => {
  const skill = createAlexaSkill(runtime);
  const pause = (await skill.invoke(intent('AMAZON.PauseIntent'))).response as any;
  const stop = (await skill.invoke(intent('AMAZON.StopIntent'))).response as any;
  const resume = (await skill.invoke(intent('AMAZON.ResumeIntent'))).response as any;

  assert.equal(pause.outputSpeech.ssml, '<speak>Radio paused.</speak>');
  assert.deepEqual(pause.directives, [{ type: 'AudioPlayer.Stop' }]);
  assert.equal(stop.outputSpeech.ssml, '<speak>Radio stopped.</speak>');
  assert.deepEqual(stop.directives, [{ type: 'AudioPlayer.Stop' }]);
  assert.equal(resume.outputSpeech.ssml, '<speak>Resuming EXAMPLE STATION.</speak>');
  assert.equal(resume.directives[0].audioItem.stream.offsetInMilliseconds, 0);
});

test('Alexa acknowledges a song request immediately through the shared request pipeline', async () => {
  const submitted: Array<{ text: string; userId: string }> = [];
  const response = await createAlexaSkill({
    ...runtime,
    submitRequest: async ({ text, userId }) => {
      submitted.push({ text, userId });
      return { accepted: true, statusCode: 202, requestId: 'request-1', status: 'pending' };
    },
  }).invoke(intent('RequestSongIntent', {
    requestText: { name: 'requestText', value: 'play Daft Punk', confirmationStatus: 'NONE' },
  }));
  const body = response.response as any;

  assert.equal(body.outputSpeech.ssml, '<speak>Your request was sent to the booth. It will play when available.</speak>');
  assert.equal(body.shouldEndSession, true);
  assert.deepEqual(submitted, [{ text: 'play Daft Punk', userId: 'amzn1.ask.account.test' }]);
});

test('Alexa asks for confirmation only when a named request has several catalogue matches', async () => {
  const submitted: string[] = [];
  const candidates = [
    { id: 'track-1', title: 'Single', artist: 'Taylor Swift', album: 'First album' },
    { id: 'track-2', title: 'Single', artist: 'Taylor Swift', album: 'Second album' },
  ];
  const skill = createAlexaSkill({
    ...runtime,
    previewRequest: async () => candidates,
    submitRequest: async ({ text }) => {
      submitted.push(text);
      return { accepted: true, statusCode: 202, requestId: 'request-confirmed', status: 'pending' };
    },
  });
  const questionResult = await skill.invoke(intent('RequestSongIntent', {
    requestText: { name: 'requestText', value: 'request single by Taylor Swift' },
  }));
  const question = questionResult.response as any;
  assert.match(question.outputSpeech.ssml, /I found Single by Taylor Swift/);
  assert.equal(question.shouldEndSession, false);
  assert.equal(question.reprompt.outputSpeech.ssml, '<speak>Say yes to request it, or no to hear the next match.</speak>');

  const yes = (await skill.invoke(intent('AMAZON.YesIntent', {}, questionResult.sessionAttributes))).response as any;
  assert.match(yes.outputSpeech.ssml, /Your request was sent/);
  assert.deepEqual(submitted, ['play "Single" by "Taylor Swift"']);
});

test('Alexa advances to the next candidate after a no response', async () => {
  const candidates = [
    { id: 'track-1', title: 'Single', artist: 'Taylor Swift', album: 'First album' },
    { id: 'track-2', title: 'Single', artist: 'Taylor Swift', album: 'Second album' },
  ];
  const skill = createAlexaSkill({ ...runtime, previewRequest: async () => candidates });
  const questionResult = await skill.invoke(intent('RequestSongIntent', {
    requestText: { name: 'requestText', value: 'request single by Taylor Swift' },
  }));
  const no = (await skill.invoke(intent('AMAZON.NoIntent', {}, questionResult.sessionAttributes))).response as any;
  assert.match(no.outputSpeech.ssml, /I found Single by Taylor Swift/);
  assert.equal(no.shouldEndSession, false);
});

test('Alexa reports the latest request phase for the current account', async () => {
  const response = await createAlexaSkill({
    ...runtime,
    latestRequestStatus: async identity => {
      assert.equal(typeof identity, 'string');
      return {
        status: 'pending',
        success: false,
        requestId: 'request-2',
        phase: 'queued',
        track: { title: 'Around the World', artist: 'Daft Punk' },
      };
    },
  }).invoke(intent('RequestStatusIntent'));
  const body = response.response as any;

  assert.equal(body.outputSpeech.ssml, '<speak>Your latest request for Around the World is queued.</speak>');
  assert.equal(body.shouldEndSession, true);
});

test('Alexa reports ETA and supports request cancellation and replacement', async () => {
  const status = {
    status: 'pending' as const,
    success: false,
    requestId: 'request-eta',
    phase: 'queued' as const,
    queuePosition: 2,
    etaSeconds: 180,
    track: { title: 'Around the World', artist: 'Daft Punk' },
  };
  const queued = (await createAlexaSkill({
    ...runtime,
    latestRequestStatus: async () => status,
  }).invoke(intent('RequestStatusIntent'))).response as any;
  assert.match(queued.outputSpeech.ssml, /position 2/);
  assert.match(queued.outputSpeech.ssml, /about 3 minutes/);

  const cancelled = (await createAlexaSkill({
    ...runtime,
    cancelRequest: async () => ({ ...status, status: 'cancelled', success: false, phase: 'cancelled' }),
  }).invoke(intent('CancelRequestIntent'))).response as any;
  assert.match(cancelled.outputSpeech.ssml, /cancelled/);

  const replaced = (await createAlexaSkill({
    ...runtime,
    replaceRequest: async () => ({ accepted: true, statusCode: 202, requestId: 'request-new', status: 'pending' }),
  }).invoke(intent('ReplaceRequestIntent', { requestText: { name: 'requestText', value: 'new song' } }))).response as any;
  assert.match(replaced.outputSpeech.ssml, /replaced/);
});

test('Alexa reports the current track and the next queued track', async () => {
  const current = await createAlexaSkill({
    ...runtime,
    nowPlaying: async () => ({ title: 'Current Song', artist: 'Current Artist' }),
  }).invoke(intent('NowPlayingIntent'));
  const upcoming = await createAlexaSkill({
    ...runtime,
    upcoming: async () => [{ title: 'Next Song', artist: 'Next Artist' }],
  }).invoke(intent('UpcomingIntent'));

  assert.equal(
    (current.response as any).outputSpeech.ssml,
    '<speak>Currently playing Current Song by Current Artist.</speak>',
  );
  assert.equal(
    (upcoming.response as any).outputSpeech.ssml,
    '<speak>The next song is Next Song by Next Artist.</speak>',
  );
});

test('Alexa gives a useful answer when no current or upcoming track is available', async () => {
  const current = await createAlexaSkill({
    ...runtime,
    nowPlaying: async () => null,
  }).invoke(intent('NowPlayingIntent'));
  const upcoming = await createAlexaSkill({
    ...runtime,
    upcoming: async () => [],
  }).invoke(intent('UpcomingIntent'));

  assert.equal((current.response as any).outputSpeech.ssml, '<speak>Nothing is playing right now.</speak>');
  assert.equal((upcoming.response as any).outputSpeech.ssml, '<speak>There is no song queued next.</speak>');
});

test('Alexa listener features submit a verified candidate through the shared request pipeline', async () => {
  const submitted: Array<{ text: string; candidate?: { id: string } }> = [];
  const featureRuntime = {
    ...runtime,
    listenerFeatures: new AlexaListenerFeatureService({
      nowPlaying: () => ({ id: 'current', title: 'Current Song', artist: 'Current Artist', album: null }),
      recentTracks: () => [],
      similarCandidates: () => [{ id: 'similar-1', title: 'Similar Song', artist: 'Other Artist', similarity: 0.9 }],
    }),
    submitRequest: async input => {
      submitted.push({ text: input.text, candidate: input.verifiedCandidate });
      return { accepted: true as const, statusCode: 202 as const, requestId: 'feature-request', status: 'pending' as const };
    },
  };

  const response = await createAlexaSkill(featureRuntime).invoke(intent('MoreLikeThisIntent'));
  assert.match((response.response as any).outputSpeech.ssml, /More like Similar Song by Other Artist is on the way/);
  assert.deepEqual(submitted, [{
    text: 'play "Similar Song" by "Other Artist"',
    candidate: { id: 'similar-1', title: 'Similar Song', artist: 'Other Artist', album: null },
  }]);
});

test('the shared request resolver rejects a generated candidate substitution', () => {
  const candidate = { id: 'expected', title: 'Expected', artist: 'Artist' };
  assert.equal(verifiedCandidateMatches({ id: 'expected' }, candidate), true);
  assert.equal(verifiedCandidateMatches({ id: 'different' }, candidate), false);
  assert.equal(verifiedCandidateMatches(null, candidate), false);
  assert.equal(verifiedCandidateMatches({ id: 'different' }, undefined), true);
});

test('Alexa reports no current track for generated listener selections', async () => {
  const featureRuntime = {
    ...runtime,
    listenerFeatures: new AlexaListenerFeatureService({ nowPlaying: () => null }),
  };
  const response = await createAlexaSkill(featureRuntime).invoke(intent('AnotherByArtistIntent'));
  assert.equal((response.response as any).outputSpeech.ssml, '<speak>Nothing is playing right now.</speak>');
});

test('Alexa lists recent tracks in order and reports an inactive show without inventing one', async () => {
  const featureRuntime = {
    ...runtime,
    listenerFeatures: new AlexaListenerFeatureService({
      recentTracks: () => [
        { id: 'recent-1', title: 'First', artist: 'Artist One', album: null },
        { id: 'recent-2', title: 'Second', artist: 'Artist Two', album: null },
      ],
      currentShow: () => ({ name: null, dj: 'DJ Name', guests: [] }),
    }),
  };
  const recent = await createAlexaSkill(featureRuntime).invoke(intent('RecentTracksIntent'));
  assert.match((recent.response as any).outputSpeech.ssml, /First by Artist One, Second by Artist Two/);

  const show = await createAlexaSkill(featureRuntime).invoke(intent('CurrentShowIntent'));
  assert.match((show.response as any).outputSpeech.ssml, /no scheduled show/);
  assert.match((show.response as any).outputSpeech.ssml, /DJ Name/);
});

test('TrackDetailsIntent supports all detail slots in all supported locales and keeps missing values unavailable', async () => {
  const featureRuntime = {
    ...runtime,
    listenerFeatures: new AlexaListenerFeatureService({
      nowPlaying: () => ({ id: 'details', title: 'Details Song', artist: 'Details Artist', album: null }),
      trackMetadata: () => ({ genre: 'Jazz' }),
    }),
  };
  for (const locale of ['en-IN', 'en-US', 'hi-IN']) {
    for (const detailType of ['album', 'artist', 'year', 'genre', 'language', 'all']) {
      const response = await createAlexaSkill(featureRuntime).invoke(intent('TrackDetailsIntent', {
        detailType: { name: 'detailType', value: detailType },
      }, {}, locale));
      const speech = (response.response as any).outputSpeech.ssml as string;
      assert.match(speech, /Details Song/);
      assert.doesNotMatch(speech, /undefined|null/);
    }
  }
  const missing = await createAlexaSkill(featureRuntime).invoke(intent('TrackDetailsIntent', {
    detailType: { name: 'detailType', value: 'all' },
  }, {}, 'en-US'));
  assert.match((missing.response as any).outputSpeech.ssml, /unavailable/);
});

test('Alexa rejects a skill request with the wrong configured skill id', async () => {
  await assert.rejects(
    createAlexaSkill(runtime).invoke(envelope({
      type: 'LaunchRequest',
      requestId: 'EdwRequestId.wrong-skill',
      timestamp: '2026-10-21T12:00:00Z',
      locale: 'en-IN',
    }, 'amzn1.ask.skill.wrong') as any),
    /skill ID/i,
  );
});

test('the Express endpoint keeps Alexa request bytes ahead of the global JSON parser', async () => {
  const express = (await import('express')).default;
  const app = express();
  app.use(router);
  app.use(express.json());
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  server.unref();

  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const response = await fetch(`http://127.0.0.1:${address.port}/alexa`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(launch()),
    });
    const body = await response.text();

    assert.equal(response.status, 400);
    assert.match(body, /Request verification failed/i);
    assert.doesNotMatch(body, /Do not register any parsers before using the adapter/i);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('the connection test parses an unsaved enabled draft before the global JSON parser', async () => {
  const express = (await import('express')).default;
  const app = express();
  app.use(router);
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  server.unref();

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => init?.method === 'POST'
    ? new Response('Request verification failed', { status: 400 })
    : new Response('', { status: 200, headers: { 'content-type': 'audio/mpeg' } });

  try {
    await settings.update({ alexa: { enabled: false, skillId } });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const auth: Record<string, string> = process.env.ADMIN_USER && process.env.ADMIN_PASS
      ? { authorization: `Basic ${Buffer.from(`${process.env.ADMIN_USER}:${process.env.ADMIN_PASS}`).toString('base64')}` }
      : {};
    const response = await originalFetch(`http://127.0.0.1:${address.port}/alexa/connection/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({ enabled: true, skillId, streamMount: '/stream.mp3', tokenTtlHours: 24 }),
    });
    const body = await response.json() as { checks: Array<{ id: string; message: string }> };
    const skillCheck = body.checks.find(check => check.id === 'skill');

    assert.equal(response.status, 200);
    assert.match(skillCheck?.message || '', /enabled and has a valid Skill ID/i);
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('Alexa connection test accepts a reachable unsigned webhook probe', async () => {
  const calls: string[] = [];
  let webhookBody: any = null;
  const result = await testAlexaConnection({
    ...runtime,
    getSettings: () => ({ ...runtime.getSettings(), listenerAuth: false }),
  }, async (input, init) => {
    const url = String(input);
    calls.push(url);
    if (init?.method === 'POST') {
      webhookBody = JSON.parse(String(init.body));
      return new Response('Request verification failed', { status: 400 });
    }
    return new Response('', { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.checks.map(check => check.id), [
    'site-url', 'skill', 'listener-access', 'stream', 'webhook',
  ]);
  assert.deepEqual(calls, [
    'https://radio.example/stream.mp3',
    'https://radio.example/api/alexa',
  ]);
  assert.equal(webhookBody?.session.application.applicationId, skillId);
});

test('Alexa connection test probes a signed URL for a protected listener stream', async () => {
  const calls: string[] = [];
  const result = await testAlexaConnection({
    ...runtime,
    getSettings: () => ({
      ...runtime.getSettings(),
      listenerAuth: true,
      listenerPassword: 'private-test-password',
      tokenTtlSeconds: 3600,
    }),
  }, async (input, init) => {
    const url = String(input);
    calls.push(url);
    if (init?.method === 'POST') return new Response('Request verification failed', { status: 400 });
    const parsed = new URL(url);
    assert.equal(parsed.pathname, '/stream.mp3');
    assert.match(parsed.searchParams.get('auth') || '', /^alexa1\./);
    return new Response('', { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  });

  assert.equal(result.ok, true);
  assert.equal(result.checks.find(check => check.id === 'listener-access')?.message.includes('signed'), true);
  assert.equal(calls[0].startsWith('https://radio.example/stream.mp3?auth='), true);
});

test('Alexa connection test defers the first webhook probe until the skill is saved', async () => {
  const calls: string[] = [];
  const result = await testAlexaConnection({
    ...runtime,
    getSettings: () => ({ ...runtime.getSettings(), enabled: false, skillId: '' }),
  }, async (input) => {
    calls.push(String(input));
    return new Response('', { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  }, {
    enabled: true,
    skillId,
    streamMount: '/stream.mp3',
    tokenTtlHours: 24,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['https://radio.example/stream.mp3']);
  assert.match(result.checks.find(check => check.id === 'webhook')?.message || '', /saved/i);
});

test('Alexa connection test validates the unsaved draft instead of saved settings', async () => {
  let webhookBody: any = null;
  const result = await testAlexaConnection({
    ...runtime,
    getSettings: () => ({ ...runtime.getSettings(), skillId: 'amzn1.ask.skill.11111111-1111-4111-8111-111111111111' }),
  }, async (input, init) => {
    if (init?.method === 'POST') webhookBody = JSON.parse(String(init.body));
    return String(input).endsWith('/stream.opus')
      ? new Response('', { status: 200, headers: { 'content-type': 'audio/ogg' } })
      : new Response('Request verification failed', { status: 400 });
  }, {
    enabled: true,
    skillId: 'amzn1.ask.skill.22222222-2222-4222-8222-222222222222',
    streamMount: '/stream.opus',
    tokenTtlHours: 24,
  });

  assert.equal(result.ok, true);
  assert.equal(webhookBody?.session.application.applicationId, 'amzn1.ask.skill.22222222-2222-4222-8222-222222222222');
});

test('Alexa connection test accepts Ogg content types for Opus and FLAC streams', async () => {
  for (const streamMount of ['/stream.opus', '/stream.flac']) {
    const result = await testAlexaConnection(runtime, async (input, init) => {
      if (init?.method === 'POST') return new Response('Request verification failed', { status: 400 });
      assert.equal(String(input), `https://radio.example${streamMount}`);
      return new Response('', { status: 200, headers: { 'content-type': 'application/ogg' } });
    }, {
      enabled: true,
      skillId,
      streamMount,
      tokenTtlHours: 24,
    });

    assert.equal(result.checks.find(check => check.id === 'stream')?.ok, true);
  }
});

test('Alexa connection test rejects a malformed draft Skill ID', async () => {
  const result = await testAlexaConnection(runtime, async (_input, init) => {
    if (init?.method === 'POST') return new Response('Request verification failed', { status: 400 });
    return new Response('', { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  }, {
    enabled: true,
    skillId: 'wrong-skill-id',
    streamMount: '/stream.mp3',
    tokenTtlHours: 24,
  });

  assert.equal(result.ok, false);
  assert.equal(result.checks.find(check => check.id === 'skill')?.ok, false);
});

test('Alexa stream mount validation accepts every exposed format', () => {
  for (const streamMount of ['/stream.mp3', '/stream.opus', '/stream.flac', '/stream.aac']) {
    assert.deepEqual(alexaPatchSchema.parse({ streamMount }), { streamMount });
  }
});
