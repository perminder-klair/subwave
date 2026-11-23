import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { RequestEnvelope } from 'ask-sdk-model';

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'subwave-alexa-dedications-'));
process.env.SITE_URL = 'https://radio.example';

const { createAlexaSkill } = await import('../src/routes/alexa.js');
const { publicListenerRequestStatus } = await import('../src/routes/request.js');

const skillId = 'amzn1.ask.skill.11111111-1111-4111-8111-111111111111';

function envelope(
  request: Record<string, unknown>,
  attributes: Record<string, unknown> = {},
  consentToken?: string,
): RequestEnvelope {
  return {
    version: '1.0',
    session: {
      new: false,
      sessionId: 'SessionId.test',
      application: { applicationId: skillId },
      user: { userId: 'amzn1.ask.account.test' },
      attributes,
    },
    context: {
      System: {
        application: { applicationId: skillId },
        user: {
          userId: 'amzn1.ask.account.test',
          ...(consentToken ? { permissions: { consentToken } } : {}),
        },
        device: { supportedInterfaces: {} },
        apiEndpoint: 'https://api.amazonalexa.com',
      },
    },
    request,
  } as unknown as RequestEnvelope;
}

function intent(
  name: string,
  slots: Record<string, unknown> = {},
  attributes: Record<string, unknown> = {},
  locale = 'en-IN',
  consentToken?: string,
  extra: Record<string, unknown> = {},
) {
  return envelope({
    type: 'IntentRequest',
    requestId: `request-${name}`,
    timestamp: '2026-10-24T12:00:00Z',
    locale,
    intent: { name, confirmationStatus: 'NONE', slots },
    ...extra,
  }, attributes, consentToken);
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

test('DedicationIntent submits the song separately from the sanitized recipient', async () => {
  const submitted: any[] = [];
  const response = await createAlexaSkill({
    ...runtime,
    submitRequest: async input => {
      submitted.push(input);
      return { accepted: true as const, statusCode: 202 as const, requestId: 'dedication-1', status: 'pending' as const };
    },
  }).invoke(intent('DedicationIntent', {
    requestText: { name: 'requestText', value: 'Bohemian Rhapsody' },
    dedicationTarget: { name: 'dedicationTarget', value: 'my sister Priya' },
  }, {}, 'en-US', undefined, { dialogState: 'COMPLETED' }));

  assert.match((response.response as any).outputSpeech.ssml, /dedication was sent/);
  assert.deepEqual(submitted, [{
    text: 'Bohemian Rhapsody',
    userId: 'amzn1.ask.account.test',
    personId: undefined,
    dedication: { target: 'my sister Priya', locale: 'en-US' },
  }]);
});

test('DedicationIntent accepts self, named, and arbitrary recipients in every locale', async () => {
  for (const [locale, target] of [
    ['en-US', 'for me'],
    ['en-IN', 'myself'],
    ['hi-IN', 'मेरे दोस्त के लिए'],
  ] as const) {
    const submitted: any[] = [];
    const response = await createAlexaSkill({
      ...runtime,
      submitRequest: async input => {
        submitted.push(input);
        return { accepted: true as const, statusCode: 202 as const, requestId: `dedication-${locale}`, status: 'pending' as const };
      },
    }).invoke(intent('DedicationIntent', {
      requestText: { name: 'requestText', value: 'Sajde' },
      dedicationTarget: { name: 'dedicationTarget', value: target },
    }, {}, locale, undefined, { dialogState: 'COMPLETED' }));

    assert.ok((response.response as any).outputSpeech.ssml);
    assert.equal(submitted[0]?.dedication.target, target);
    assert.equal(submitted[0]?.dedication.locale, locale);
  }
});

test('DedicationIntent re-elicits a real song when Alexa fills a generic phrase', async () => {
  const submitted: any[] = [];
  const response = await createAlexaSkill({
    ...runtime,
    submitRequest: async input => {
      submitted.push(input);
      return { accepted: true as const, statusCode: 202 as const, requestId: 'dedication-generic', status: 'pending' as const };
    },
  }).invoke(intent('DedicationIntent', {
    requestText: { name: 'requestText', value: 'a song' },
    dedicationTarget: { name: 'dedicationTarget', value: 'Priya and the family' },
  }, {}, 'en-US', undefined, { dialogState: 'COMPLETED' }));

  assert.equal(submitted.length, 0);
  assert.match((response.response as any).outputSpeech.ssml, /Tell me the song/);
  assert.deepEqual((response.response as any).directives, [{
    type: 'Dialog.ElicitSlot',
    slotToElicit: 'requestText',
  }]);
  assert.equal((response.response as any).shouldEndSession, false);
});

test('DedicationIntent re-elicits a generic song even during an incomplete dialog', async () => {
  const response = await createAlexaSkill(runtime).invoke(intent('DedicationIntent', {
    requestText: { name: 'requestText', value: 'a song' },
    dedicationTarget: { name: 'dedicationTarget', value: 'Priya' },
  }, {}, 'en-US', undefined, { dialogState: 'IN_PROGRESS' }));

  assert.match((response.response as any).outputSpeech.ssml, /Tell me the song/);
  assert.deepEqual((response.response as any).directives, [{
    type: 'Dialog.ElicitSlot',
    slotToElicit: 'requestText',
  }]);
});

test('DedicationIntent re-elicits every generic model phrase instead of submitting it', async () => {
  for (const requestText of ['this song', 'a song for someone', 'इस गाने को dedicate करो']) {
    const submitted: any[] = [];
    const response = await createAlexaSkill({
      ...runtime,
      submitRequest: async input => {
        submitted.push(input);
        return { accepted: true as const, statusCode: 202 as const, requestId: 'dedication-generic-model', status: 'pending' as const };
      },
    }).invoke(intent('DedicationIntent', {
      requestText: { name: 'requestText', value: requestText },
      dedicationTarget: { name: 'dedicationTarget', value: 'Priya' },
    }, {}, 'en-US', undefined, { dialogState: 'COMPLETED' }));

    assert.equal(submitted.length, 0, requestText);
    assert.match((response.response as any).outputSpeech.ssml, /Tell me the song/, requestText);
  }
});

test('DedicationIntent delegates incomplete two-turn collection to Alexa dialog', async () => {
  const response = await createAlexaSkill(runtime).invoke(intent('DedicationIntent', {
    requestText: { name: 'requestText', value: 'Bohemian Rhapsody' },
  }, {}, 'en-IN', undefined, { dialogState: 'IN_PROGRESS' }));
  assert.deepEqual((response.response as any).directives, [{ type: 'Dialog.Delegate' }]);
});

test('RequestReminderIntent asks for confirmation and creates a one-minute-before reminder', async () => {
  const saved: any[] = [];
  const created: any[] = [];
  const status = {
    status: 'resolved' as const,
    success: true,
    requestId: 'request-1',
    phase: 'queued' as const,
    track: { title: 'Around the World', artist: 'Daft Punk' },
    queuePosition: 2,
    etaSeconds: 300,
  };
  const fakeReminder = {
    create: async (request: any) => {
      created.push(request);
      return { alertToken: 'alert-token-1' };
    },
    get: async () => ({ alertToken: 'alert-token-1' }),
    delete: async () => undefined,
  };
  const skill = createAlexaSkill({
    ...runtime,
    latestRequestStatus: async () => status,
    requestStatus: async () => status,
    reminderClient: fakeReminder,
    saveReminder: async (_identity, requestId, reminder) => {
      saved.push({ requestId, reminder });
      return { ...status, reminder };
    },
  });

  const question = await skill.invoke(intent('RequestReminderIntent'));
  assert.match((question.response as any).outputSpeech.ssml, /Should I remind you/);
  assert.equal((question.response as any).shouldEndSession, false);

  const yes = await skill.invoke(intent('AMAZON.YesIntent', {}, question.sessionAttributes, 'en-IN', 'consent-token'));
  assert.equal((yes.response as any).directives[0].type, 'Connections.SendRequest');
  const confirmation = await skill.invoke(intent(
    'Connections.Response',
    {},
    yes.sessionAttributes,
    'en-IN',
    undefined,
    {
      type: 'Connections.Response',
      name: 'AskFor',
      token: (yes.response as any).directives[0].token,
      payload: {
        permissionScopes: [{
          permissionScope: 'alexa::alerts:reminders:skill:readwrite',
          consentLevel: 'ACCOUNT',
        }],
        status: 'ACCEPTED',
      },
    },
  ));
  assert.match((confirmation.response as any).outputSpeech.ssml, /remind you one minute before/);
  assert.equal(created[0].trigger.offsetInSeconds, 240);
  assert.equal(created[0].pushNotification.status, 'DISABLED');
  assert.equal(saved[0].requestId, 'request-1');
  assert.equal(saved[0].reminder.alertToken, 'alert-token-1');
});

test('existing global reminder consent still requests per-reminder confirmation', async () => {
  const created: any[] = [];
  const status = {
    status: 'resolved' as const,
    success: true,
    requestId: 'request-global-consent',
    phase: 'queued' as const,
    track: { title: 'Bandook', artist: 'Fixture Artist' },
    etaSeconds: 180,
  };
  const question = await createAlexaSkill({
    ...runtime,
    latestRequestStatus: async () => status,
    reminderClient: {
      create: async () => {
        created.push(true);
        return { alertToken: 'alert-token-global-consent' };
      },
      get: async () => ({ alertToken: 'alert-token-global-consent' }),
      delete: async () => undefined,
    },
  }).invoke(intent('RequestReminderIntent'));

  const response = await createAlexaSkill({
    ...runtime,
    reminderClient: {
      create: async () => {
        created.push(true);
        return { alertToken: 'alert-token-global-consent' };
      },
      get: async () => ({ alertToken: 'alert-token-global-consent' }),
      delete: async () => undefined,
    },
  }).invoke(intent('AMAZON.YesIntent', {}, question.sessionAttributes, 'en-US', 'global-consent-token'));

  assert.equal(created.length, 0);
  assert.equal((response.response as any).directives[0].type, 'Connections.SendRequest');
});

test('RequestReminderIntent starts the Alexa permission workflow without a consent token', async () => {
  const status = {
    status: 'resolved' as const,
    success: true,
    requestId: 'request-2',
    phase: 'queued' as const,
    track: { title: 'One More Time', artist: 'Daft Punk' },
    etaSeconds: 180,
  };
  const skill = createAlexaSkill({
    ...runtime,
    latestRequestStatus: async () => status,
    requestStatus: async () => status,
  });
  const question = await skill.invoke(intent('RequestReminderIntent'));
  const response = await skill.invoke(intent('AMAZON.YesIntent', {}, question.sessionAttributes));
  assert.equal((response.response as any).directives[0].type, 'Connections.SendRequest');
  assert.equal((response.response as any).directives[0].payload.permissionScopes[0].permissionScope, 'alexa::alerts:reminders:skill:readwrite');
  assert.equal((response.response as any).shouldEndSession, true);
});

test('reminder permission response restores durable consent after Alexa ends the session', async () => {
  const created: any[] = [];
  const pendingConsent = new Map<string, any>();
  const status = {
    status: 'resolved' as const,
    success: true,
    requestId: 'request-session-ended',
    phase: 'queued' as const,
    track: { title: 'Patient Zero', artist: 'Fixture Artist' },
    etaSeconds: 300,
  };
  const skill = createAlexaSkill({
    ...runtime,
    latestRequestStatus: async () => status,
    requestStatus: async () => status,
    reminderClient: {
      create: async () => {
        created.push(true);
        return { alertToken: 'alert-token-session-ended' };
      },
      get: async () => ({ alertToken: 'alert-token-session-ended' }),
      delete: async () => undefined,
    },
    saveReminderConsent: async (identity, requestId, consent) => {
      pendingConsent.set(consent.permissionToken, {
        requestId,
        identity,
        locale: consent.locale,
        permissionToken: consent.permissionToken,
      });
      return true;
    },
    findReminderConsent: async (identity, permissionToken) => {
      const consent = pendingConsent.get(permissionToken);
      return consent?.identity === identity ? consent : null;
    },
    clearReminderConsent: async (identity, requestId) => {
      for (const [token, consent] of pendingConsent) {
        if (consent.identity === identity && consent.requestId === requestId) pendingConsent.delete(token);
      }
      return true;
    },
    saveReminder: async (_identity, requestId, reminder) => ({ ...status, requestId, reminder }),
  });

  const question = await skill.invoke(intent('RequestReminderIntent'));
  const yes = await skill.invoke(intent('AMAZON.YesIntent', {}, question.sessionAttributes, 'en-US'));
  const accepted = await skill.invoke(intent(
    'Connections.Response',
    {},
    {},
    'en-US',
    undefined,
    {
      type: 'Connections.Response',
      name: 'AskFor',
      token: 'request-reminder:request-session-ended',
      payload: {
        permissionScopes: [{
          permissionScope: 'alexa::alerts:reminders:skill:readwrite',
          consentLevel: 'ACCOUNT',
        }],
        status: 'ACCEPTED',
      },
    },
  ));

  assert.equal((yes.response as any).shouldEndSession, true);
  assert.equal(created.length, 1);
  assert.match((accepted.response as any).outputSpeech.ssml, /remind you one minute before/);
  assert.equal(pendingConsent.size, 0);
});

test('reminder permission responses are correlated and can survive a not-answered retry', async () => {
  const created: any[] = [];
  const status = {
    status: 'resolved' as const,
    success: true,
    requestId: 'request-4',
    phase: 'queued' as const,
    track: { title: 'Digital Love', artist: 'Daft Punk' },
    etaSeconds: 240,
  };
  const skill = createAlexaSkill({
    ...runtime,
    latestRequestStatus: async () => status,
    requestStatus: async () => status,
    reminderClient: {
      create: async () => {
        created.push(true);
        return { alertToken: 'alert-token-4' };
      },
      get: async () => ({ alertToken: 'alert-token-4' }),
      delete: async () => undefined,
    },
    saveReminder: async (_identity, requestId, reminder) => ({ ...status, requestId, reminder }),
  });

  const question = await skill.invoke(intent('RequestReminderIntent'));
  const yes = await skill.invoke(intent(
    'AMAZON.YesIntent',
    {},
    question.sessionAttributes,
    'en-US',
  ));
  const permission = await skill.invoke(intent(
    'Connections.Response',
    {},
    yes.sessionAttributes,
    'en-US',
    undefined,
    {
      type: 'Connections.Response',
      name: 'AskFor',
      token: 'request-reminder:request-4',
      payload: {
        permissionScopes: [{
          permissionScope: 'alexa::alerts:reminders:skill:readwrite',
          consentLevel: 'ACCOUNT',
        }],
        status: 'NOT_ANSWERED',
      },
    },
  ));
  assert.equal(created.length, 0);
  assert.equal((permission.sessionAttributes as any).alexaReminderPending.requestId, 'request-4');

  const accepted = await skill.invoke(intent(
    'Connections.Response',
    {},
    permission.sessionAttributes,
    'en-US',
    undefined,
    {
      type: 'Connections.Response',
      name: 'AskFor',
      token: 'request-reminder:request-4',
      payload: {
        permissionScopes: [{
          permissionScope: 'alexa::alerts:reminders:skill:readwrite',
          consentLevel: 'ACCOUNT',
        }],
        status: 'ACCEPTED',
      },
    },
  ));
  assert.equal(created.length, 1);
  assert.match((accepted.response as any).outputSpeech.ssml, /remind you one minute before/);
});

test('Alexa documented permission response shape creates the reminder after acceptance', async () => {
  const created: any[] = [];
  const status = {
    status: 'resolved' as const,
    success: true,
    requestId: 'request-docs-shape',
    phase: 'queued' as const,
    track: { title: 'Daku', artist: 'Fixture Artist' },
    etaSeconds: 660,
  };
  const skill = createAlexaSkill({
    ...runtime,
    latestRequestStatus: async () => status,
    requestStatus: async () => status,
    reminderClient: {
      create: async () => {
        created.push(true);
        return { alertToken: 'alert-token-docs-shape' };
      },
      get: async () => ({ alertToken: 'alert-token-docs-shape' }),
      delete: async () => undefined,
    },
    saveReminder: async (_identity, requestId, reminder) => ({ ...status, requestId, reminder }),
  });

  const question = await skill.invoke(intent('RequestReminderIntent'));
  const yes = await skill.invoke(intent('AMAZON.YesIntent', {}, question.sessionAttributes, 'en-US'));
  const accepted = await skill.invoke(intent(
    'Connections.Response',
    {},
    yes.sessionAttributes,
    'en-US',
    undefined,
    {
      type: 'Connections.Response',
      name: 'AskFor',
      token: 'request-reminder:request-docs-shape',
      payload: {
        permissionScopes: [{
          permissionScope: 'alexa::alerts:reminders:skill:readwrite',
          consentLevel: 'ACCOUNT',
        }],
        status: 'ACCEPTED',
      },
    },
  ));

  assert.equal(created.length, 1);
  assert.match((accepted.response as any).outputSpeech.ssml, /remind you one minute before/);
});

test('reminder permission responses with the wrong correlation token do not create a reminder', async () => {
  const created: any[] = [];
  const status = {
    status: 'resolved' as const,
    success: true,
    requestId: 'request-5',
    phase: 'queued' as const,
    track: { title: 'Harder Better Faster Stronger', artist: 'Daft Punk' },
    etaSeconds: 240,
  };
  const question = await createAlexaSkill({
    ...runtime,
    latestRequestStatus: async () => status,
    reminderClient: {
      create: async () => {
        created.push(true);
        return { alertToken: 'alert-token-5' };
      },
      get: async () => ({ alertToken: 'alert-token-5' }),
      delete: async () => undefined,
    },
  }).invoke(intent('RequestReminderIntent'));
  const response = await createAlexaSkill({
    ...runtime,
    reminderClient: {
      create: async () => {
        created.push(true);
        return { alertToken: 'alert-token-5' };
      },
      get: async () => ({ alertToken: 'alert-token-5' }),
      delete: async () => undefined,
    },
  }).invoke(intent(
    'Connections.Response',
    {},
    question.sessionAttributes,
    'en-US',
    undefined,
    {
      type: 'Connections.Response',
      name: 'AskFor',
      token: 'request-reminder:wrong-request',
      payload: {
        permissionScopes: [{
          permissionScope: 'alexa::alerts:reminders:skill:readwrite',
          consentLevel: 'ACCOUNT',
        }],
        status: 'ACCEPTED',
      },
    },
  ));
  assert.equal(created.length, 0);
  assert.match((response.response as any).outputSpeech.ssml, /fresh estimate|अनुमान/);
});

test('RequestReminderIntent refuses unknown or out-of-window estimates', async () => {
  const response = await createAlexaSkill({
    ...runtime,
    latestRequestStatus: async () => ({
      status: 'resolved' as const,
      success: true,
      requestId: 'request-3',
      phase: 'queued' as const,
      track: { title: 'Song', artist: 'Artist' },
      etaSeconds: 119,
    }),
  }).invoke(intent('RequestReminderIntent', {}, {}, 'hi-IN'));
  assert.match((response.response as any).outputSpeech.ssml, /भरोसेमंद अनुमान/);
});

test('public request status omits the external Alexa reminder token', () => {
  const status = publicListenerRequestStatus({
    status: 'resolved',
    success: true,
    requestId: 'request-public',
    phase: 'queued',
    reminder: {
      alertToken: 'secret-alert-token',
      createdAt: 1,
      triggerAt: 2,
      forecastSeconds: 180,
      leadSeconds: 60,
    },
  });
  assert.deepEqual(status.reminder, {
    createdAt: 1,
    triggerAt: 2,
    forecastSeconds: 180,
    leadSeconds: 60,
  });
  assert.equal('alertToken' in (status.reminder || {}), false);
});
