import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TtsSection } from '../components/admin/settings/TtsSection';
import { settingsForm } from '../components/admin/settings/form-state';

test('the voice levelling control names and describes its saved choice', () => {
  const client = new QueryClient();
  try {
    for (const voiceLevelling of [false, true]) {
      const values = { tts: { defaultEngine: 'piper', voiceLevelling } };
      const html = renderToStaticMarkup(
        <QueryClientProvider client={client}>
          <TtsSection
            data={{ values }}
            form={settingsForm(values)}
            setForm={() => {}}
            busy={false}
            saveSettings={async () => true}
            adminFetch={async () => { throw new Error('rendering must not fetch'); }}
            refresh={async () => {}}
            fieldErrors={{}}
          />
        </QueryClientProvider>,
      );
      assert.match(html, /id="tts-voice-levelling-label">Voice levelling/);
      assert.match(html, /id="tts-voice-levelling-description"[^>]*>Lifts quiet takes and cuts loud ones toward -18 LUFS\./);
      const group = /<div[^>]*aria-labelledby="tts-voice-levelling-label"[^>]*>([\s\S]*?)<\/div>/.exec(html);
      assert.ok(group, 'the control must have an accessible name');
      assert.match(group[0], /aria-describedby="tts-voice-levelling-description"/);
      assert.match(group[1] || '', new RegExp(`aria-checked="true"[^>]*>${voiceLevelling ? 'On' : 'Off'}<`));
    }
  } finally {
    client.clear();
  }
});
