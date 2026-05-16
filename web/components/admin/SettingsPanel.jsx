'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { fmtSize } from '../../lib/format';
import { useAdminAuth } from '../../lib/adminAuth';
import { CLOUD_VOICES, CLOUD_MODELS } from '../../lib/cloudVoices';
import { V3AlertDialog } from '../ui/alert-dialog';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
import { Label } from '../ui/label';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem, SelectGroup,
} from '../ui/select';
import { Card, Btn, Pill, Eyebrow, Seg, Metric } from './ui';

const SECTIONS = [
  { id: 'tts',     label: 'TTS voice', hint: 'default engine' },
  { id: 'llm',     label: 'LLM provider', hint: 'model routing' },
  { id: 'mixer',   label: 'Mixer', hint: 'crossfade · weather' },
  { id: 'jingles', label: 'Jingles', hint: 'stingers' },
];

// Each non-Ollama LLM provider reads its key from this controller env var.
const LLM_ENV_VARS = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  gateway: 'AI_GATEWAY_API_KEY',
};

export default function SettingsPanel() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [jingleText, setJingleText] = useState('');
  const [form, setForm] = useState(null);
  const [pendingRestart, setPendingRestart] = useState(false);
  const [saveMsg, setSaveMsg] = useState(null);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);  // jingle filename, or null
  const [activeSection, setActiveSection] = useState('tts');

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
      tts: {
        defaultEngine: data.values.tts?.defaultEngine ?? 'piper',
        kokoro: { voice: data.values.tts?.kokoro?.voice ?? 'bf_isabella' },
        cloud: {
          enabled: data.values.tts?.cloud?.enabled ?? false,
          provider: data.values.tts?.cloud?.provider ?? 'openai',
          model: data.values.tts?.cloud?.model ?? '',
          voice: data.values.tts?.cloud?.voice ?? '',
        },
      },
      llm: {
        provider: data.values.llm?.provider ?? 'ollama',
        model: data.values.llm?.model ?? '',
        ollamaUrl: data.values.llm?.ollamaUrl ?? '',
        pickerAgent: !!data.values.llm?.pickerAgent,
      },
    });
  }, [data, form]);

  useEffect(() => {
    // Wait for the auth token to hydrate from localStorage — fetching before
    // then sends an unauthenticated request that 401s.
    if (!hydrated || needsAuth) return;
    refresh();
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, needsAuth]);

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

  // Confirmed via the dialog before this runs — the broadcast drops briefly.
  const restartMixer = async () => {
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

  // Take the station off air — stops the Icecast output (confirmed via dialog).
  const stopStream = async () => {
    setBusy(true);
    try {
      const r = await adminFetch('/stream-stop', { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      setSaveMsg({ tone: 'ok', text: 'stream stopped — station is off air' });
      await refresh();
    } catch (e) {
      setSaveMsg({ tone: 'err', text: e.message });
    } finally { setBusy(false); }
  };

  // Bring the station back on air — non-destructive, no confirm needed.
  const startStream = async () => {
    setBusy(true);
    try {
      const r = await adminFetch('/stream-start', { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      setSaveMsg({ tone: 'ok', text: 'stream started — station is on air' });
      await refresh();
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
    } catch (e) { toast.error(`Jingle creation failed: ${e.message}`); }
    finally { setBusy(false); }
  };

  // Confirmed via the dialog before this runs.
  const deleteJingle = async (filename) => {
    setBusy(true);
    try {
      const r = await adminFetch(`/jingles/${encodeURIComponent(filename)}`, { method: 'DELETE' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      await refresh();
    } catch (e) { toast.error(`Delete failed: ${e.message}`); }
    finally { setBusy(false); }
  };

  return (
    <div className="stack-mobile" style={{ display: 'grid', gridTemplateColumns: '240px 1fr', gap: 24, alignItems: 'flex-start' }}>
      {/* Section rail */}
      <aside style={{ display: 'grid', gap: 4, position: 'sticky', top: 24 }}>
        <span className="caption" style={{ padding: '0 0 8px' }}>settings</span>
        {SECTIONS.map(s => {
          const isActive = activeSection === s.id;
          return (
            <button
              key={s.id}
              onClick={() => setActiveSection(s.id)}
              style={{
                border: '1px solid var(--ink)',
                background: isActive ? 'var(--ink)' : 'transparent',
                color: isActive ? 'var(--bg)' : 'var(--ink)',
                padding: '10px 12px',
                textAlign: 'left',
                cursor: 'pointer',
                fontFamily: 'inherit',
                display: 'grid', gap: 4,
              }}
            >
              <span style={{ fontSize: 11, letterSpacing: '0.2em', textTransform: 'uppercase', fontWeight: 700 }}>
                {s.label}
              </span>
              <span style={{ fontSize: 9, letterSpacing: '0.18em', textTransform: 'uppercase', opacity: 0.7 }}>
                {s.id === 'jingles' && data ? `${data.jingles.length} file${data.jingles.length === 1 ? '' : 's'}` : s.hint}
              </span>
            </button>
          );
        })}

        <div style={{ marginTop: 16, padding: 12, border: '1px dashed var(--separator-strong)', display: 'grid', gap: 8 }}>
          <span className="caption">danger zone</span>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
            <span style={{ color: 'var(--muted)' }}>broadcast</span>
            <strong style={{ color: data?.streamOnAir === false ? 'var(--danger)' : data?.streamOnAir ? 'var(--accent)' : 'var(--muted)' }}>
              {data?.streamOnAir == null ? '—' : data.streamOnAir ? 'on air' : 'off air'}
            </strong>
          </div>
          {data?.streamOnAir === false ? (
            <Btn sm tone="accent" onClick={startStream} disabled={busy || !data}>
              Start stream
            </Btn>
          ) : (
            <Btn sm tone="danger" onClick={() => setConfirmStop(true)} disabled={busy || !data || data?.streamOnAir == null}>
              Stop stream
            </Btn>
          )}
          <div style={{ fontSize: 10, color: 'var(--muted)', lineHeight: 1.4 }}>
            Takes the station off air by disconnecting the Icecast mount. A mixer restart brings it back on air.
          </div>

          <Btn sm tone="danger" onClick={() => setConfirmRestart(true)} disabled={busy || !data}>
            Restart mixer
          </Btn>
          <div style={{ fontSize: 10, color: 'var(--muted)', lineHeight: 1.4 }}>
            Drops the broadcast for ~3–5s. Use after crossfade or jingle frequency changes.
            {pendingRestart && (
              <strong style={{ display: 'block', marginTop: 4, color: 'var(--accent)' }}>
                Pending settings need a restart to apply.
              </strong>
            )}
          </div>
        </div>
      </aside>

      {/* Active section */}
      <div style={{ display: 'grid', gap: 16 }}>
        {err && (
          <div className="card" style={{ borderColor: 'var(--danger)' }}>
            <div className="card-body" style={{ color: 'var(--danger)', fontSize: 12 }}>
              <strong style={{ letterSpacing: '0.12em', textTransform: 'uppercase' }}>controller error</strong>
              <div style={{ marginTop: 4 }}>{err}</div>
            </div>
          </div>
        )}
        {!data && !err && (
          <div style={{ color: 'var(--muted)', fontStyle: 'italic', fontSize: 13 }}>loading…</div>
        )}

        {data && form && (
          <>
            {activeSection === 'tts' && data.tts && (
              <TtsSection
                data={data} form={form} setForm={setForm} busy={busy}
                saveMsg={saveMsg} saveSettings={saveSettings}
              />
            )}
            {activeSection === 'llm' && data.llm && (
              <LlmSection
                data={data} form={form} setForm={setForm} busy={busy}
                saveMsg={saveMsg} saveSettings={saveSettings}
              />
            )}
            {activeSection === 'mixer' && (
              <MixerSection
                data={data} form={form} setForm={setForm} busy={busy}
                saveMsg={saveMsg} saveSettings={saveSettings}
              />
            )}
            {activeSection === 'jingles' && (
              <JinglesSection
                data={data} form={form} setForm={setForm} busy={busy}
                jingleText={jingleText} setJingleText={setJingleText}
                createJingle={createJingle} saveSettings={saveSettings}
                onDelete={setConfirmDelete}
              />
            )}
          </>
        )}
      </div>

      <V3AlertDialog
        open={confirmRestart}
        onOpenChange={setConfirmRestart}
        title="Restart mixer"
        description="Restart the mixer to apply pending settings? The broadcast will drop for roughly 3–5 seconds."
        confirmLabel="restart mixer"
        danger
        onConfirm={restartMixer}
      />
      <V3AlertDialog
        open={confirmStop}
        onOpenChange={setConfirmStop}
        title="Stop stream"
        description="Take the station off air? The Icecast mount disconnects — every current listener is dropped and new listeners get nothing until you start the stream again."
        confirmLabel="stop stream"
        danger
        onConfirm={stopStream}
      />
      <V3AlertDialog
        open={confirmDelete != null}
        onOpenChange={(o) => { if (!o) setConfirmDelete(null); }}
        title="Delete jingle"
        description={confirmDelete ? `Delete the jingle "${confirmDelete}"? This removes the rendered audio file permanently.` : ''}
        confirmLabel="delete"
        danger
        onConfirm={() => { if (confirmDelete) deleteJingle(confirmDelete); setConfirmDelete(null); }}
      />
    </div>
  );
}

/* ── Shared bits ─────────────────────────────────────────────────────── */

function SectionHeader({ eyebrow, title, sub, metrics }) {
  return (
    <div style={{ padding: 16, border: '1px solid var(--ink)', display: 'flex', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
      <div style={{ flex: 1, minWidth: 240 }}>
        <Eyebrow color="var(--accent)">{eyebrow}</Eyebrow>
        <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em', marginTop: 6 }}>
          {title}
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6, maxWidth: 540, lineHeight: 1.5 }}>
          {sub}
        </div>
      </div>
      {metrics && metrics.length > 0 && (
        <div style={{ display: 'grid', gridAutoFlow: 'column', gap: 18, paddingTop: 4 }}>
          {metrics.map((m, i) => <Metric key={i} n={m.n} l={m.l} accent={m.accent} />)}
        </div>
      )}
    </div>
  );
}

function SaveBar({ note, busy, saveMsg, onSave, saveLabel, extra }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
      padding: 12, border: '1px solid var(--ink)', background: 'var(--ink-softer)',
    }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)' }} />
      <span style={{ fontSize: 11, color: 'var(--muted)' }}>{note}</span>
      {saveMsg && (
        <span style={{ fontSize: 11, color: saveMsg.tone === 'err' ? 'var(--danger)' : 'var(--accent)' }}>
          {saveMsg.text}
        </span>
      )}
      <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
        {extra}
        <Btn tone="accent" onClick={onSave} disabled={busy}>{saveLabel}</Btn>
      </span>
    </div>
  );
}

/* API-key status banner. The key itself is never entered in the admin UI —
   it's read from the controller's environment. This just reports whether the
   relevant env var is present, and tells the operator how to set it if not. */
function KeyStatus({ envVar, present }) {
  const tone = present ? 'var(--accent)' : 'var(--danger)';
  return (
    <div
      className="field"
      style={{
        marginTop: 14,
        padding: 12,
        border: `1px solid ${tone}`,
        background: 'var(--ink-softer)',
        display: 'flex', alignItems: 'flex-start', gap: 10,
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: '50%', marginTop: 5, flex: 'none', background: tone }} />
      <div style={{ display: 'grid', gap: 3 }}>
        <span style={{ fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase', fontWeight: 700, color: tone }}>
          {present ? 'API key found in environment' : 'API key missing'}
        </span>
        <span style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.5 }}>
          {present ? (
            <>The controller has <code>{envVar}</code> set — this provider is ready to use.</>
          ) : (
            <>
              Set <code>{envVar}</code> in <code>controller/.env</code> and restart the controller.
              API keys are configured through the environment, not the admin UI.
            </>
          )}
        </span>
      </div>
    </div>
  );
}

/* ── TTS ─────────────────────────────────────────────────────────────── */

function TtsSection({ data, form, setForm, busy, saveMsg, saveSettings }) {
  const engines = data.tts.engines || ['piper'];
  const available = data.tts.available || {};
  const ENGINE_LABELS = { piper: 'Piper', kokoro: 'Kokoro', cloud: 'Cloud' };
  const engineOptions = engines.map(e => ({ id: e, label: ENGINE_LABELS[e] || e }));

  const save = () => saveSettings({
    tts: {
      defaultEngine: form.tts.defaultEngine,
      kokoro: { voice: form.tts.kokoro?.voice },
      cloud: {
        // No "off" state — Cloud is configured-and-available whenever its
        // API key is set; the real gate is the key, not a separate toggle.
        enabled: true,
        provider: form.tts.cloud.provider,
        model: form.tts.cloud.model,
        voice: form.tts.cloud.voice,
        // The API key is never set from the UI — it comes from the
        // controller's environment (OPENAI_API_KEY / ELEVENLABS_API_KEY).
      },
    },
  });

  // Switch the Cloud provider, revalidating the voice + model ids — both are
  // provider-specific, so an OpenAI id is invalid against ElevenLabs.
  const selectCloudProvider = (f, provider) => {
    const provVoices = CLOUD_VOICES[provider] || [];
    const voice = provVoices.some(pv => pv.id === f.tts.cloud.voice.trim())
      ? f.tts.cloud.voice
      : (provVoices[0]?.id || f.tts.cloud.voice);
    const provModels = CLOUD_MODELS[provider] || [];
    const model = provModels.includes(f.tts.cloud.model.trim())
      ? f.tts.cloud.model
      : (provModels[0] || f.tts.cloud.model);
    return { ...f, tts: { ...f.tts, cloud: { ...f.tts.cloud, enabled: true, provider, voice, model } } };
  };

  // Pick the station engine; choosing Cloud also primes its provider config.
  const selectEngine = (engine) => setForm(f => {
    const base = engine === 'cloud'
      ? selectCloudProvider(f, f.tts.cloud.provider || 'openai')
      : f;
    return { ...base, tts: { ...base.tts, defaultEngine: engine } };
  });

  return (
    <>
      <SectionHeader
        eyebrow="tts voice"
        title="Pick a voice engine, then configure it."
        sub={<>
          Every spoken segment is voiced by the <strong>persona on air</strong> — set each
          persona’s engine and voice on the Personas page. Here you pick the station’s
          default engine (used for jingles and as the fallback) and configure whichever
          one you choose.
          {available.kokoro === false && (
            <span style={{ color: 'var(--danger)' }}> Kokoro is unavailable in this build.</span>
          )}
        </>}
        metrics={[
          { n: String(engines.length), l: 'engines', accent: true },
        ]}
      />

      {/* One engine selector — then only that engine's settings show. */}
      <Card title="Voice engine" sub="pick one — then configure it">
        <div className="field">
          <Label>Engine</Label>
          <Seg
            accent
            value={form.tts.defaultEngine}
            options={engineOptions}
            onChange={selectEngine}
          />
          <div className="field-hint">
            The station default — renders jingles and is the fallback when a persona’s
            own engine fails. Per-segment voice still comes from the persona on air.
          </div>
        </div>

        {/* ── PIPER ────────────────────────────────────────────────── */}
        {form.tts.defaultEngine === 'piper' && (
          <div className="field" style={{ marginTop: 16 }}>
            <div className="field-hint">
              Piper is bundled with the controller — fast, lightweight, and always
              available. Nothing to configure.
            </div>
          </div>
        )}

        {/* ── KOKORO ───────────────────────────────────────────────── */}
        {form.tts.defaultEngine === 'kokoro' && (
          <div className="field" style={{ marginTop: 16 }}>
            <Label>Kokoro voice</Label>
            {available.kokoro === false && (
              <div className="field-hint" style={{ color: 'var(--danger)' }}>
                Kokoro is not installed in this build — it will fall back to Piper.
              </div>
            )}
            {(data.tts.kokoroVoices?.length || 0) > 0 ? (
              <>
                <Select
                  value={form.tts.kokoro?.voice ?? 'bf_isabella'}
                  onValueChange={val => setForm(f => ({
                    ...f, tts: { ...f.tts, kokoro: { ...f.tts.kokoro, voice: val } },
                  }))}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {data.tts.kokoroVoices.map(v => (
                        <SelectItem key={v.id} value={v.id}>{v.label} — {v.id}</SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <div className="field-hint">British English only. Applies to every kind routed through Kokoro.</div>
              </>
            ) : (
              <div className="field-hint">This build reports no Kokoro voices.</div>
            )}
          </div>
        )}

        {/* ── CLOUD ────────────────────────────────────────────────── */}
        {form.tts.defaultEngine === 'cloud' && (
          <div style={{ marginTop: 16 }}>
            <div className="field">
              <Label>Provider</Label>
              <Seg
                accent
                value={form.tts.cloud.provider}
                options={(data.tts.cloudProviders || ['openai', 'elevenlabs']).map(p => ({ id: p, label: p }))}
                onChange={v => setForm(f => selectCloudProvider(f, v))}
              />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 18, marginTop: 14 }}>
              <div className="field">
                <Label>Model</Label>
                <Input
                  value={form.tts.cloud.model}
                  onChange={e => setForm(f => ({ ...f, tts: { ...f.tts, cloud: { ...f.tts.cloud, model: e.target.value } } }))}
                  placeholder={CLOUD_MODELS[form.tts.cloud.provider]?.[0] || 'gpt-4o-mini-tts'}
                />
                <div className="field-hint">e.g. “gpt-4o-mini-tts” (OpenAI) or “eleven_flash_v2_5” (ElevenLabs).</div>
              </div>
              {(() => {
                const provVoices = CLOUD_VOICES[form.tts.cloud.provider] || [];
                const voice = form.tts.cloud.voice.trim();
                const isPreset = provVoices.some(v => v.id === voice);
                return (
                  <div className="field">
                    <Label>Default voice</Label>
                    <Select
                      value={isPreset ? voice : '__custom__'}
                      onValueChange={val => {
                        if (val !== '__custom__') {
                          setForm(f => ({ ...f, tts: { ...f.tts, cloud: { ...f.tts.cloud, voice: val } } }));
                        }
                      }}
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {provVoices.map(v => (
                            <SelectItem key={v.id} value={v.id}>{v.label}</SelectItem>
                          ))}
                          <SelectItem value="__custom__">Custom voice id…</SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    {!isPreset && (
                      <Input
                        style={{ marginTop: 8, borderColor: voice ? 'var(--ink)' : 'var(--danger)' }}
                        value={form.tts.cloud.voice}
                        maxLength={100}
                        placeholder="Enter a custom voice id"
                        onChange={e => setForm(f => ({ ...f, tts: { ...f.tts, cloud: { ...f.tts.cloud, voice: e.target.value } } }))}
                      />
                    )}
                    <div className="field-hint">
                      Used when a Cloud persona hasn’t set its own voice. Pick a default, or choose
                      <em> Custom voice id…</em> for any other OpenAI voice name / ElevenLabs voice id.
                    </div>
                  </div>
                );
              })()}
            </div>
            <KeyStatus
              envVar={form.tts.cloud.provider === 'elevenlabs' ? 'ELEVENLABS_API_KEY' : 'OPENAI_API_KEY'}
              present={!!data.env?.[form.tts.cloud.provider === 'elevenlabs' ? 'ELEVENLABS_API_KEY' : 'OPENAI_API_KEY']}
            />
          </div>
        )}
      </Card>

      <SaveBar
        note="Applies to jingle rendering and the engine fallback · no mixer restart. Per-segment voice comes from the persona on air."
        busy={busy}
        saveMsg={saveMsg}
        onSave={save}
        saveLabel="Save TTS settings"
      />
    </>
  );
}

/* ── LLM ─────────────────────────────────────────────────────────────── */

function LlmSection({ data, form, setForm, busy, saveMsg, saveSettings }) {
  const save = () => saveSettings({
    llm: {
      provider: form.llm.provider,
      model: form.llm.model,
      ollamaUrl: form.llm.ollamaUrl,
      pickerAgent: form.llm.pickerAgent,
      // The API key is never set from the UI — it comes from the controller's
      // environment (ANTHROPIC_API_KEY / OPENAI_API_KEY / AI_GATEWAY_API_KEY).
    },
  });

  return (
    <>
      <SectionHeader
        eyebrow="llm provider"
        title="The model that writes scripts and picks tracks."
        sub="Ollama runs on the homelab box and needs no key; the cloud providers are opt-in. Switching here reroutes every LLM call — no redeploy."
        metrics={[{ n: String((data.llm.providers || []).length), l: 'providers' }]}
      />

      <Card title="Provider" sub="active routing">
        <div style={{ display: 'grid', gap: 18 }}>
          <div className="field">
            <Label>Provider</Label>
            <Seg
              accent
              value={form.llm.provider}
              options={(data.llm.providers || ['ollama']).map(p => ({ id: p, label: p }))}
              onChange={v => setForm(f => ({ ...f, llm: { ...f.llm, provider: v } }))}
            />
          </div>

          <div className="field">
            <Label>Model</Label>
            <Input
              value={form.llm.model}
              onChange={e => setForm(f => ({ ...f, llm: { ...f.llm, model: e.target.value } }))}
              placeholder={
                form.llm.provider === 'ollama'
                  ? 'nemotron-3-super:cloud'
                  : form.llm.provider === 'deepseek'
                    ? 'deepseek-v4-flash'
                    : 'model id'
              }
              style={{ maxWidth: 360 }}
            />
            <div className="field-hint">
              {form.llm.provider === 'ollama'
                ? 'Ollama model tag, e.g. “nemotron-3-super:cloud”. Leave blank for the default.'
                : form.llm.provider === 'gateway'
                  ? 'Gateway model id, e.g. “anthropic/claude-sonnet-4-5”.'
                  : form.llm.provider === 'openrouter'
                    ? 'OpenRouter model id, e.g. “google/gemini-2.5-flash”.'
                    : form.llm.provider === 'google'
                      ? 'Gemini model id, e.g. “gemini-2.5-flash”.'
                      : form.llm.provider === 'deepseek'
                        ? 'DeepSeek model id. Leave blank for the “deepseek-v4-flash” default.'
                        : 'Model id for the chosen provider — required.'}
            </div>
          </div>

          {form.llm.provider === 'ollama' && (
            <div className="field">
              <Label>Ollama server URL</Label>
              <Input
                value={form.llm.ollamaUrl}
                onChange={e => setForm(f => ({ ...f, llm: { ...f.llm, ollamaUrl: e.target.value } }))}
                placeholder="http://localhost:11434"
                style={{ maxWidth: 360 }}
              />
              <div className="field-hint">
                Where the Ollama server runs. Leave blank for the default
                (<code>http://localhost:11434</code>).
              </div>
            </div>
          )}

          {form.llm.provider !== 'ollama' && (
            <KeyStatus
              envVar={LLM_ENV_VARS[form.llm.provider]}
              present={!!data.env?.[LLM_ENV_VARS[form.llm.provider]]}
            />
          )}
        </div>
      </Card>

      <Card title="Next-track picker" sub="how the DJ chooses">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 16, alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700 }}>Agentic picker</div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2, maxWidth: 480, lineHeight: 1.5 }}>
              When on, the next-track picker is a tool-using agent that explores the library
              itself. Needs a model that handles multi-step tool calls well — leave off for
              small local models.
            </div>
          </div>
          <Seg
            accent
            value={form.llm.pickerAgent ? 'agent' : 'pool'}
            options={[
              { id: 'pool', label: 'Candidate pool' },
              { id: 'agent', label: 'Agent' },
            ]}
            onChange={v => setForm(f => ({ ...f, llm: { ...f.llm, pickerAgent: v === 'agent' } }))}
          />
        </div>
      </Card>

      <SaveBar
        note={`Active model: ${data.llm.active}. Applies to the next LLM call — no restart needed.`}
        busy={busy}
        saveMsg={saveMsg}
        onSave={save}
        saveLabel="Save LLM provider"
      />
    </>
  );
}

/* ── Mixer ───────────────────────────────────────────────────────────── */

function MixerSection({ data, form, setForm, busy, saveMsg, saveSettings }) {
  const save = () => saveSettings({
    crossfadeDuration: parseFloat(form.crossfadeDuration),
    weather: {
      lat: parseFloat(form.weather.lat),
      lng: parseFloat(form.weather.lng),
      locationName: form.weather.locationName,
    },
  });

  return (
    <>
      <SectionHeader
        eyebrow="mixer"
        title="Crossfade and where the station broadcasts from."
        sub="Crossfade overlap shapes every track transition. The station location sets where the DJ thinks it broadcasts from and drives the Open-Meteo weather it reads on air."
        metrics={[
          { n: `${data.values?.crossfadeDuration}s`, l: 'crossfade', accent: true },
        ]}
      />

      <Card title="Crossfade" sub="track transition overlap">
        <div className="field">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Label>Crossfade duration</Label>
            <Pill tone="ink">restart required</Pill>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Input
              className="mono-num"
              type="number"
              step={0.5}
              max={30}
              value={form.crossfadeDuration}
              onChange={e => setForm(f => ({ ...f, crossfadeDuration: e.target.value }))}
              style={{ width: 112 }}
            />
            <span style={{ color: 'var(--muted)', fontSize: 12 }}>sec</span>
          </div>
          <div className="field-hint">
            Seconds of overlap between tracks (current: {data.values?.crossfadeDuration}s).
            Requires a mixer restart to apply.
          </div>
        </div>
      </Card>

      <Card title="Station location" sub="DJ context + Open-Meteo weather">
        <div className="field">
          <Label>Location</Label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <Input
              placeholder="name"
              value={form.weather.locationName}
              onChange={e => setForm(f => ({ ...f, weather: { ...f.weather, locationName: e.target.value } }))}
              style={{ width: 200 }}
            />
            <Input
              className="mono-num"
              type="number"
              step="any"
              placeholder="lat"
              value={form.weather.lat}
              onChange={e => setForm(f => ({ ...f, weather: { ...f.weather, lat: e.target.value } }))}
              style={{ width: 132 }}
            />
            <Input
              className="mono-num"
              type="number"
              step="any"
              placeholder="lng"
              value={form.weather.lng}
              onChange={e => setForm(f => ({ ...f, weather: { ...f.weather, lng: e.target.value } }))}
              style={{ width: 132 }}
            />
          </div>
          <div className="field-hint">
            Where the station broadcasts from — sets the DJ’s {'{location}'} and the Open-Meteo
            weather it reads on air (current: {data.values?.weather?.locationName} @ {data.values?.weather?.lat}, {data.values?.weather?.lng}). Applies live.
          </div>
        </div>
      </Card>

      <SaveBar
        note="Station location applies live · Crossfade requires a mixer restart (danger zone)."
        busy={busy}
        saveMsg={saveMsg}
        onSave={save}
        saveLabel="Save mixer settings"
      />
    </>
  );
}

/* ── Jingles ─────────────────────────────────────────────────────────── */

function JinglesSection({ data, form, setForm, busy, jingleText, setJingleText, createJingle, saveSettings, onDelete }) {
  const ratioDirty = form.jingleRatio !== String(data.values?.jingleRatio);

  return (
    <>
      <SectionHeader
        eyebrow="jingles"
        title="Pre-recorded TTS station stingers."
        sub="A default station ident is generated on first boot; you can add your own here. The built-in ident can’t be deleted."
        metrics={[
          { n: String(data.jingles.length), l: 'files' },
          { n: String(data.values?.jingleRatio), l: 'ratio', accent: true },
        ]}
      />

      <Card title="Frequency" sub="needs mixer restart">
        <div className="field">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Label>Jingle ratio</Label>
            <Pill tone="ink">restart required</Pill>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <Input
              className="mono-num"
              type="number"
              min={1}
              max={1000}
              value={form.jingleRatio}
              onChange={e => setForm(f => ({ ...f, jingleRatio: e.target.value }))}
              style={{ width: 96 }}
            />
            <span style={{ color: 'var(--muted)', fontSize: 12 }}>music tracks per jingle</span>
            <Btn
              tone="solid"
              onClick={() => saveSettings({ jingleRatio: parseInt(form.jingleRatio, 10) })}
              disabled={busy || !ratioDirty}
            >
              Save · needs restart
            </Btn>
          </div>
          <div className="field-hint">
            1 jingle every N music tracks (current: {data.values?.jingleRatio}). Restart the mixer from the danger zone to apply.
          </div>
        </div>
      </Card>

      <Card title="Create jingle" sub="rendered via Piper TTS">
        <div className="field">
          <Label>Jingle text</Label>
          <Textarea
            rows={2}
            value={jingleText}
            onChange={e => setJingleText(e.target.value)}
            placeholder='e.g. "You are listening to SUB slash WAVE. Requests open all night."'
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <Btn tone="accent" onClick={createJingle} disabled={busy || !jingleText.trim()}>
              {busy ? 'Generating…' : 'Create jingle'}
            </Btn>
            <span style={{ color: 'var(--muted)', fontSize: 11 }}>
              {jingleText.length}/500 chars · Piper TTS
            </span>
          </div>
        </div>
      </Card>

      <Card title="Jingles" sub={`${data.jingles.length} file${data.jingles.length === 1 ? '' : 's'}`}>
        {data.jingles.length === 0 && (
          <div style={{ color: 'var(--muted)', fontStyle: 'italic', fontSize: 12, padding: '8px 0' }}>
            none yet
          </div>
        )}
        {data.jingles.map(j => (
          <div
            key={j.filename}
            style={{
              display: 'flex', alignItems: 'flex-start', gap: 12, padding: '12px 0',
              borderBottom: '1px dashed var(--separator-strong)',
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ color: 'var(--ink)', fontSize: 13, wordBreak: 'break-word' }}>{j.text}</div>
              <div style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                <span className="caption">{j.filename}</span>
                <span className="caption">{fmtSize(j.size)}</span>
                {j.createdAt && (
                  <span className="caption">{new Date(j.createdAt).toLocaleString('en-GB')}</span>
                )}
                {j.builtin && <Pill tone="accent">builtin</Pill>}
              </div>
            </div>
            <Btn
              sm
              tone="danger"
              onClick={() => onDelete(j.filename)}
              disabled={busy || j.builtin}
              title={j.builtin ? "Can't delete the built-in ident" : 'Delete this jingle'}
            >
              Delete
            </Btn>
          </div>
        ))}
      </Card>
    </>
  );
}
