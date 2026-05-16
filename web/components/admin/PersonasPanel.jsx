'use client';

// Personas editor — /admin/personas. The station's roster of DJ identities.
// One persona is "active" at a time (a scheduled Show can override which
// persona is on air for its hour). Each persona owns its name, tagline, talk
// frequency, soul, and full voice (TTS engine + cloud provider + voice).
// The system prompt is one global template shared by every persona.
// Everything POSTs to /settings and applies live — no mixer restart.
import { useEffect, useState } from 'react';
import { useAdminAuth } from '../../lib/adminAuth';

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

const textareaStyle = {
  boxSizing: 'border-box', width: '100%',
  border: '1px solid var(--ink)', background: 'transparent',
  padding: 10, fontSize: 13, fontFamily: 'inherit', color: 'var(--ink)',
  resize: 'vertical', lineHeight: 1.5,
};
const inputStyle = {
  boxSizing: 'border-box', border: '1px solid var(--ink)',
  background: 'transparent', padding: '8px 12px', fontSize: 14,
  fontFamily: 'inherit', color: 'var(--ink)', outline: 'none',
};

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

export default function PersonasPanel() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saveMsg, setSaveMsg] = useState(null);

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
  const addPersona = () =>
    setForm(f => {
      if (f.personas.length >= PERSONA_MAX) return f;
      return {
        ...f,
        personas: [...f.personas, {
          id: clientMintId(), name: 'New persona', tagline: '',
          frequency: 'moderate', soul: '',
          tts: { engine: 'piper', cloudProvider: 'openai', voice: 'bf_isabella' },
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

  return (
    <div className="space-y-4">
      <p style={{ color: 'var(--muted)', fontSize: 13, lineHeight: 1.6 }}>
        The station&apos;s DJ roster. One persona is on air at a time — pick it below.
        A scheduled <strong>Show</strong> can hand the hour to a different persona.
        Every change applies live; no mixer restart.
      </p>

      {err && <Alert tone="err">controller error: {err}</Alert>}
      {!form && !err && <div style={{ color: 'var(--muted)' }} className="italic">loading…</div>}

      {form && (
        <>
          {/* ── ACTIVE PERSONA ───────────────────────────────────────── */}
          <Section title="Active persona">
            <p style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.6, marginBottom: 4 }}>
              The persona on air right now, unless a Show overrides it for the current hour.
            </p>
            <div className="flex flex-col gap-1.5">
              {form.personas.map((p, i) => {
                const active = p.id === form.activePersonaId;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setForm(f => ({ ...f, activePersonaId: p.id }))}
                    className="v3-focus cursor-pointer text-left"
                    style={{
                      border: `1px solid ${active ? 'var(--accent)' : 'var(--ink)'}`,
                      background: active ? 'var(--accent)' : 'transparent',
                      color: active ? '#fff' : 'var(--ink)',
                      padding: '8px 12px', fontSize: 13,
                    }}
                  >
                    {active ? '● ' : '○ '}{p.name.trim() || `Persona ${i + 1}`}
                    {p.tagline.trim() && (
                      <span style={{ opacity: 0.75, marginLeft: 8, fontSize: 12 }}>
                        — {p.tagline.trim()}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </Section>

          {/* ── PERSONA CARDS ────────────────────────────────────────── */}
          {form.personas.map((p, i) => {
            const freq = FREQUENCIES.find(f => f.id === p.frequency);
            const soulLen = p.soul.trim().length;
            const soulOver = soulLen > SOUL_MAX;
            const ok = personaValid(p);
            return (
              <Section
                key={p.id}
                title={`Persona ${i + 1}`}
                extra={
                  <div className="flex items-center gap-3">
                    {p.id === form.activePersonaId && (
                      <span className="v3-caption" style={{ color: 'var(--accent)' }}>active</span>
                    )}
                    <button
                      type="button"
                      onClick={() => removePersona(i)}
                      disabled={form.personas.length <= 1}
                      title={form.personas.length <= 1 ? 'At least one persona is required' : 'Remove this persona'}
                      className="v3-focus cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                      style={{ border: '1px solid var(--ink)', background: 'transparent', color: 'var(--ink)', padding: '3px 9px', fontSize: 12, lineHeight: 1 }}
                    >
                      ✕
                    </button>
                  </div>
                }
              >
                <Field label="Name" hint="Shown in the player and injected into every prompt as the DJ's on-air name.">
                  <input
                    type="text" value={p.name} maxLength={NAME_MAX}
                    onChange={e => setPersona(i, { name: e.target.value })}
                    className="v3-focus"
                    style={{ ...inputStyle, width: 280, border: `1px solid ${p.name.trim() ? 'var(--ink)' : '#c5302a'}` }}
                  />
                  <span className="v3-caption" style={{ color: 'var(--muted)', marginLeft: 10 }}>
                    {p.name.trim().length}/{NAME_MAX}
                  </span>
                </Field>

                <Field label="Tagline" hint="A short line shown alongside the persona. Optional.">
                  <input
                    type="text" value={p.tagline} maxLength={TAGLINE_MAX}
                    onChange={e => setPersona(i, { tagline: e.target.value })}
                    className="v3-focus" placeholder="e.g. late-night drift"
                    style={{ ...inputStyle, width: 280 }}
                  />
                  <span className="v3-caption" style={{ color: 'var(--muted)', marginLeft: 10 }}>
                    {p.tagline.trim().length}/{TAGLINE_MAX}
                  </span>
                </Field>

                <Field label="Talk frequency" hint="How often this persona speaks between tracks and at the top of the hour.">
                  <Segmented value={p.frequency} options={FREQUENCIES} onChange={v => setPersona(i, { frequency: v })} />
                </Field>
                {freq && (
                  <div style={{ borderLeft: '2px solid var(--accent)', paddingLeft: 12, color: 'var(--muted)', fontSize: 12, lineHeight: 1.6 }}>
                    {freq.desc}
                  </div>
                )}

                <Field label="Soul" hint="One short personality sketch. Injected into the prompt as {soul}.">
                  <div className="w-full">
                    <textarea
                      rows={2} value={p.soul}
                      onChange={e => setPersona(i, { soul: e.target.value })}
                      placeholder="e.g. warm and dry, never corny — observant, favours one good image over a list"
                      className="v3-focus"
                      style={{ ...textareaStyle, border: `1px solid ${soulOver || soulLen === 0 ? '#c5302a' : 'var(--ink)'}` }}
                    />
                    <div className="v3-caption" style={{ color: soulOver ? '#c5302a' : 'var(--muted)', marginTop: 2 }}>
                      {soulLen}/{SOUL_MAX}
                    </div>
                  </div>
                </Field>

                {/* ── VOICE ── */}
                <div style={{ borderTop: '1px dashed var(--separator-strong)', paddingTop: 12 }}>
                  <Field label="Voice engine" hint="Cloud uses the shared API key + model from Settings; provider and voice are per-persona.">
                    <Segmented value={p.tts.engine} options={ENGINES} onChange={v => setPersonaTts(i, { engine: v })} />
                  </Field>

                  {p.tts.engine === 'piper' && (
                    <div className="v3-caption" style={{ color: 'var(--muted)' }}>
                      Piper uses its built-in local voice — fast, keyless.
                    </div>
                  )}
                  {p.tts.engine === 'kokoro' && (
                    <Field label="Kokoro voice" hint="">
                      <select
                        value={p.tts.voice}
                        onChange={e => setPersonaTts(i, { voice: e.target.value })}
                        className="v3-focus"
                        style={{ ...inputStyle, width: 240 }}
                      >
                        {!kokoroVoices.some(v => v.id === p.tts.voice) && (
                          <option value={p.tts.voice}>{p.tts.voice}</option>
                        )}
                        {kokoroVoices.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}
                      </select>
                    </Field>
                  )}
                  {p.tts.engine === 'cloud' && (
                    <>
                      <Field label="Cloud provider" hint="">
                        <Segmented
                          value={p.tts.cloudProvider}
                          options={cloudProviders.map(id => ({ id, label: id }))}
                          onChange={v => setPersonaTts(i, { cloudProvider: v })}
                        />
                      </Field>
                      <Field label="Cloud voice" hint="The voice id for the chosen provider, e.g. 'alloy' (OpenAI) or an ElevenLabs voice id.">
                        <input
                          type="text" value={p.tts.voice} maxLength={100}
                          onChange={e => setPersonaTts(i, { voice: e.target.value })}
                          className="v3-focus"
                          style={{ ...inputStyle, width: 240, border: `1px solid ${p.tts.voice.trim() ? 'var(--ink)' : '#c5302a'}` }}
                        />
                      </Field>
                    </>
                  )}
                </div>

                {!ok && (
                  <div className="v3-caption" style={{ color: '#c5302a' }}>
                    this persona has a missing or invalid field
                  </div>
                )}
              </Section>
            );
          })}

          <div className="flex items-center gap-2">
            <OutlineButton onClick={addPersona} disabled={form.personas.length >= PERSONA_MAX}>
              + add persona
            </OutlineButton>
            {form.personas.length >= PERSONA_MAX && (
              <span className="v3-caption" style={{ color: 'var(--muted)' }}>maximum {PERSONA_MAX}</span>
            )}
          </div>

          {/* ── SYSTEM PROMPT ────────────────────────────────────────── */}
          <Section title="System prompt">
            <p style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.6, marginBottom: 6 }}>
              One template wrapped around every DJ generation, shared by all personas.
              Placeholders: <code>{'{name}'}</code> · <code>{'{soul}'}</code> ·{' '}
              <code>{'{station}'}</code> · <code>{'{location}'}</code>. Most stations never touch this.
            </p>
            <Segmented
              value={form.useCustomPrompt ? 'custom' : 'default'}
              options={[{ id: 'default', label: 'Built-in default' }, { id: 'custom', label: 'Custom' }]}
              onChange={v => setForm(f => ({ ...f, useCustomPrompt: v === 'custom' }))}
            />
            {!form.useCustomPrompt ? (
              <div className="mt-3">
                <div className="v3-caption mb-1" style={{ color: 'var(--muted)' }}>the DJ uses this built-in template</div>
                <pre
                  className="v3-scroll"
                  style={{ ...textareaStyle, color: 'var(--muted)', maxHeight: 220, overflowY: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12 }}
                >
                  {data?.defaults?.djPrompt || '(default unavailable)'}
                </pre>
              </div>
            ) : (
              <div className="mt-3">
                <textarea
                  rows={12} value={form.systemPrompt} maxLength={PROMPT_MAX}
                  onChange={e => setForm(f => ({ ...f, systemPrompt: e.target.value }))}
                  className="v3-focus"
                  style={{ ...textareaStyle, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, border: `1px solid ${promptOk ? 'var(--ink)' : '#c5302a'}` }}
                />
                <div className="flex flex-wrap items-center gap-3 mt-2">
                  <OutlineButton
                    onClick={() => setForm(f => ({ ...f, systemPrompt: data?.defaults?.djPrompt || '' }))}
                    disabled={busy || !data?.defaults?.djPrompt}
                  >
                    restore default text
                  </OutlineButton>
                  <span className="v3-caption" style={{ color: promptOk ? 'var(--muted)' : '#c5302a' }}>
                    {promptText.length}/{PROMPT_MAX} chars
                    {!promptText.includes('{name}') && ' · missing {name}'}
                    {promptText.length > 0 && promptText.length < PROMPT_MIN && ` · min ${PROMPT_MIN}`}
                  </span>
                </div>
              </div>
            )}
          </Section>

          {/* ── SAVE ─────────────────────────────────────────────────── */}
          <div className="flex flex-wrap items-center gap-3" style={{ paddingTop: 4 }}>
            <SolidButton onClick={save} disabled={busy || !canSave}>
              {busy ? 'saving…' : 'save personas'}
            </SolidButton>
            {!canSave && !busy && (
              <span className="v3-caption" style={{ color: '#c5302a' }}>
                {allPersonasOk ? '' : 'fix the highlighted persona · '}
                {promptOk ? '' : 'fix the custom prompt'}
              </span>
            )}
            {saveMsg && (
              <span style={{ fontSize: 12, color: saveMsg.tone === 'err' ? '#c5302a' : 'var(--accent)' }}>
                {saveMsg.text}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Section({ title, extra, children }) {
  return (
    <section style={{ border: '1px solid var(--ink)' }}>
      <div className="flex items-center justify-between px-4 py-2" style={{ borderBottom: '1px solid var(--ink)' }}>
        <span className="v3-eyebrow" style={{ fontSize: 11 }}>{title}</span>
        {extra}
      </div>
      <div className="p-5 space-y-3">{children}</div>
    </section>
  );
}
function Field({ label, hint, children }) {
  return (
    <div className="space-y-1.5">
      <span style={{ color: 'var(--ink)', fontSize: 14, fontWeight: 600 }}>{label}</span>
      {hint && <div style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.5 }}>{hint}</div>}
      <div className="flex items-center flex-wrap gap-2 pt-0.5">{children}</div>
    </div>
  );
}
function Segmented({ value, options, onChange }) {
  return (
    <div style={{ display: 'inline-flex', border: '1px solid var(--ink)', flexWrap: 'wrap' }}>
      {options.map((o, i) => {
        const active = value === o.id;
        return (
          <button
            key={o.id} type="button" onClick={() => onChange(o.id)}
            className="v3-eyebrow v3-focus cursor-pointer"
            style={{
              background: active ? 'var(--ink)' : 'transparent',
              color: active ? 'var(--bg)' : 'var(--ink)',
              border: 'none', borderLeft: i === 0 ? 'none' : '1px solid var(--ink)',
              padding: '8px 14px', fontSize: 10,
            }}
            aria-pressed={active}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
function SolidButton({ onClick, disabled, children }) {
  return (
    <button
      onClick={onClick} disabled={disabled}
      className="v3-eyebrow v3-focus cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
      style={{ background: 'var(--accent)', color: '#fff', border: 'none', padding: '8px 16px', fontSize: 10 }}
    >
      {children}
    </button>
  );
}
function OutlineButton({ onClick, disabled, children }) {
  return (
    <button
      type="button" onClick={onClick} disabled={disabled}
      className="v3-eyebrow v3-focus cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed shrink-0"
      style={{ background: 'transparent', color: 'var(--ink)', border: '1px solid var(--ink)', padding: '5px 11px', fontSize: 10 }}
    >
      {children}
    </button>
  );
}
function Alert({ tone, children }) {
  return (
    <div style={{ border: `1px solid ${tone === 'err' ? '#c5302a' : 'var(--ink)'}`, color: tone === 'err' ? '#c5302a' : 'var(--ink)', padding: '8px 12px', fontSize: 13 }}>
      {children}
    </div>
  );
}
