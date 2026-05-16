'use client';

// DJ persona editor — /admin/persona. The DJ's on-air identity: name, talk
// frequency, the rotating "souls" the DJ shifts between, and (advanced) the
// system-prompt template. Everything POSTs to /settings under `dj` and
// applies live — no mixer restart.
import { useEffect, useState } from 'react';
import { useAdminAuth } from '../../lib/adminAuth';
import { V3Alert } from '../ui/alert';

const FREQUENCIES = [
  { id: 'quiet',      label: 'Quiet',      desc: 'Talks every 8–20 tracks · station ID once an hour · weather hourly on change.' },
  { id: 'moderate',   label: 'Moderate',   desc: 'Talks every 1–9 tracks · station IDs at :15 and :45 · weather every 30 min on change.' },
  { id: 'aggressive', label: 'Aggressive', desc: 'Talks every 1–3 tracks · station IDs four times an hour · weather every 15 min on change.' },
];
const NAME_MAX = 40;
const SOULS_MAX = 10;
const SOUL_MAX_CHARS = 400;
const PROMPT_MIN = 50;
const PROMPT_MAX = 4000;

const textareaStyle = {
  boxSizing: 'border-box',
  width: '100%',
  border: '1px solid var(--ink)',
  background: 'transparent',
  padding: 10,
  fontSize: 13,
  fontFamily: 'inherit',
  color: 'var(--ink)',
  resize: 'vertical',
  lineHeight: 1.5,
};

export default function PersonaPanel() {
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

  // Fetch once on mount — the form has no live data to poll, and a poll would
  // risk clobbering unsaved edits.
  useEffect(() => {
    if (!hydrated || needsAuth) return;
    (async () => {
      const j = await load();
      if (j?.values?.dj) {
        const dj = j.values.dj;
        const defaultPrompt = j.defaults?.dj?.systemPrompt || '';
        const stored = dj.systemPrompt || '';
        // "Custom" only when the stored prompt is non-empty AND differs from
        // the built-in default — an empty or default-equal value is "default".
        const custom = stored !== '' && stored !== defaultPrompt;
        setForm({
          name: dj.name ?? '',
          frequency: dj.frequency ?? 'moderate',
          souls: Array.isArray(dj.souls) && dj.souls.length ? [...dj.souls] : [''],
          useCustomPrompt: custom,
          systemPrompt: custom ? stored : defaultPrompt,
        });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, needsAuth]);

  // ── souls list helpers ──────────────────────────────────────────────────
  const setSoul = (i, v) =>
    setForm(f => ({ ...f, souls: f.souls.map((s, idx) => (idx === i ? v : s)) }));
  const addSoul = () =>
    setForm(f => (f.souls.length >= SOULS_MAX ? f : { ...f, souls: [...f.souls, ''] }));
  const removeSoul = (i) =>
    setForm(f => (f.souls.length <= 1 ? f : { ...f, souls: f.souls.filter((_, idx) => idx !== i) }));
  const resetSouls = () =>
    setForm(f => ({
      ...f,
      souls: Array.isArray(data?.defaults?.dj?.souls) ? [...data.defaults.dj.souls] : f.souls,
    }));

  // ── validation ──────────────────────────────────────────────────────────
  const cleanSouls = form ? form.souls.map(s => s.trim()).filter(Boolean) : [];
  const promptText = form ? form.systemPrompt.trim() : '';
  const promptOk = !form?.useCustomPrompt
    || (promptText.length >= PROMPT_MIN && promptText.length <= PROMPT_MAX && promptText.includes('{name}'));
  const canSave = !!form && form.name.trim().length > 0 && cleanSouls.length > 0 && promptOk;

  const save = async () => {
    if (!canSave) return;
    setBusy(true); setSaveMsg(null);
    try {
      const r = await adminFetch('/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dj: {
            name: form.name.trim(),
            souls: cleanSouls,
            frequency: form.frequency,
            // Empty string = use the built-in default template.
            systemPrompt: form.useCustomPrompt ? form.systemPrompt.trim() : '',
          },
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      setSaveMsg({ tone: 'ok', text: 'persona saved — applies on the next spoken line' });
      await load();
    } catch (e) {
      setSaveMsg({ tone: 'err', text: e.message });
    } finally { setBusy(false); }
  };

  const activeFreq = FREQUENCIES.find(f => f.id === form?.frequency);

  return (
    <div className="space-y-4">
      <p style={{ color: 'var(--muted)', fontSize: 13, lineHeight: 1.6 }}>
        The DJ&apos;s on-air identity. Every change here applies live — the next
        intro, link, or station ID picks it up. No mixer restart needed.
      </p>

      {err && <V3Alert tone="error" title="controller error">{err}</V3Alert>}
      {!form && !err && <div style={{ color: 'var(--muted)' }} className="italic">loading…</div>}

      {form && (
        <>
          {/* ── IDENTITY ─────────────────────────────────────────────── */}
          <Section title="Identity">
            <Field
              label="DJ name"
              hint="Shown in the player TopBar and injected into every prompt as the DJ's on-air name."
            >
              <input
                type="text"
                value={form.name}
                maxLength={NAME_MAX}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                className="v3-focus"
                style={{
                  boxSizing: 'border-box', width: 280,
                  border: `1px solid ${form.name.trim() ? 'var(--ink)' : '#c5302a'}`,
                  background: 'transparent', padding: '8px 12px',
                  fontSize: 14, fontFamily: 'inherit', color: 'var(--ink)', outline: 'none',
                }}
              />
              <span className="v3-caption" style={{ color: 'var(--muted)', marginLeft: 10 }}>
                {form.name.trim().length}/{NAME_MAX}
              </span>
            </Field>

            <Field
              label="Talk frequency"
              hint="How often the DJ speaks between tracks and at the top of each hour. Music selection is unaffected."
            >
              <Segmented
                value={form.frequency}
                options={FREQUENCIES}
                onChange={v => setForm(f => ({ ...f, frequency: v }))}
              />
            </Field>
            {activeFreq && (
              <div
                className="mt-1"
                style={{
                  borderLeft: '2px solid var(--accent)', paddingLeft: 12,
                  color: 'var(--muted)', fontSize: 12, lineHeight: 1.6,
                }}
              >
                {activeFreq.desc}
              </div>
            )}
          </Section>

          {/* ── SOULS ────────────────────────────────────────────────── */}
          <Section
            title="Souls"
            extra={
              <span className="v3-caption" style={{ color: cleanSouls.length ? 'var(--muted)' : '#c5302a' }}>
                {cleanSouls.length} / {SOULS_MAX}
              </span>
            }
          >
            <p style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.6, marginBottom: 4 }}>
              Each soul is one short personality. The DJ picks one at random per spoken line,
              so 3–6 distinct souls keep back-to-back segments from sounding the same. Injected
              into the prompt as <code>{'{soul}'}</code>.
            </p>

            <div className="space-y-3">
              {form.souls.map((soul, i) => {
                const len = soul.trim().length;
                const over = len > SOUL_MAX_CHARS;
                return (
                  <div key={i} className="flex gap-2 items-start">
                    <span
                      className="v3-tab-num shrink-0"
                      style={{ color: 'var(--muted)', width: 22, paddingTop: 9, fontSize: 12 }}
                    >
                      {i + 1}
                    </span>
                    <div className="flex-1 min-w-0">
                      <textarea
                        rows={2}
                        value={soul}
                        onChange={e => setSoul(i, e.target.value)}
                        placeholder="e.g. warm and dry, never corny — observant, favours one good image over a list"
                        className="v3-focus"
                        style={{
                          ...textareaStyle,
                          border: `1px solid ${over ? '#c5302a' : 'var(--ink)'}`,
                        }}
                      />
                      <div className="v3-caption" style={{ color: over ? '#c5302a' : 'var(--muted)', marginTop: 2 }}>
                        {len}/{SOUL_MAX_CHARS}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeSoul(i)}
                      disabled={form.souls.length <= 1}
                      title={form.souls.length <= 1 ? 'At least one soul is required' : 'Remove this soul'}
                      className="v3-focus cursor-pointer shrink-0 disabled:opacity-30 disabled:cursor-not-allowed"
                      style={{
                        border: '1px solid var(--ink)', background: 'transparent',
                        color: 'var(--ink)', padding: '7px 11px', fontSize: 13, lineHeight: 1,
                      }}
                    >
                      ✕
                    </button>
                  </div>
                );
              })}
            </div>

            <div className="flex flex-wrap items-center gap-2 mt-3">
              <OutlineButton onClick={addSoul} disabled={form.souls.length >= SOULS_MAX}>
                + add soul
              </OutlineButton>
              <OutlineButton
                onClick={resetSouls}
                disabled={busy || !Array.isArray(data?.defaults?.dj?.souls)}
              >
                reset to defaults
              </OutlineButton>
              {form.souls.length >= SOULS_MAX && (
                <span className="v3-caption" style={{ color: 'var(--muted)' }}>
                  maximum {SOULS_MAX} souls
                </span>
              )}
            </div>
          </Section>

          {/* ── SYSTEM PROMPT ────────────────────────────────────────── */}
          <Section title="System prompt">
            <p style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.6, marginBottom: 6 }}>
              The base instruction wrapped around every DJ generation. Placeholders:{' '}
              <code>{'{name}'}</code> · <code>{'{soul}'}</code> · <code>{'{station}'}</code> ·{' '}
              <code>{'{location}'}</code>. Most stations never need to touch this.
            </p>

            <Segmented
              value={form.useCustomPrompt ? 'custom' : 'default'}
              options={[
                { id: 'default', label: 'Built-in default' },
                { id: 'custom',  label: 'Custom' },
              ]}
              onChange={v => setForm(f => ({ ...f, useCustomPrompt: v === 'custom' }))}
            />

            {!form.useCustomPrompt ? (
              <div className="mt-3">
                <div className="v3-caption mb-1" style={{ color: 'var(--muted)' }}>
                  the DJ uses this built-in template
                </div>
                <pre
                  className="v3-scroll"
                  style={{
                    ...textareaStyle,
                    color: 'var(--muted)',
                    maxHeight: 220, overflowY: 'auto',
                    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                    fontSize: 12,
                  }}
                >
                  {data?.defaults?.dj?.systemPrompt || '(default unavailable)'}
                </pre>
              </div>
            ) : (
              <div className="mt-3">
                <textarea
                  rows={12}
                  value={form.systemPrompt}
                  maxLength={PROMPT_MAX}
                  onChange={e => setForm(f => ({ ...f, systemPrompt: e.target.value }))}
                  className="v3-focus"
                  style={{
                    ...textareaStyle,
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    fontSize: 12,
                    border: `1px solid ${promptOk ? 'var(--ink)' : '#c5302a'}`,
                  }}
                />
                <div className="flex flex-wrap items-center gap-3 mt-2">
                  <OutlineButton
                    onClick={() => setForm(f => ({ ...f, systemPrompt: data?.defaults?.dj?.systemPrompt || '' }))}
                    disabled={busy || !data?.defaults?.dj?.systemPrompt}
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
              {busy ? 'saving…' : 'save persona'}
            </SolidButton>
            {!canSave && !busy && (
              <span className="v3-caption" style={{ color: '#c5302a' }}>
                {form.name.trim() ? '' : 'name required · '}
                {cleanSouls.length ? '' : 'at least one soul · '}
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
      <div
        className="flex items-center justify-between px-4 py-2"
        style={{ borderBottom: '1px solid var(--ink)' }}
      >
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
      {hint && (
        <div style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.5 }}>{hint}</div>
      )}
      <div className="flex items-center flex-wrap pt-0.5">{children}</div>
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
            key={o.id}
            type="button"
            onClick={() => onChange(o.id)}
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
      onClick={onClick}
      disabled={disabled}
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
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="v3-eyebrow v3-focus cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed shrink-0"
      style={{ background: 'transparent', color: 'var(--ink)', border: '1px solid var(--ink)', padding: '5px 11px', fontSize: 10 }}
    >
      {children}
    </button>
  );
}
