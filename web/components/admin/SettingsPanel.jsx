'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { fmtSize } from '../../lib/format';
import { useAdminAuth } from '../../lib/adminAuth';
import { V3AlertDialog } from '../ui/alert-dialog';
import { Card, Btn, Pill, Eyebrow, Seg, Metric } from './ui';

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

const SECTIONS = [
  { id: 'tts',     label: 'TTS voice', hint: 'engines per kind' },
  { id: 'llm',     label: 'LLM provider', hint: 'model routing' },
  { id: 'mixer',   label: 'Mixer', hint: 'crossfade · weather' },
  { id: 'jingles', label: 'Jingles', hint: 'stingers' },
];

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
    <div style={{ display: 'grid', gridTemplateColumns: '240px 1fr', gap: 24, alignItems: 'flex-start' }}>
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

/* Segmented engine picker built on the shared Seg primitive.
   value is an engine name, or null when allowDefault and "use default". */
function EngineSeg({ engines, available, value, onChange, allowDefault, defaultEngine }) {
  const options = [];
  if (allowDefault) options.push({ id: '__default__', label: `default · ${defaultEngine || 'piper'}` });
  for (const e of engines) options.push({ id: e, label: e });
  const selected = value == null ? '__default__' : value;

  // Seg renders every option; disable unavailable engines by intercepting onChange.
  return (
    <div className="seg accent" style={{ flexWrap: 'wrap' }}>
      {options.map(opt => {
        const isEngine = opt.id !== '__default__';
        const disabled = isEngine && available[opt.id] === false;
        return (
          <button
            key={opt.id}
            type="button"
            disabled={disabled}
            className={opt.id === selected ? 'active' : ''}
            onClick={() => onChange(opt.id === '__default__' ? null : opt.id)}
            title={disabled ? `${opt.id} is not installed in this build` : opt.label}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/* ── TTS ─────────────────────────────────────────────────────────────── */

function TtsSection({ data, form, setForm, busy, saveMsg, saveSettings }) {
  const engines = data.tts.engines || ['piper'];
  const available = data.tts.available || {};
  const kinds = data.tts.kinds || [];
  const hasCloud = engines.includes('cloud');

  const save = () => saveSettings({
    tts: {
      defaultEngine: form.tts.defaultEngine,
      byKind: form.tts.byKind,
      kokoro: { voice: form.tts.kokoro?.voice },
      cloud: {
        provider: form.tts.cloud.provider,
        model: form.tts.cloud.model,
        voice: form.tts.cloud.voice,
        // Only send the key when the operator typed one — an empty string
        // would otherwise clear the stored key.
        ...(form.tts.cloud.apiKey ? { apiKey: form.tts.cloud.apiKey } : {}),
      },
    },
  });

  return (
    <>
      <SectionHeader
        eyebrow="tts voice"
        title="Pick a voice engine for every kind of segment."
        sub={<>
          Piper is fast and CPU-cheap. Kokoro is more natural but 3–5× slower per line.
          Cloud routes through OpenAI or ElevenLabs. Failures fall back to Piper.
          {available.kokoro === false && (
            <span style={{ color: 'var(--danger)' }}> Kokoro is unavailable in this build.</span>
          )}
        </>}
        metrics={[
          { n: String(kinds.length), l: 'kinds' },
          { n: String(engines.length), l: 'engines', accent: true },
        ]}
      />

      {/* Defaults */}
      <Card title="Defaults">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 18 }}>
          <div className="field">
            <label className="field-label">Default engine</label>
            <EngineSeg
              engines={engines}
              available={available}
              value={form.tts.defaultEngine}
              onChange={v => setForm(f => ({ ...f, tts: { ...f.tts, defaultEngine: v || 'piper' } }))}
              allowDefault={false}
            />
            <div className="field-hint">Used for any kind below set to “default”.</div>
          </div>
          {(data.tts.kokoroVoices?.length || 0) > 0 && (
            <div className="field">
              <label className="field-label">Kokoro voice</label>
              <select
                className="select"
                value={form.tts.kokoro?.voice ?? 'bf_isabella'}
                onChange={e => setForm(f => ({
                  ...f, tts: { ...f.tts, kokoro: { ...f.tts.kokoro, voice: e.target.value } },
                }))}
              >
                {data.tts.kokoroVoices.map(v => (
                  <option key={v.id} value={v.id}>{v.label} — {v.id}</option>
                ))}
              </select>
              <div className="field-hint">British English only. Applies to every kind routed through Kokoro.</div>
            </div>
          )}
        </div>
      </Card>

      {/* By kind */}
      <Card title="Engine by kind" sub={`${kinds.length} segment types`}>
        <div style={{ display: 'grid', gap: 0 }}>
          {kinds.map(k => (
            <div
              key={k}
              style={{
                display: 'grid', gridTemplateColumns: '1fr auto', gap: 16,
                padding: '14px 0', alignItems: 'center',
                borderBottom: '1px dashed var(--separator-strong)',
              }}
            >
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: '-0.005em' }}>
                  {TTS_KIND_LABEL[k] || k}
                </div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                  {TTS_KIND_HINT[k]}
                </div>
              </div>
              <EngineSeg
                engines={engines}
                available={available}
                value={form.tts.byKind?.[k] ?? null}
                onChange={v => setForm(f => ({
                  ...f, tts: { ...f.tts, byKind: { ...f.tts.byKind, [k]: v } },
                }))}
                allowDefault
                defaultEngine={form.tts.defaultEngine}
              />
            </div>
          ))}
        </div>
      </Card>

      {/* Cloud engine */}
      {hasCloud && (
        <Card title="Cloud engine" sub="optional · routes to OpenAI / ElevenLabs">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 18 }}>
            <div className="field">
              <label className="field-label">Provider</label>
              <Seg
                accent
                value={form.tts.cloud.provider}
                options={(data.tts.cloudProviders || ['openai', 'elevenlabs']).map(p => ({ id: p, label: p }))}
                onChange={v => setForm(f => ({ ...f, tts: { ...f.tts, cloud: { ...f.tts.cloud, provider: v } } }))}
              />
            </div>
            <div className="field">
              <label className="field-label">Model</label>
              <input
                className="input"
                value={form.tts.cloud.model}
                onChange={e => setForm(f => ({ ...f, tts: { ...f.tts, cloud: { ...f.tts.cloud, model: e.target.value } } }))}
                placeholder="gpt-4o-mini-tts"
              />
              <div className="field-hint">e.g. “gpt-4o-mini-tts” (OpenAI) or “eleven_flash_v2_5” (ElevenLabs).</div>
            </div>
            <div className="field">
              <label className="field-label">Default voice</label>
              <input
                className="input"
                value={form.tts.cloud.voice}
                onChange={e => setForm(f => ({ ...f, tts: { ...f.tts, cloud: { ...f.tts.cloud, voice: e.target.value } } }))}
                placeholder="alloy"
              />
              <div className="field-hint">OpenAI: alloy, nova, … — ElevenLabs: a voice ID.</div>
            </div>
          </div>
          <div className="field" style={{ marginTop: 14 }}>
            <label className="field-label">API key</label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                className="input"
                type="password"
                value={form.tts.cloud.apiKey}
                onChange={e => setForm(f => ({ ...f, tts: { ...f.tts, cloud: { ...f.tts.cloud, apiKey: e.target.value } } }))}
                placeholder={form.tts.cloud.apiKeySet ? '•••••••• (set)' : 'paste key'}
                style={{ flex: 1, minWidth: 240, maxWidth: 360 }}
              />
              {form.tts.cloud.apiKeySet && <Pill tone="accent" dot>set</Pill>}
            </div>
            <div className="field-hint">
              {form.tts.cloud.apiKeySet
                ? 'A key is set. Leave blank to keep it; type to replace.'
                : 'Or set OPENAI_API_KEY / ELEVENLABS_API_KEY in the environment.'}
            </div>
          </div>
        </Card>
      )}

      <SaveBar
        note="Applies to the next spoken segment · no mixer restart. Jingle changes only affect newly generated jingles."
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
      pickerAgent: form.llm.pickerAgent,
      // Only send the key when the operator typed one.
      ...(form.llm.apiKey ? { apiKey: form.llm.apiKey } : {}),
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
            <label className="field-label">Provider</label>
            <Seg
              accent
              value={form.llm.provider}
              options={(data.llm.providers || ['ollama']).map(p => ({ id: p, label: p }))}
              onChange={v => setForm(f => ({ ...f, llm: { ...f.llm, provider: v } }))}
            />
          </div>

          <div className="field">
            <label className="field-label">Model</label>
            <input
              className="input"
              value={form.llm.model}
              onChange={e => setForm(f => ({ ...f, llm: { ...f.llm, model: e.target.value } }))}
              placeholder={form.llm.provider === 'ollama' ? '(OLLAMA_MODEL default)' : 'model id'}
              style={{ maxWidth: 360 }}
            />
            <div className="field-hint">
              {form.llm.provider === 'ollama'
                ? 'Leave blank to use the OLLAMA_MODEL default.'
                : form.llm.provider === 'gateway'
                  ? 'Gateway model id, e.g. “anthropic/claude-sonnet-4-5”.'
                  : 'Model id for the chosen provider — required.'}
            </div>
          </div>

          {form.llm.provider !== 'ollama' && (
            <div className="field">
              <label className="field-label">API key</label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <input
                  className="input"
                  type="password"
                  value={form.llm.apiKey}
                  onChange={e => setForm(f => ({ ...f, llm: { ...f.llm, apiKey: e.target.value } }))}
                  placeholder={form.llm.apiKeySet ? '•••••••• (set)' : 'paste key'}
                  style={{ flex: 1, minWidth: 240, maxWidth: 360 }}
                />
                {form.llm.apiKeySet && <Pill tone="accent" dot>set</Pill>}
              </div>
              <div className="field-hint">
                {form.llm.apiKeySet
                  ? 'A key is set. Leave blank to keep it; type to replace.'
                  : 'Or set the provider env var (ANTHROPIC_API_KEY / OPENAI_API_KEY / AI_GATEWAY_API_KEY).'}
              </div>
            </div>
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
        title="Crossfade and the DJ’s weather context."
        sub="Crossfade overlap shapes every track transition. Weather location drives the Open-Meteo lookups the DJ reads on air."
        metrics={[
          { n: `${data.values?.crossfadeDuration}s`, l: 'crossfade', accent: true },
        ]}
      />

      <Card title="Crossfade" sub="track transition overlap">
        <div className="field">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <label className="field-label">Crossfade duration</label>
            <Pill tone="ink">restart required</Pill>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              className="input mono-num"
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

      <Card title="Weather location" sub="Open-Meteo + DJ context">
        <div className="field">
          <label className="field-label">Location</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <input
              className="input"
              placeholder="name"
              value={form.weather.locationName}
              onChange={e => setForm(f => ({ ...f, weather: { ...f.weather, locationName: e.target.value } }))}
              style={{ width: 200 }}
            />
            <input
              className="input mono-num"
              type="number"
              step="any"
              placeholder="lat"
              value={form.weather.lat}
              onChange={e => setForm(f => ({ ...f, weather: { ...f.weather, lat: e.target.value } }))}
              style={{ width: 132 }}
            />
            <input
              className="input mono-num"
              type="number"
              step="any"
              placeholder="lng"
              value={form.weather.lng}
              onChange={e => setForm(f => ({ ...f, weather: { ...f.weather, lng: e.target.value } }))}
              style={{ width: 132 }}
            />
          </div>
          <div className="field-hint">
            Used for DJ context + Open-Meteo lookups (current: {data.values?.weather?.locationName} @ {data.values?.weather?.lat}, {data.values?.weather?.lng}). Applies live.
          </div>
        </div>
      </Card>

      <SaveBar
        note="Weather location applies live · Crossfade requires a mixer restart (danger zone)."
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
            <label className="field-label">Jingle ratio</label>
            <Pill tone="ink">restart required</Pill>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <input
              className="input mono-num"
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
          <label className="field-label">Jingle text</label>
          <textarea
            className="textarea"
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
