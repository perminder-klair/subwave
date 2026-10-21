import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'subwave-alexa-'));
process.env.SITE_URL = 'https://radio.example';

const { DEFAULTS } = await import('../src/settings/defaults.js');
const { alexaPatchSchema } = await import('../src/schemas/settings.js');
const { verifyAlexaStreamToken } = await import('../src/alexa/token.js');
const { createAlexaSkill, router, testAlexaConnection } = await import('../src/routes/alexa.js');
const settings = await import('../src/settings.js');

const skillId = 'amzn1.ask.skill.4e261dd3-03ee-4139-8e6c-8d89d7f09355';

function envelope(
  request: Record<string, unknown>,
  applicationId = skillId,
): Record<string, unknown> {
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
        device: { supportedInterfaces: { AudioPlayer: {} } },
        apiEndpoint: 'https://api.amazonalexa.com',
      },
    },
    request,
  };
}

function launch() {
  return envelope({
    type: 'LaunchRequest',
    requestId: 'EdwRequestId.launch',
    timestamp: '2026-10-21T12:00:00Z',
    locale: 'en-IN',
  });
}

function intent(name: string) {
  return envelope({
    type: 'IntentRequest',
    requestId: `EdwRequestId.${name}`,
    timestamp: '2026-10-21T12:00:00Z',
    locale: 'en-IN',
    intent: { name, confirmationStatus: 'NONE', slots: {} },
  });
}

const runtime = {
  getSettings: () => ({
    enabled: true,
    skillId,
    station: 'CHILL ZONE',
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

  assert.equal(body.outputSpeech.ssml, '<speak>Starting CHILL ZONE.</speak>');
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
    },
  }]);
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
  assert.equal(resume.outputSpeech.ssml, '<speak>Resuming CHILL ZONE.</speak>');
  assert.equal(resume.directives[0].audioItem.stream.offsetInMilliseconds, 0);
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
    const auth = process.env.ADMIN_USER && process.env.ADMIN_PASS
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
  let webhookBody: Record<string, any> | null = null;
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
  let webhookBody: Record<string, any> | null = null;
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
