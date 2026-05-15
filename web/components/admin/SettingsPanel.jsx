'use client';

import { useEffect, useState } from 'react';
import { V3Switch } from '../ui/switch';
import { fmtSize } from '../../lib/format';
import { useAdminAuth } from '../../lib/adminAuth';

const FREQUENCIES = ['quiet', 'moderate', 'aggressive'];
const FREQUENCY_HINTS = {
  quiet:      'Quiet — talks every 8-20 tracks · station ID once an hour · weather hourly on change.',
  moderate:   'Moderate — talks every 1-9 tracks · station IDs at :15 and :45 · weather every 30 min on change.',
  aggressive: 'Aggressive — talks every 1-3 tracks · station IDs four times an hour · weather every 15 min on change.',
};

const TTS_KIND_LABEL = {
  'dj-speak':     'Track intros',
  'link':         'Between-track links',
  'station-id':   'Station IDs',
  'hourly-check': 'Hourly check-ins',
  'weather':      'Weather updates',
  'news':         'News headlines',
  'traffic':     'Traffic filler',
  'random-facts': 'Random facts',
  'jingle':       'Jingle rendering',
};
const TTS_KIND_HINT = {
  'dj-speak':     'Played before a listener-requested track.',
  'link':         'Short talkover links between back-to-back auto tracks.',
  'station-id':   'Identification at :15 and :45 (frequency-dependent).',
  'hourly-check': 'Top-of-hour time/weather mention.',
  'weather':      'Fired when conditions change since the last announcement.',
  'news':         'One headline from the configured RSS feed, read in DJ tone.',
  'traffic':      'Tongue-in-cheek made-up traffic — only during commute hours.',
  'random-facts': 'A one-liner "did you know" between tracks.',
  'jingle':       'Engine used when you create a new jingle from text in the Jingles section.',
};

export default function SettingsPanel() {
  const { adminFetch, needsAuth } = useAdminAuth();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [jingleText, setJingleText] = useState('');
  const [taggerLimit, setTaggerLimit] = useState('50');
  const [form, setForm] = useState(null);
  const [pendingRestart, setPendingRestart] = useState(false);
  const [saveMsg, setSaveMsg] = useState(null);

  // Refresh only updates the read-only `data` view — never touches `form`.
  // The form is hydrated exactly once via the effect below; otherwise the 3s
  // poll's stale closure would clobber unsaved edits every tick.
  const refresh = async () => {
    try {
      const r = await adminFetch('/settings');
      if (!r.ok) return;
      const j = await r.json();
      setData(j); setErr(null);
    } catch (e) { setErr(e.message); }
  };

  useEffect(() => {
    if (!data?.values || form) return;
    setForm({
      jingleRatio: String(data.values.jingleRatio),
      crossfadeDuration: String(data.values.crossfadeDuration),
      weather: {
        ...data.values.weather,
        lat: String(data.values.weather.lat),
        lng: String(data.values.weather.lng),
      },
      dj: {
        name: data.values.dj?.name ?? '',
        soulsText: Array.isArray(data.values.dj?.souls)
          ? data.values.dj.souls.join('\n')
          : (data.values.dj?.soul ?? ''),
        systemPrompt: data.values.dj?.systemPrompt ?? '',
        frequency: data.values.dj?.frequency ?? 'moderate',
      },
      tts: {
        defaultEngine: data.values.tts?.defaultEngine ?? 'piper',
        byKind: { ...(data.values.tts?.byKind || {}) },
        kokoro: { voice: data.values.tts?.kokoro?.voice ?? 'bf_isabella' },
        cloud: {
          provider: data.values.tts?.cloud?.provider ?? 'openai',
          model: data.values.tts?.cloud?.model ?? '',
          voice: data.values.tts?.cloud?.voice ?? '',
          apiKey: '',                                            // never prefill a secret
          apiKeySet: data.values.tts?.cloud?.apiKey === 'set',
        },
      },
      llm: {
        provider: data.values.llm?.provider ?? 'ollama',
        model: data.values.llm?.model ?? '',
        apiKey: '',                                              // never prefill a secret
        apiKeySet: data.values.llm?.apiKey === 'set',
        pickerAgent: !!data.values.llm?.pickerAgent,
      },
    });
  }, [data, form]);

  useEffect(() => {
    if (needsAuth) return;
    refresh();
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsAuth]);

  const saveSettings = async (patch) => {
    setBusy(true); setSaveMsg(null);
    try {
      const r = await adminFetch('/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      if (j.requiresRestart) setPendingRestart(true);
      setSaveMsg({ tone: 'ok', text: j.requiresRestart ? 'saved — restart the mixer to apply' : 'saved' });
      await refresh();
    } catch (e) {
      setSaveMsg({ tone: 'err', text: e.message });
    } finally { setBusy(false); }
  };

  const restartMixer = async () => {
    if (!confirm('Restart the mixer? Broadcast will drop for ~3-5 seconds.')) return;
    setBusy(true);
    try {
      const r = await adminFetch('/restart-mixer', { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      setPendingRestart(false);
      setSaveMsg({ tone: 'ok', text: 'mixer restarting — give it a few seconds' });
    } catch (e) {
      setSaveMsg({ tone: 'err', text: e.message });
    } finally { setBusy(false); }
  };

  const createJingle = async () => {
    if (!jingleText.trim() || busy) return;
    setBusy(true);
    try {
      const r = await adminFetch('/jingles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: jingleText.trim() }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      setJingleText('');
      await refresh();
    } catch (e) { alert(`Jingle creation failed: ${e.message}`); }
    finally { setBusy(false); }
  };

  const deleteJingle = async (filename) => {
    if (!confirm(`Delete ${filename}?`)) return;
    setBusy(true);
    try {
      const r = await adminFetch(`/jingles/${encodeURIComponent(filename)}`, { method: 'DELETE' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      await refresh();
    } catch (e) { alert(`Delete failed: ${e.message}`); }
    finally { setBusy(false); }
  };

  const toggleAutoPick = async () => {
    if (!data) return;
    setBusy(true);
    try {
      await adminFetch('/auto-pick', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ on: !data.autoPick }),
      });
      await refresh();
    } finally { setBusy(false); }
  };

  const startTagger = async () => {
    setBusy(true);
    try {
      const limit = parseInt(taggerLimit, 10);
      const r = await adminFetch('/tag-library', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      await refresh();
    } catch (e) { alert(`Tagger start failed: ${e.message}`); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-7">
      {err && <Alert tone="err">controller error: {err}</Alert>}
      {!data && !err && <div style={{ color: 'var(--muted)' }} className="italic">loading…</div>}

      {data && (
        <>
          <Section title="Auto-DJ">
            <Row>
              <div>
                <Lead>LLM picks next track</Lead>
                <Hint>
                  When listener queue is empty, Ollama chooses from mood-tagged candidates
                  instead of random shuffle.
                </Hint>
              </div>
              <V3Switch checked={!!data.autoPick} onCheckedChange={toggleAutoPick} disabled={busy} />
            </Row>
            <Row>
              <div>
                <Lead>Picker status</Lead>
                <Hint>
                  {data.pickerBusy ? 'Asking Ollama for the next track…' : 'Idle — picks fire on each track change.'}
                </Hint>
              </div>
              <span
                className="v3-caption"
                style={{ color: data.pickerBusy ? 'var(--accent)' : 'var(--muted)' }}
              >
                {data.pickerBusy ? 'thinking' : 'idle'}
              </span>
            </Row>
            <Footnote>picker model: {data.llm?.active ?? `${data.ollama.model} @ ${data.ollama.url}`}</Footnote>
          </Section>

          {form && (
            <Section title="DJ persona">
              <FormRow
                label="Name"
                hint="Shown in the TopBar and referenced by the LLM as the DJ's on-air name."
              >
                <TextInput
                  value={form.dj.name}
                  onChange={e => setForm(f => ({ ...f, dj: { ...f.dj, name: e.target.value } }))}
                  maxLength={40}
                  style={{ width: 240 }}
                />
              </FormRow>

              <FormRow
                label="Talk frequency"
                hint="How often the DJ speaks between tracks and at the top of each hour. Music selection is unaffected."
              >
                <FrequencySegmented
                  value={form.dj.frequency}
                  onChange={v => setForm(f => ({ ...f, dj: { ...f.dj, frequency: v } }))}
                />
              </FormRow>
              <Footnote>
                {FREQUENCY_HINTS[form.dj.frequency]}
              </Footnote>

              <FormRow
                label="Souls"
                hint="One short personality per line. The DJ picks one at random per spoken line, so adding 3-6 distinct souls makes back-to-back segments feel different. Each line is injected into the system prompt as {soul}."
              >
                <textarea
                  rows={8}
                  value={form.dj.soulsText}
                  onChange={e => setForm(f => ({ ...f, dj: { ...f.dj, soulsText: e.target.value } }))}
                  className="w-full v3-focus"
                  style={{
                    boxSizing: 'border-box',
                    border: '1px solid var(--ink)',
                    background: 'transparent',
                    padding: 10,
                    fontSize: 13,
                    fontFamily: 'inherit',
                    color: 'var(--ink)',
                    resize: 'vertical',
                    lineHeight: 1.5,
                  }}
                />
              </FormRow>
              <div className="flex items-center gap-2 mt-1">
                <OutlineButton
                  onClick={() => setForm(f => ({
                    ...f,
                    dj: {
                      ...f.dj,
                      soulsText: Array.isArray(data.defaults?.dj?.souls)
                        ? data.defaults.dj.souls.join('\n')
                        : f.dj.soulsText,
                    },
                  }))}
                  disabled={busy || !Array.isArray(data.defaults?.dj?.souls)}
                >
                  reset to defaults
                </OutlineButton>
                <Footnote>
                  {form.dj.soulsText.split('\n').filter(l => l.trim()).length} souls · max 10 lines, 400 chars each
                </Footnote>
              </div>

              <details className="mt-3" style={{ border: '1px solid var(--ink)' }}>
                <summary
                  className="cursor-pointer v3-caption"
                  style={{ padding: '8px 12px', color: 'var(--ink)' }}
                >
                  System prompt template (advanced)
                </summary>
                <div style={{ padding: 12, borderTop: '1px solid var(--ink)' }}>
                  <Hint>
                    Placeholders: <code>{'{name}'}</code> · <code>{'{soul}'}</code> ·
                    {' '}<code>{'{station}'}</code> · <code>{'{location}'}</code>.
                    {' '}<code>{'{name}'}</code> is required.
                  </Hint>
                  <textarea
                    rows={10}
                    value={form.dj.systemPrompt}
                    onChange={e => setForm(f => ({ ...f, dj: { ...f.dj, systemPrompt: e.target.value } }))}
                    maxLength={4000}
                    className="w-full v3-focus mt-2"
                    style={{
                      boxSizing: 'border-box',
                      border: '1px solid var(--ink)',
                      background: 'transparent',
                      padding: 10,
                      fontSize: 12,
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                      color: 'var(--ink)',
                      resize: 'vertical',
                      lineHeight: 1.5,
                    }}
                  />
                  <div className="flex items-center gap-2 mt-2">
                    <OutlineButton
                      onClick={() => setForm(f => ({
                        ...f,
                        dj: { ...f.dj, systemPrompt: data.defaults?.dj?.systemPrompt || '' },
                      }))}
                      disabled={busy || !data.defaults?.dj?.systemPrompt}
                    >
                      reset to default
                    </OutlineButton>
                    <span style={{ color: 'var(--muted)', fontSize: 11 }}>
                      {form.dj.systemPrompt.length}/4000 chars
                    </span>
                  </div>
                </div>
              </details>

              <div
                className="flex flex-wrap items-center gap-3 pt-3 mt-3"
                style={{ borderTop: '1px solid var(--separator-strong)' }}
              >
                <SolidButton
                  onClick={() => saveSettings({
                    dj: {
                      name: form.dj.name.trim(),
                      souls: form.dj.soulsText
                        .split('\n')
                        .map(l => l.trim())
                        .filter(Boolean),
                      systemPrompt: form.dj.systemPrompt.trim(),
                      frequency: form.dj.frequency,
                    },
                  })}
                  disabled={busy}
                >
                  save persona
                </SolidButton>
                {saveMsg && (
                  <span style={{ fontSize: 12, color: saveMsg.tone === 'err' ? '#c5302a' : 'var(--accent)' }}>
                    {saveMsg.text}
                  </span>
                )}
              </div>
              <Footnote>
                All persona changes apply live — no mixer restart needed.
              </Footnote>
            </Section>
          )}

          {form && data.tts && (
            <Section title="TTS voice">
              <Hint>
                Pick the text-to-speech engine for each kind of spoken segment.
                <strong> Piper</strong> is fast and CPU-cheap; <strong>Kokoro</strong> is more
                natural but ~3-5× slower per line. The first Kokoro request after boot also
                pays a one-off model-load cost of a few seconds.
                {data.tts.available?.kokoro === false && (
                  <span style={{ color: '#c5302a' }}> Kokoro is unavailable in this build.</span>
                )}
              </Hint>

              <FormRow
                label="Default engine"
                hint="Used for any voice kind set to “use default” below."
              >
                <EngineSelect
                  engines={data.tts.engines || ['piper']}
                  available={data.tts.available || {}}
                  value={form.tts.defaultEngine}
                  onChange={v => setForm(f => ({ ...f, tts: { ...f.tts, defaultEngine: v } }))}
                  allowDefault={false}
                />
              </FormRow>

              {(data.tts.kokoroVoices?.length || 0) > 0 && (
                <FormRow
                  label="Kokoro voice"
                  hint="British English voices only. Applies to every kind routed through Kokoro."
                >
                  <select
                    value={form.tts.kokoro?.voice ?? 'bf_isabella'}
                    onChange={e => setForm(f => ({
                      ...f,
                      tts: { ...f.tts, kokoro: { ...f.tts.kokoro, voice: e.target.value } },
                    }))}
                    className="v3-focus"
                    style={{
                      boxSizing: 'border-box',
                      border: '1px solid var(--ink)',
                      background: 'transparent',
                      padding: '8px 12px',
                      fontSize: 13,
                      fontFamily: 'inherit',
                      color: 'var(--ink)',
                      outline: 'none',
                      minWidth: 240,
                    }}
                  >
                    {data.tts.kokoroVoices.map(v => (
                      <option key={v.id} value={v.id}>{v.label} — {v.id}</option>
                    ))}
                  </select>
                </FormRow>
              )}

              {(data.tts.engines || []).includes('cloud') && (
                <div className="space-y-3 mt-2 pt-3" style={{ borderTop: '1px dashed var(--separator-strong)' }}>
                  <Hint>
                    The <strong>cloud</strong> engine routes through the AI SDK to OpenAI or
                    ElevenLabs speech models. Leave it unconfigured and the system stays fully
                    local; any cloud failure falls back to Piper automatically.
                  </Hint>
                  <FormRow label="Cloud provider">
                    <SettingSelect
                      value={form.tts.cloud.provider}
                      onChange={v => setForm(f => ({ ...f, tts: { ...f.tts, cloud: { ...f.tts.cloud, provider: v } } }))}
                      options={(data.tts.cloudProviders || ['openai', 'elevenlabs']).map(p => ({ value: p, label: p }))}
                    />
                  </FormRow>
                  <FormRow label="Cloud model" hint='e.g. "gpt-4o-mini-tts" (OpenAI) or "eleven_flash_v2_5" (ElevenLabs).'>
                    <TextInput
                      value={form.tts.cloud.model}
                      onChange={e => setForm(f => ({ ...f, tts: { ...f.tts, cloud: { ...f.tts.cloud, model: e.target.value } } }))}
                      placeholder="gpt-4o-mini-tts"
                      style={{ minWidth: 240 }}
                    />
                  </FormRow>
                  <FormRow label="Cloud voice" hint="OpenAI: alloy, nova, … — ElevenLabs: a voice ID.">
                    <TextInput
                      value={form.tts.cloud.voice}
                      onChange={e => setForm(f => ({ ...f, tts: { ...f.tts, cloud: { ...f.tts.cloud, voice: e.target.value } } }))}
                      placeholder="alloy"
                      style={{ minWidth: 240 }}
                    />
                  </FormRow>
                  <FormRow label="API key" hint={form.tts.cloud.apiKeySet ? 'A key is set. Leave blank to keep it; type to replace.' : 'Or set OPENAI_API_KEY / ELEVENLABS_API_KEY in the environment.'}>
                    <TextInput
                      type="password"
                      value={form.tts.cloud.apiKey}
                      onChange={e => setForm(f => ({ ...f, tts: { ...f.tts, cloud: { ...f.tts.cloud, apiKey: e.target.value } } }))}
                      placeholder={form.tts.cloud.apiKeySet ? '•••••••• (set)' : 'paste key'}
                      style={{ minWidth: 240 }}
                    />
                  </FormRow>
                </div>
              )}

              <div className="space-y-3 mt-2">
                {(data.tts.kinds || []).map(k => (
                  <FormRow
                    key={k}
                    label={TTS_KIND_LABEL[k] || k}
                    hint={TTS_KIND_HINT[k]}
                  >
                    <EngineSelect
                      engines={data.tts.engines || ['piper']}
                      available={data.tts.available || {}}
                      value={form.tts.byKind?.[k] ?? null}
                      onChange={v => setForm(f => ({
                        ...f,
                        tts: { ...f.tts, byKind: { ...f.tts.byKind, [k]: v } },
                      }))}
                      allowDefault
                      defaultEngine={form.tts.defaultEngine}
                    />
                  </FormRow>
                ))}
              </div>

              <div
                className="flex flex-wrap items-center gap-3 pt-3 mt-3"
                style={{ borderTop: '1px solid var(--separator-strong)' }}
              >
                <SolidButton
                  onClick={() => saveSettings({
                    tts: {
                      defaultEngine: form.tts.defaultEngine,
                      byKind: form.tts.byKind,
                      kokoro: { voice: form.tts.kokoro?.voice },
                      cloud: {
                        provider: form.tts.cloud.provider,
                        model: form.tts.cloud.model,
                        voice: form.tts.cloud.voice,
                        // Only send the key when the operator typed one — an
                        // empty string would otherwise clear the stored key.
                        ...(form.tts.cloud.apiKey ? { apiKey: form.tts.cloud.apiKey } : {}),
                      },
                    },
                  })}
                  disabled={busy}
                >
                  save TTS settings
                </SolidButton>
                {saveMsg && (
                  <span style={{ fontSize: 12, color: saveMsg.tone === 'err' ? '#c5302a' : 'var(--accent)' }}>
                    {saveMsg.text}
                  </span>
                )}
              </div>
              <Footnote>
                Applies to the next spoken segment — no mixer restart needed. Jingle changes
                only affect newly generated jingles; existing files keep whichever voice rendered them.
              </Footnote>
            </Section>
          )}

          {form && data.llm && (
            <Section title="LLM provider">
              <Hint>
                Which language model writes DJ scripts, matches listener requests, and picks
                tracks. <strong>Ollama</strong> runs on the homelab box and needs no key;
                the cloud providers are opt-in. Switching here reroutes every LLM call —
                no redeploy.
              </Hint>

              <FormRow label="Provider">
                <SettingSelect
                  value={form.llm.provider}
                  onChange={v => setForm(f => ({ ...f, llm: { ...f.llm, provider: v } }))}
                  options={(data.llm.providers || ['ollama']).map(p => ({ value: p, label: p }))}
                />
              </FormRow>

              <FormRow
                label="Model"
                hint={form.llm.provider === 'ollama'
                  ? 'Leave blank to use the OLLAMA_MODEL default.'
                  : form.llm.provider === 'gateway'
                    ? 'Gateway model id, e.g. "anthropic/claude-sonnet-4-5".'
                    : 'Model id for the chosen provider — required.'}
              >
                <TextInput
                  value={form.llm.model}
                  onChange={e => setForm(f => ({ ...f, llm: { ...f.llm, model: e.target.value } }))}
                  placeholder={form.llm.provider === 'ollama' ? '(OLLAMA_MODEL default)' : 'model id'}
                  style={{ minWidth: 280 }}
                />
              </FormRow>

              {form.llm.provider !== 'ollama' && (
                <FormRow
                  label="API key"
                  hint={form.llm.apiKeySet
                    ? 'A key is set. Leave blank to keep it; type to replace.'
                    : 'Or set the provider env var (ANTHROPIC_API_KEY / OPENAI_API_KEY / AI_GATEWAY_API_KEY).'}
                >
                  <TextInput
                    type="password"
                    value={form.llm.apiKey}
                    onChange={e => setForm(f => ({ ...f, llm: { ...f.llm, apiKey: e.target.value } }))}
                    placeholder={form.llm.apiKeySet ? '•••••••• (set)' : 'paste key'}
                    style={{ minWidth: 280 }}
                  />
                </FormRow>
              )}

              <FormRow
                label="Agentic picker"
                hint="When on, the next-track picker is a tool-using agent that explores the library itself. Needs a model that handles multi-step tool calls well — leave off for small local models."
              >
                <label className="flex items-center gap-2" style={{ fontSize: 13, color: 'var(--ink)' }}>
                  <input
                    type="checkbox"
                    checked={form.llm.pickerAgent}
                    onChange={e => setForm(f => ({ ...f, llm: { ...f.llm, pickerAgent: e.target.checked } }))}
                  />
                  {form.llm.pickerAgent ? 'agent' : 'candidate pool (default)'}
                </label>
              </FormRow>

              <div
                className="flex flex-wrap items-center gap-3 pt-3 mt-3"
                style={{ borderTop: '1px solid var(--separator-strong)' }}
              >
                <SolidButton
                  onClick={() => saveSettings({
                    llm: {
                      provider: form.llm.provider,
                      model: form.llm.model,
                      pickerAgent: form.llm.pickerAgent,
                      // Only send the key when the operator typed one.
                      ...(form.llm.apiKey ? { apiKey: form.llm.apiKey } : {}),
                    },
                  })}
                  disabled={busy}
                >
                  save LLM provider
                </SolidButton>
                {saveMsg && (
                  <span style={{ fontSize: 12, color: saveMsg.tone === 'err' ? '#c5302a' : 'var(--accent)' }}>
                    {saveMsg.text}
                  </span>
                )}
              </div>
              <Footnote>Active model: {data.llm.active}. Applies to the next LLM call — no restart needed.</Footnote>
            </Section>
          )}

          {form && (
            <Section title="Mixer settings">
              <div className="space-y-5">
                <FormRow
                  label="Crossfade duration"
                  hint={`Seconds of overlap between tracks (current: ${data.values?.crossfadeDuration}s)`}
                  requiresRestart
                >
                  <NumInput
                    value={form.crossfadeDuration}
                    onChange={e => setForm(f => ({ ...f, crossfadeDuration: e.target.value }))}
                    style={{ width: 112 }}
                    step={0.5}
                    max={30}
                  />
                  <span style={{ color: 'var(--muted)', fontSize: 12, marginLeft: 8 }}>sec</span>
                </FormRow>

                <FormRow
                  label="Weather location"
                  hint={`Used for DJ context + Open-Meteo lookups (current: ${data.values?.weather?.locationName} @ ${data.values?.weather?.lat}, ${data.values?.weather?.lng})`}
                >
                  <div className="flex flex-wrap gap-2">
                    <TextInput
                      placeholder="name"
                      value={form.weather.locationName}
                      onChange={e => setForm(f => ({ ...f, weather: { ...f.weather, locationName: e.target.value } }))}
                      style={{ width: 176 }}
                    />
                    <NumInput
                      step="any"
                      placeholder="lat"
                      value={form.weather.lat}
                      onChange={e => setForm(f => ({ ...f, weather: { ...f.weather, lat: e.target.value } }))}
                      style={{ width: 128 }}
                    />
                    <NumInput
                      step="any"
                      placeholder="lng"
                      value={form.weather.lng}
                      onChange={e => setForm(f => ({ ...f, weather: { ...f.weather, lng: e.target.value } }))}
                      style={{ width: 128 }}
                    />
                  </div>
                </FormRow>

                <div
                  className="flex flex-wrap items-center gap-3 pt-3"
                  style={{ borderTop: '1px solid var(--separator-strong)' }}
                >
                  <SolidButton
                    onClick={() => saveSettings({
                      crossfadeDuration: parseFloat(form.crossfadeDuration),
                      weather: {
                        lat: parseFloat(form.weather.lat),
                        lng: parseFloat(form.weather.lng),
                        locationName: form.weather.locationName,
                      },
                    })}
                    disabled={busy}
                  >
                    save settings
                  </SolidButton>
                  {pendingRestart && (
                    <SolidButton onClick={restartMixer} disabled={busy} danger>
                      restart mixer
                    </SolidButton>
                  )}
                  {saveMsg && (
                    <span style={{ fontSize: 12, color: saveMsg.tone === 'err' ? '#c5302a' : 'var(--accent)' }}>
                      {saveMsg.text}
                    </span>
                  )}
                </div>
                <Footnote>
                  Weather location applies live · Crossfade requires a mixer restart
                </Footnote>
              </div>
            </Section>
          )}

          <Section title="Library mood tags">
            <Row>
              <div>
                <Lead>
                  {data.libraryStats?.total ?? 0} tracks tagged
                  {data.libraryStats?.updatedAt && (
                    <span style={{ color: 'var(--muted)', marginLeft: 8, fontSize: 12 }}>
                      · last update {new Date(data.libraryStats.updatedAt).toLocaleString('en-GB')}
                    </span>
                  )}
                </Lead>
                <Hint>
                  Walks your Navidrome library album-by-album, classifies each track via Ollama.
                  Resumable — already-tagged tracks are skipped.
                </Hint>
              </div>
            </Row>

            <div className="flex items-center gap-2 mt-3">
              <span className="v3-caption" style={{ color: 'var(--muted)' }}>limit</span>
              <NumInput
                value={taggerLimit}
                onChange={e => setTaggerLimit(e.target.value)}
                disabled={data.tagger.running}
                style={{ width: 96 }}
              />
              <SolidButton
                onClick={startTagger}
                disabled={busy || data.tagger.running}
              >
                {data.tagger.running ? 'running…' : 'start tagging'}
              </SolidButton>
              {data.tagger.running && data.tagger.startedAt && (
                <span style={{ color: 'var(--muted)', fontSize: 11 }}>
                  pid {data.tagger.pid} · started {new Date(data.tagger.startedAt).toLocaleTimeString('en-GB')}
                </span>
              )}
            </div>

            {data.libraryStats?.total > 0 && (
              <div className="mt-4">
                <div className="v3-caption mb-2" style={{ color: 'var(--muted)' }}>by mood</div>
                <div className="flex flex-wrap gap-1">
                  {Object.entries(data.libraryStats.byMood || {})
                    .sort((a, b) => b[1] - a[1])
                    .map(([m, n]) => (
                      <span
                        key={m}
                        style={{
                          border: '1px solid var(--ink)',
                          padding: '2px 8px',
                          fontSize: 12,
                        }}
                      >
                        <span style={{ color: 'var(--ink)' }}>{m}</span>{' '}
                        <span className="v3-tab-num" style={{ color: 'var(--muted)' }}>{n}</span>
                      </span>
                    ))}
                </div>
              </div>
            )}

            {data.tagger.lastLog?.length > 0 && (
              <details className="mt-4" style={{ border: '1px solid var(--ink)' }}>
                <summary
                  className="cursor-pointer v3-caption"
                  style={{ padding: '8px 12px', color: 'var(--ink)' }}
                >
                  tagger log ({data.tagger.lastLog.length} lines)
                </summary>
                <pre
                  className="v3-scroll"
                  style={{
                    fontSize: 11,
                    lineHeight: 1.4,
                    maxHeight: 280,
                    overflowY: 'auto',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                    padding: 12,
                    color: 'var(--ink)',
                    borderTop: '1px solid var(--ink)',
                  }}
                >
                  {data.tagger.lastLog.join('\n')}
                </pre>
              </details>
            )}
          </Section>

          <Section title={`Jingles · ${data.jingles.length}`}>
            <Hint>
              Pre-recorded TTS stingers. A default station ident is generated on first boot;
              you can add your own here.
            </Hint>

            {form && (
              <div
                className="flex flex-wrap items-end gap-3 mt-4 pb-4"
                style={{ borderBottom: '1px solid var(--separator-strong)' }}
              >
                <div>
                  <div style={{ color: 'var(--ink)', fontSize: 13, fontWeight: 600 }}>
                    Frequency
                  </div>
                  <Hint>1 jingle every N music tracks · current: {data.values?.jingleRatio}</Hint>
                </div>
                <NumInput
                  value={form.jingleRatio}
                  onChange={e => setForm(f => ({ ...f, jingleRatio: e.target.value }))}
                  style={{ width: 96 }}
                  min={1}
                  max={1000}
                />
                <SolidButton
                  onClick={() => saveSettings({ jingleRatio: parseInt(form.jingleRatio, 10) })}
                  disabled={busy || form.jingleRatio === String(data.values?.jingleRatio)}
                >
                  save · needs restart
                </SolidButton>
              </div>
            )}

            <div className="space-y-2 mt-3">
              <textarea
                rows={2}
                value={jingleText}
                onChange={e => setJingleText(e.target.value)}
                placeholder='e.g. "You are listening to SUB slash WAVE. Requests open all night."'
                className="w-full v3-focus"
                style={{
                  boxSizing: 'border-box',
                  border: '1px solid var(--ink)',
                  background: 'transparent',
                  padding: 10,
                  fontSize: 13,
                  fontFamily: 'inherit',
                  color: 'var(--ink)',
                  resize: 'none',
                }}
              />
              <div className="flex items-center gap-2">
                <SolidButton onClick={createJingle} disabled={busy || !jingleText.trim()}>
                  {busy ? 'generating…' : 'create jingle'}
                </SolidButton>
                <span style={{ color: 'var(--muted)', fontSize: 11 }}>
                  {jingleText.length}/500 chars · Piper TTS
                </span>
              </div>
            </div>

            <div className="mt-5" style={{ borderTop: '1px solid var(--separator-strong)' }}>
              {data.jingles.length === 0 && (
                <div className="py-4 italic" style={{ color: 'var(--muted)', fontSize: 12 }}>none yet</div>
              )}
              {data.jingles.map(j => (
                <div
                  key={j.filename}
                  className="py-3 flex items-start gap-3"
                  style={{ borderBottom: '1px solid var(--separator-soft)' }}
                >
                  <div className="flex-1 min-w-0">
                    <div style={{ color: 'var(--ink)' }} className="break-words">{j.text}</div>
                    <div className="mt-1 flex flex-wrap gap-3 v3-caption" style={{ color: 'var(--muted)' }}>
                      <span>{j.filename}</span>
                      <span>{fmtSize(j.size)}</span>
                      {j.createdAt && <span>{new Date(j.createdAt).toLocaleString('en-GB')}</span>}
                      {j.builtin && <span style={{ color: 'var(--accent)' }}>builtin</span>}
                    </div>
                  </div>
                  <OutlineButton
                    onClick={() => deleteJingle(j.filename)}
                    disabled={busy || j.builtin}
                    title={j.builtin ? "Can't delete the built-in ident" : 'Delete this jingle'}
                  >
                    delete
                  </OutlineButton>
                </div>
              ))}
            </div>
          </Section>
        </>
      )}
    </div>
  );
}

function Section({ title, children }) {
  return (
    <section style={{ border: '1px solid var(--ink)' }}>
      <div className="px-4 py-2" style={{ borderBottom: '1px solid var(--ink)' }}>
        <span className="v3-eyebrow" style={{ fontSize: 11 }}>{title}</span>
      </div>
      <div className="p-5 space-y-2">{children}</div>
    </section>
  );
}
function Row({ children }) {
  return <div className="flex items-start justify-between gap-4 py-2">{children}</div>;
}
function FormRow({ label, hint, requiresRestart, children }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline gap-2">
        <span style={{ color: 'var(--ink)', fontSize: 14, fontWeight: 600 }}>{label}</span>
        {requiresRestart && (
          <span
            className="v3-caption"
            style={{ fontSize: 9, border: '1px solid var(--ink)', padding: '1px 6px' }}
          >
            restart required
          </span>
        )}
      </div>
      {hint && <Hint>{hint}</Hint>}
      <div className="flex items-center flex-wrap">{children}</div>
    </div>
  );
}
function Lead({ children }) {
  return <div style={{ color: 'var(--ink)', fontSize: 14, fontWeight: 600 }}>{children}</div>;
}
function Hint({ children }) {
  return <div style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.5, marginTop: 4 }}>{children}</div>;
}
function Footnote({ children }) {
  return <div className="v3-caption mt-3" style={{ color: 'var(--muted)' }}>{children}</div>;
}
function SolidButton({ onClick, disabled, danger, children }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="v3-eyebrow v3-focus cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
      style={{
        background: danger ? '#c5302a' : 'var(--accent)',
        color: '#fff',
        border: 'none',
        padding: '8px 16px',
        fontSize: 10,
      }}
    >
      {children}
    </button>
  );
}
function OutlineButton({ onClick, disabled, title, children }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="v3-eyebrow v3-focus cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed shrink-0"
      style={{
        background: 'transparent',
        color: 'var(--ink)',
        border: '1px solid var(--ink)',
        padding: '4px 10px',
        fontSize: 10,
      }}
    >
      {children}
    </button>
  );
}
function TextInput(props) {
  return (
    <input
      type="text"
      {...props}
      className="v3-focus"
      style={{
        boxSizing: 'border-box',
        border: '1px solid var(--ink)',
        background: 'transparent',
        padding: '8px 12px',
        fontSize: 13,
        fontFamily: 'inherit',
        color: 'var(--ink)',
        outline: 'none',
        ...(props.style || {}),
      }}
    />
  );
}
function NumInput({ style, ...props }) {
  return (
    <input
      type="number"
      {...props}
      className="v3-focus v3-tab-num"
      style={{
        boxSizing: 'border-box',
        border: '1px solid var(--ink)',
        background: 'transparent',
        padding: '8px 12px',
        fontSize: 13,
        fontFamily: 'inherit',
        color: 'var(--ink)',
        outline: 'none',
        ...(style || {}),
      }}
    />
  );
}
// Plain styled <select> for simple { value, label } option lists.
function SettingSelect({ value, onChange, options }) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className="v3-focus"
      style={{
        boxSizing: 'border-box',
        border: '1px solid var(--ink)',
        background: 'transparent',
        padding: '8px 12px',
        fontSize: 13,
        fontFamily: 'inherit',
        color: 'var(--ink)',
        outline: 'none',
        minWidth: 240,
      }}
    >
      {options.map(o => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}
function EngineSelect({ engines, available, value, onChange, allowDefault, defaultEngine }) {
  // value is either an engine name or null (= use default).
  // Render as a segmented control. "Default" pill is only shown when allowDefault.
  const options = [];
  if (allowDefault) options.push({ key: '__default__', label: `default (${defaultEngine || 'piper'})` });
  for (const e of engines) {
    options.push({ key: e, label: e });
  }

  const selected = value == null ? '__default__' : value;

  return (
    <div style={{ display: 'inline-flex', border: '1px solid var(--ink)', flexWrap: 'wrap' }}>
      {options.map((opt, i) => {
        const active = selected === opt.key;
        const isEngine = opt.key !== '__default__';
        const disabled = isEngine && available[opt.key] === false;
        return (
          <button
            key={opt.key}
            type="button"
            disabled={disabled}
            onClick={() => onChange(opt.key === '__default__' ? null : opt.key)}
            className="v3-eyebrow v3-focus cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
            style={{
              background: active ? 'var(--ink)' : 'transparent',
              color: active ? 'var(--bg)' : 'var(--ink)',
              border: 'none',
              borderLeft: i === 0 ? 'none' : '1px solid var(--ink)',
              padding: '8px 14px',
              fontSize: 10,
            }}
            aria-pressed={active}
            title={disabled ? `${opt.key} is not installed in this build` : opt.label}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function FrequencySegmented({ value, onChange }) {
  return (
    <div style={{ display: 'inline-flex', border: '1px solid var(--ink)' }}>
      {FREQUENCIES.map((m, i) => {
        const active = value === m;
        return (
          <button
            key={m}
            type="button"
            onClick={() => onChange(m)}
            className="v3-eyebrow v3-focus cursor-pointer"
            style={{
              background: active ? 'var(--ink)' : 'transparent',
              color: active ? 'var(--bg)' : 'var(--ink)',
              border: 'none',
              borderLeft: i === 0 ? 'none' : '1px solid var(--ink)',
              padding: '8px 14px',
              fontSize: 10,
            }}
            aria-pressed={active}
          >
            {m}
          </button>
        );
      })}
    </div>
  );
}

function Alert({ tone, children }) {
  return (
    <div
      style={{
        border: `1px solid ${tone === 'err' ? '#c5302a' : 'var(--ink)'}`,
        color: tone === 'err' ? '#c5302a' : 'var(--ink)',
        padding: '8px 12px',
        fontSize: 13,
      }}
    >
      {children}
    </div>
  );
}
