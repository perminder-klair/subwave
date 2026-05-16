'use client';

// Personas editor — /admin/personas. The station's roster of DJ identities.
// One persona is "active" at a time (a scheduled Show can override which
// persona is on air for its hour). Each persona owns its name, tagline, talk
// frequency, soul, and full voice (TTS engine + cloud provider + voice).
// The system prompt is one global template shared by every persona.
// Everything POSTs to /settings and applies live — no mixer restart.
import { useEffect, useState } from 'react';
import { useAdminAuth } from '../../lib/adminAuth';
import { CLOUD_VOICES } from '../../lib/cloudVoices';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
import { Label } from '../ui/label';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem, SelectGroup,
} from '../ui/select';
import { Card, Btn, Pill, Eyebrow, Seg, Toggle } from './ui';

const FREQUENCIES = [
  { id: 'quiet',      label: 'Quiet',      desc: 'Talks every 8–20 tracks · station ID once an hour · weather hourly on change.' },
  { id: 'moderate',   label: 'Moderate',   desc: 'Talks every 1–9 tracks · station IDs at :15 and :45 · weather every 30 min on change.' },
  { id: 'aggressive', label: 'Aggressive', desc: 'Talks every 1–3 tracks · station IDs four times an hour · weather every 15 min on change.' },
];
const ENGINES = [
  { id: 'piper',  label: 'Piper' },
  { id: 'kokoro', label: 'Kokoro' },
  { id: 'cloud',  label: 'Cloud' },
];
const NAME_MAX = 40;
const TAGLINE_MAX = 80;
const SOUL_MAX = 400;
const PROMPT_MIN = 50;
const PROMPT_MAX = 4000;
const PERSONA_MAX = 12;
const KOKORO_RE = /^[a-z]{2}_[a-z0-9]+$/;

function clientMintId() {
  const b = crypto.getRandomValues(new Uint8Array(3));
  return 'p_' + [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}

function personaValid(p, defaultEngine) {
  if (p.name.trim().length < 1 || p.name.trim().length > NAME_MAX) return false;
  if (p.tagline.trim().length > TAGLINE_MAX) return false;
  if (p.soul.trim().length < 1 || p.soul.trim().length > SOUL_MAX) return false;
  const e = p.tts.engine;
  if (e === 'kokoro') return KOKORO_RE.test(p.tts.voice.trim());
  if (e === 'cloud') {
    const v = p.tts.voice.trim();
    return v.length >= 1 && v.length <= 100;
  }
  return true; // piper — voice ignored
}

// For a cloud persona: why (if at all) its cloud voice won't actually play —
// its provider's API key is missing. Returns a human sentence, or null when
// the cloud voice is good to go. A persona can look fully configured here yet
// still fall back silently; this surfaces that gap before it airs.
function cloudIssue(persona, data) {
  if (persona?.tts?.engine !== 'cloud') return null;
  const envKey = persona.tts.cloudProvider === 'elevenlabs'
    ? 'ELEVENLABS_API_KEY' : 'OPENAI_API_KEY';
  if (data?.env && !data.env[envKey]) {
    return `${envKey} is not set in controller/.env.`;
  }
  return null;
}

export default function PersonasPanel() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saveMsg, setSaveMsg] = useState(null);
  // index of the persona being edited in the right pane
  const [focusIdx, setFocusIdx] = useState(0);
  // toggles the system-prompt editor card
  const [showPrompt, setShowPrompt] = useState(false);

  const load = async () => {
    try {
      const r = await adminFetch('/settings');
      if (!r.ok) return null;
      const j = await r.json();
      setData(j); setErr(null);
      return j;
    } catch (e) { setErr(e.message); return null; }
  };

  useEffect(() => {
    if (!hydrated || needsAuth) return;
    (async () => {
      const j = await load();
      if (j?.values?.personas) {
        const v = j.values;
        const defaultPrompt = j.defaults?.djPrompt || '';
        const stored = v.djPrompt || '';
        const custom = stored !== '' && stored !== defaultPrompt;
        // Catalog of every skill. A persona with no stored `skills` (legacy /
        // code default) is treated as running all of them.
        const allSkills = (j.skills?.catalog || []).map(s => s.name);
        setForm({
          personas: v.personas.map(p => ({
            id: p.id,
            name: p.name ?? '',
            tagline: p.tagline ?? '',
            frequency: p.frequency ?? 'moderate',
            soul: p.soul ?? '',
            tts: {
              engine: p.tts?.engine ?? 'piper',
              cloudProvider: p.tts?.cloudProvider ?? 'openai',
              voice: p.tts?.voice ?? 'bf_isabella',
            },
            skills: Array.isArray(p.skills) ? p.skills : allSkills,
          })),
          activePersonaId: v.activePersonaId,
          useCustomPrompt: custom,
          systemPrompt: custom ? stored : defaultPrompt,
        });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, needsAuth]);

  // ── persona helpers ──────────────────────────────────────────────────────
  const setPersona = (i, patch) =>
    setForm(f => ({ ...f, personas: f.personas.map((p, idx) => (idx === i ? { ...p, ...patch } : p)) }));
  const setPersonaTts = (i, patch) =>
    setForm(f => ({ ...f, personas: f.personas.map((p, idx) => (idx === i ? { ...p, tts: { ...p.tts, ...patch } } : p)) }));
  const setPersonaSkills = (i, skills) =>
    setForm(f => ({ ...f, personas: f.personas.map((p, idx) => (idx === i ? { ...p, skills } : p)) }));
  const addPersona = () =>
    setForm(f => {
      if (f.personas.length >= PERSONA_MAX) return f;
      return {
        ...f,
        personas: [...f.personas, {
          id: clientMintId(), name: 'New persona', tagline: '',
          frequency: 'moderate', soul: '',
          tts: { engine: 'piper', cloudProvider: 'openai', voice: 'bf_isabella' },
          skills: (data?.skills?.catalog || []).map(s => s.name),
        }],
      };
    });
  const removePersona = (i) =>
    setForm(f => {
      if (f.personas.length <= 1) return f;
      const target = f.personas[i];
      const personas = f.personas.filter((_, idx) => idx !== i);
      // If the removed persona was active, fall back to the first remaining one.
      const activePersonaId = target.id === f.activePersonaId ? personas[0].id : f.activePersonaId;
      return { ...f, personas, activePersonaId };
    });

  // ── validation ───────────────────────────────────────────────────────────
  const promptText = form ? form.systemPrompt.trim() : '';
  const promptOk = !form?.useCustomPrompt
    || (promptText.length >= PROMPT_MIN && promptText.length <= PROMPT_MAX && promptText.includes('{name}'));
  const allPersonasOk = form ? form.personas.every(p => personaValid(p)) : false;
  const canSave = !!form && allPersonasOk && promptOk
    && form.personas.some(p => p.id === form.activePersonaId);

  const save = async () => {
    if (!canSave) return;
    setBusy(true); setSaveMsg(null);
    try {
      const r = await adminFetch('/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personas: form.personas.map(p => ({
            id: p.id,
            name: p.name.trim(),
            tagline: p.tagline.trim(),
            frequency: p.frequency,
            soul: p.soul.trim(),
            tts: {
              engine: p.tts.engine,
              cloudProvider: p.tts.cloudProvider,
              voice: p.tts.voice.trim() || 'bf_isabella',
            },
            skills: p.skills,
          })),
          activePersonaId: form.activePersonaId,
          djPrompt: form.useCustomPrompt ? form.systemPrompt.trim() : '',
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      setSaveMsg({ tone: 'ok', text: 'personas saved — applies on the next spoken line' });
      await load();
    } catch (e) {
      setSaveMsg({ tone: 'err', text: e.message });
    } finally { setBusy(false); }
  };

  const kokoroVoices = data?.tts?.kokoroVoices || [];
  const cloudProviders = data?.tts?.cloudProviders || ['openai', 'elevenlabs'];
  const skillCatalog = data?.skills?.catalog || [];

  if (err) {
    return (
      <div style={{ display: 'grid', gap: 16 }}>
        <Card title="Personas">
          <div style={{ color: 'var(--danger)', fontSize: 13 }}>controller error: {err}</div>
        </Card>
      </div>
    );
  }
  if (!form) {
    return (
      <div style={{ display: 'grid', gap: 16 }}>
        <Card title="Personas">
          <div style={{ color: 'var(--muted)', fontSize: 13, fontStyle: 'italic' }}>loading…</div>
        </Card>
      </div>
    );
  }

  // clamp focus to a valid index after add/remove
  const safeIdx = Math.min(focusIdx, form.personas.length - 1);
  const focused = form.personas[safeIdx];
  const activePersona = form.personas.find(p => p.id === form.activePersonaId);
  const focusedFreq = FREQUENCIES.find(f => f.id === focused.frequency);
  const focusedSoulLen = focused.soul.trim().length;
  const focusedSoulOver = focusedSoulLen > SOUL_MAX;
  const focusedOk = personaValid(focused);
  const focusedCloudIssue = cloudIssue(focused, data);
  const activeCloudIssue = activePersona ? cloudIssue(activePersona, data) : null;
  const defaultEngine = data?.values?.tts?.defaultEngine || 'piper';

  const engineLabel = (p) => {
    if (p.tts.engine === 'kokoro') return `kokoro / ${p.tts.voice.trim() || '—'}`;
    if (p.tts.engine === 'cloud') return `cloud / ${p.tts.cloudProvider} / ${p.tts.voice.trim() || '—'}`;
    return 'piper';
  };

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {/* ── HERO ─────────────────────────────────────────────────────────── */}
      <section className="card">
        <div style={{ padding: 16, borderBottom: '1px solid var(--ink)', display: 'grid', gridTemplateColumns: '1fr auto', gap: 16, alignItems: 'center' }}>
          <div>
            <Eyebrow color="var(--accent)">personas</Eyebrow>
            <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em', marginTop: 6 }}>
              The voices on your station.
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4, lineHeight: 1.6 }}>
              One persona is on air at a time. A scheduled show can hand the hour to a different one.
              Every change applies live; no mixer restart.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Btn onClick={() => setShowPrompt(s => !s)}>
              {showPrompt ? 'Hide system prompt' : 'System prompt'}
            </Btn>
            <Btn tone="accent" onClick={addPersona} disabled={form.personas.length >= PERSONA_MAX}>
              + Add persona
            </Btn>
          </div>
        </div>

        {/* Active strip */}
        <div style={{ padding: 14, display: 'flex', gap: 12, alignItems: 'center', background: 'var(--ink-softer)', flexWrap: 'wrap' }}>
          <span className="caption" style={{ color: 'var(--accent)' }}>● live</span>
          <span style={{ fontSize: 13, fontWeight: 700 }}>
            {activePersona ? (activePersona.name.trim() || 'Persona') : '—'}
          </span>
          {activePersona?.tagline.trim() && (
            <span style={{ fontSize: 11, color: 'var(--muted)' }}>— {activePersona.tagline.trim()}</span>
          )}
          <span className="caption" style={{ marginLeft: 16 }}>
            frequency · {activePersona ? activePersona.frequency : '—'}
          </span>
          <span className="caption">voice · {activePersona ? engineLabel(activePersona) : '—'}</span>
          {activeCloudIssue && (
            <span className="caption" style={{ color: 'var(--danger)' }}>
              ⚠ cloud voice inactive — speaking via {defaultEngine}
            </span>
          )}
          <span className="caption">override · — (a scheduled show may reassign the hour)</span>
        </div>
      </section>

      {/* ── SYSTEM PROMPT (folded-in feature, toggled from hero) ─────────── */}
      {showPrompt && (
        <Card title="System prompt" sub="shared by every persona">
          <p style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.6, marginBottom: 10 }}>
            One template wrapped around every DJ generation, shared by all personas.
            Placeholders: <code>{'{name}'}</code> · <code>{'{soul}'}</code> ·{' '}
            <code>{'{station}'}</code> · <code>{'{location}'}</code>. Most stations never touch this.
          </p>
          <Seg
            value={form.useCustomPrompt ? 'custom' : 'default'}
            options={[{ id: 'default', label: 'Built-in default' }, { id: 'custom', label: 'Custom' }]}
            onChange={v => setForm(f => ({ ...f, useCustomPrompt: v === 'custom' }))}
          />
          {!form.useCustomPrompt ? (
            <div style={{ marginTop: 12 }}>
              <div className="caption" style={{ marginBottom: 6 }}>the DJ uses this built-in template</div>
              <pre className="term" style={{ maxHeight: 220 }}>
                {data?.defaults?.djPrompt || '(default unavailable)'}
              </pre>
            </div>
          ) : (
            <div style={{ marginTop: 12 }}>
              <Textarea
                rows={12}
                value={form.systemPrompt}
                maxLength={PROMPT_MAX}
                onChange={e => setForm(f => ({ ...f, systemPrompt: e.target.value }))}
                style={{
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12,
                  borderColor: promptOk ? 'var(--ink)' : 'var(--danger)',
                }}
              />
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginTop: 10 }}>
                <Btn
                  onClick={() => setForm(f => ({ ...f, systemPrompt: data?.defaults?.djPrompt || '' }))}
                  disabled={busy || !data?.defaults?.djPrompt}
                >
                  Restore default text
                </Btn>
                <span className="caption" style={{ color: promptOk ? 'var(--muted)' : 'var(--danger)' }}>
                  {promptText.length}/{PROMPT_MAX} chars
                  {!promptText.includes('{name}') && ' · missing {name}'}
                  {promptText.length > 0 && promptText.length < PROMPT_MIN && ` · min ${PROMPT_MIN}`}
                </span>
              </div>
            </div>
          )}
        </Card>
      )}

      {/* ── 2-COL ───────────────────────────────────────────────────────── */}
      <div className="stack-mobile" style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 16, alignItems: 'flex-start' }}>
        {/* ROSTER */}
        <div style={{ display: 'grid', gap: 10 }}>
          <span className="caption">roster · {form.personas.length} / {PERSONA_MAX}</span>
          {form.personas.map((p, i) => {
            const isActive = p.id === form.activePersonaId;
            const isFocused = i === safeIdx;
            const valid = personaValid(p);
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setFocusIdx(i)}
                style={{
                  border: `1px solid ${isFocused ? 'var(--accent)' : 'var(--ink)'}`,
                  background: isFocused ? 'var(--card-bg)' : 'transparent',
                  padding: 12,
                  cursor: 'pointer',
                  textAlign: 'left',
                  display: 'grid', gap: 6,
                  outline: isFocused ? '2px solid var(--accent-soft)' : 'none',
                  outlineOffset: -4,
                  fontFamily: 'inherit',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {isActive && <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)' }} />}
                  <span style={{ fontSize: 14, fontWeight: 800, letterSpacing: '-0.01em', color: 'var(--ink)' }}>
                    {p.name.trim() || `Persona ${i + 1}`}
                  </span>
                  {isActive && <Pill tone="accent" style={{ fontSize: 8, marginLeft: 'auto' }}>on air</Pill>}
                </div>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                  {p.tagline.trim() || 'no tagline'}
                </div>
                <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
                  <Pill style={{ fontSize: 8 }}>{p.frequency}</Pill>
                  <Pill style={{ fontSize: 8 }}>{p.tts.engine}</Pill>
                  {p.tts.engine !== 'piper' && p.tts.voice.trim() && (
                    <Pill style={{ fontSize: 8 }}>{p.tts.voice.trim()}</Pill>
                  )}
                  <Pill style={{ fontSize: 8 }}>{p.skills.length} skill{p.skills.length === 1 ? '' : 's'}</Pill>
                  {!valid && <Pill style={{ fontSize: 8, color: 'var(--danger)', borderColor: 'var(--danger)' }}>incomplete</Pill>}
                </div>
              </button>
            );
          })}
          <button
            type="button"
            onClick={addPersona}
            disabled={form.personas.length >= PERSONA_MAX}
            style={{
              border: '1px dashed var(--muted)', background: 'transparent',
              padding: 12, cursor: form.personas.length >= PERSONA_MAX ? 'not-allowed' : 'pointer',
              color: 'var(--muted)', opacity: form.personas.length >= PERSONA_MAX ? 0.4 : 1,
              fontSize: 11, letterSpacing: '0.18em', textTransform: 'uppercase', fontWeight: 700,
              fontFamily: 'inherit',
            }}
          >
            {form.personas.length >= PERSONA_MAX ? `maximum ${PERSONA_MAX}` : '+ new persona'}
          </button>
        </div>

        {/* EDITOR */}
        <div style={{ display: 'grid', gap: 16 }}>
          <Card
            title={`Editing · ${focused.name.trim() || `Persona ${safeIdx + 1}`}`}
            sub={`persona ${safeIdx + 1} of ${form.personas.length}`}
            right={
              <>
                {focused.id === form.activePersonaId
                  ? <Pill tone="accent" style={{ fontSize: 8 }}>on air</Pill>
                  : <Btn sm onClick={() => setForm(f => ({ ...f, activePersonaId: focused.id }))}>Set on air</Btn>}
                <Btn
                  sm
                  tone="danger"
                  onClick={() => { removePersona(safeIdx); setFocusIdx(i => Math.max(0, i - 1)); }}
                  disabled={form.personas.length <= 1}
                  title={form.personas.length <= 1 ? 'At least one persona is required' : 'Remove this persona'}
                >
                  Remove
                </Btn>
              </>
            }
          >
            <div className="stack-mobile" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <div className="field">
                <Label>On-air name</Label>
                <Input
                  value={focused.name}
                  maxLength={NAME_MAX}
                  onChange={e => setPersona(safeIdx, { name: e.target.value })}
                  style={{ borderColor: focused.name.trim() ? 'var(--ink)' : 'var(--danger)' }}
                />
                <div className="field-hint">
                  Shown in the player and injected into every prompt as <code>{'{name}'}</code>.
                  <span style={{ marginLeft: 8, color: 'var(--muted)' }}>{focused.name.trim().length} / {NAME_MAX}</span>
                </div>
              </div>
              <div className="field">
                <Label>Tagline</Label>
                <Input
                  value={focused.tagline}
                  maxLength={TAGLINE_MAX}
                  placeholder="e.g. late-night drift"
                  onChange={e => setPersona(safeIdx, { tagline: e.target.value })}
                />
                <div className="field-hint">
                  A short line shown alongside the persona. Optional.
                  <span style={{ marginLeft: 8, color: 'var(--muted)' }}>{focused.tagline.trim().length} / {TAGLINE_MAX}</span>
                </div>
              </div>
            </div>

            <div className="rule-label">soul</div>

            <div className="field">
              <Textarea
                rows={7}
                value={focused.soul}
                placeholder="e.g. warm and dry, never corny — observant, favours one good image over a list"
                onChange={e => setPersona(safeIdx, { soul: e.target.value })}
                style={{ borderColor: focusedSoulOver || focusedSoulLen === 0 ? 'var(--danger)' : 'var(--ink)' }}
              />
              <div className="field-hint">
                One short personality sketch. Injected into the prompt as <code>{'{soul}'}</code>.
                <span style={{ marginLeft: 8, color: focusedSoulOver ? 'var(--danger)' : 'var(--muted)' }}>
                  {focusedSoulLen} / {SOUL_MAX}
                </span>
              </div>
            </div>

            <div className="rule-label">talk frequency</div>

            <div className="stack-mobile" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
              {FREQUENCIES.map(f => {
                const active = f.id === focused.frequency;
                return (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => setPersona(safeIdx, { frequency: f.id })}
                    style={{
                      border: `1px solid ${active ? 'var(--accent)' : 'var(--ink)'}`,
                      background: active ? 'var(--accent-soft)' : 'transparent',
                      padding: 12, cursor: 'pointer', textAlign: 'left',
                      display: 'grid', gap: 6, fontFamily: 'inherit',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{
                        width: 10, height: 10,
                        border: `1px solid ${active ? 'var(--accent)' : 'var(--ink)'}`,
                        borderRadius: '50%',
                        background: active ? 'var(--accent)' : 'transparent',
                      }} />
                      <span style={{ fontSize: 11, letterSpacing: '0.2em', textTransform: 'uppercase', fontWeight: 700, color: active ? 'var(--accent)' : 'var(--ink)' }}>
                        {f.label}
                      </span>
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--muted)', lineHeight: 1.5 }}>{f.desc}</div>
                  </button>
                );
              })}
            </div>
          </Card>

          <Card title="Voice" sub="text-to-speech engine">
            <div className="field" style={{ marginBottom: 14 }}>
              <Label>Engine</Label>
              <Seg
                value={focused.tts.engine}
                options={ENGINES}
                onChange={v => {
                  // Switching into cloud, seed a valid default voice if the
                  // current one isn't a known voice for the active provider.
                  const patch = { engine: v };
                  if (v === 'cloud') {
                    const provVoices = CLOUD_VOICES[focused.tts.cloudProvider] || [];
                    if (!provVoices.some(pv => pv.id === focused.tts.voice.trim())) {
                      patch.voice = provVoices[0]?.id || focused.tts.voice;
                    }
                  }
                  setPersonaTts(safeIdx, patch);
                }}
              />
              <div className="field-hint">
                Piper is local &amp; fast. Kokoro is more natural but slower. Cloud routes through OpenAI / ElevenLabs.
              </div>
            </div>

            {focused.tts.engine === 'piper' && (
              <div className="field-hint">
                Piper uses its built-in local voice — fast, keyless. No voice selection needed.
              </div>
            )}

            {focused.tts.engine === 'kokoro' && (
              <div className="field" style={{ maxWidth: 320 }}>
                <Label>Kokoro voice</Label>
                <Select
                  value={focused.tts.voice}
                  onValueChange={val => setPersonaTts(safeIdx, { voice: val })}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {!kokoroVoices.some(v => v.id === focused.tts.voice) && (
                        <SelectItem value={focused.tts.voice}>{focused.tts.voice}</SelectItem>
                      )}
                      {kokoroVoices.map(v => <SelectItem key={v.id} value={v.id}>{v.label}</SelectItem>)}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <div className="field-hint">The kokoro-onnx voice id for this persona.</div>
              </div>
            )}

            {focused.tts.engine === 'cloud' && (() => {
              const provVoices = CLOUD_VOICES[focused.tts.cloudProvider] || [];
              const voice = focused.tts.voice.trim();
              const isPreset = provVoices.some(v => v.id === voice);
              return (
                <>
                {focusedCloudIssue && (
                  <div style={{
                    marginBottom: 14, padding: '10px 12px',
                    border: '1px solid var(--danger)',
                    fontSize: 11, lineHeight: 1.6, color: 'var(--danger)',
                  }}>
                    <strong>This cloud voice won’t play.</strong> {focusedCloudIssue}{' '}
                    Until that’s fixed, this persona falls back to <strong>{defaultEngine}</strong>.
                  </div>
                )}
                <div className="stack-mobile" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                  <div className="field">
                    <Label>Cloud provider</Label>
                    <Seg
                      value={focused.tts.cloudProvider}
                      options={cloudProviders.map(id => ({ id, label: id }))}
                      onChange={v => {
                        // Switching provider invalidates the old voice id —
                        // default to the new provider's first curated voice.
                        const next = CLOUD_VOICES[v]?.[0]?.id || focused.tts.voice;
                        setPersonaTts(safeIdx, { cloudProvider: v, voice: next });
                      }}
                    />
                    <div className="field-hint">Uses the shared API key + model from Settings.</div>
                  </div>
                  <div className="field">
                    <Label>Cloud voice</Label>
                    <Select
                      value={isPreset ? voice : '__custom__'}
                      onValueChange={val => {
                        if (val !== '__custom__') {
                          setPersonaTts(safeIdx, { voice: val });
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
                        value={focused.tts.voice}
                        maxLength={100}
                        placeholder="Enter a custom voice id"
                        onChange={e => setPersonaTts(safeIdx, { voice: e.target.value })}
                      />
                    )}
                    <div className="field-hint">
                      Pick a default voice, or choose <em>Custom voice id…</em> to enter your own
                      (e.g. an OpenAI voice name or an ElevenLabs voice id).
                    </div>
                  </div>
                </div>
                </>
              );
            })()}
          </Card>

          <Card title="Skills" sub="autonomous segments this persona runs">
            <p style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.6, marginBottom: 10 }}>
              When this persona is on air, only the skills ticked here can fire. A skill must
              also be enabled station-wide on the <strong>Skills</strong> page.
            </p>
            {skillCatalog.length === 0 ? (
              <div style={{ color: 'var(--muted)', fontStyle: 'italic', fontSize: 12 }}>
                no skills available
              </div>
            ) : (
              <div style={{ display: 'grid', gap: 0 }}>
                {skillCatalog.map(s => {
                  const on = focused.skills.includes(s.name);
                  return (
                    <div
                      key={s.name}
                      style={{
                        display: 'grid', gridTemplateColumns: '1fr auto', gap: 16,
                        padding: '12px 0', alignItems: 'center',
                        borderBottom: '1px dashed var(--separator-strong)',
                      }}
                    >
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 700 }}>{s.label || s.name}</div>
                        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                          {s.description}
                        </div>
                      </div>
                      <Toggle
                        on={on}
                        onClick={() => setPersonaSkills(
                          safeIdx,
                          on
                            ? focused.skills.filter(n => n !== s.name)
                            : [...focused.skills, s.name],
                        )}
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          {/* Save bar */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 12,
            padding: 12, border: '1px solid var(--ink)',
            background: 'var(--ink-softer)', flexWrap: 'wrap',
          }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: canSave ? 'var(--accent)' : 'var(--danger)', flex: 'none' }} />
            <span style={{ fontSize: 11, color: 'var(--muted)' }}>
              {saveMsg
                ? <span style={{ color: saveMsg.tone === 'err' ? 'var(--danger)' : 'var(--accent)' }}>{saveMsg.text}</span>
                : !canSave && !focusedOk
                  ? <span style={{ color: 'var(--danger)' }}>this persona has a missing or invalid field</span>
                  : !canSave && !allPersonasOk
                    ? <span style={{ color: 'var(--danger)' }}>another persona in the roster is incomplete</span>
                    : !canSave && !promptOk
                      ? <span style={{ color: 'var(--danger)' }}>fix the custom system prompt</span>
                      : 'changes apply on the next spoken line · no mixer restart'}
            </span>
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              <Btn onClick={load} disabled={busy}>Discard</Btn>
              <Btn tone="accent" onClick={save} disabled={busy || !canSave}>
                {busy ? 'Saving…' : 'Save persona'}
              </Btn>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
