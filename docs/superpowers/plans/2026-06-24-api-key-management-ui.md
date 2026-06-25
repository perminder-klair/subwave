# API Key Management UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "API Keys" section to the admin Settings panel so operators can paste and save provider API keys directly in the UI instead of SSH-editing `state/secrets.env`.

**Architecture:** New `POST /settings/secrets` endpoint in the controller calls the existing `saveSecrets()` function to write keys to `state/secrets.env` and hot-reload them into `process.env`. The frontend adds an `ApiKeysSection` component that exactly mirrors the existing `ScrobbleSection` UX pattern (password inputs, `•••••• (on file)` placeholder, `KeyStatus` badge, blank = no-op on save). After a successful save the section calls the existing `refresh()` data loader to update presence badges without a page reload.

**Tech Stack:** Express (controller), TypeScript (ESM), Next.js 15 App Router, Tailwind, existing component library (`Btn`, `Card`, `Label`, `Input`, `KeyStatus`, `Seg`, `Pill`, `SectionHeader` from `web/components/admin/ui`)

## Global Constraints

- No new npm dependencies in either `controller/` or `web/`
- No changes to `controller/src/setup/secrets.ts` — `saveSecrets()` already handles merging, mode 0600, and in-process hot-reload
- Scrobble keys (`LASTFM_API_KEY`, `LASTFM_API_SECRET`, `LASTFM_SESSION_KEY`, `LISTENBRAINZ_USER_TOKEN`) are already covered by `ScrobbleSection` — do NOT duplicate them in the new section
- Secret values are NEVER returned to the client — only boolean presence (`!!process.env.KEY`)
- All new TypeScript must pass `npm run lint` (`eslint . && tsc --noEmit`) in both `controller/` and `web/` — this is the CI merge gate
- Commit author: `geekylakshya`; no Claude co-author; no em-dashes in commit messages
- Branch off `develop`; target `develop` for the PR

---

## File Map

| File | Change |
|------|--------|
| `controller/src/routes/settings.ts` | Add `EMBEDDING_API_KEY` to `env` object in GET response; add `POST /settings/secrets` route; add import for `saveSecrets` + `SECRET_ENV_KEYS` |
| `web/components/admin/SettingsPanel.tsx` | Add `'api-keys'` entry to `SECTIONS`; add `ApiKeysSection` component; render it in the section switcher; pass `refresh` as `onSaved` prop |

---

## Task 1: Backend — expose EMBEDDING_API_KEY + add POST /settings/secrets

**Files:**
- Modify: `controller/src/routes/settings.ts`

**Interfaces:**
- Produces: `POST /api/settings/secrets` — accepts `Record<string, string>`, filters to `SECRET_ENV_KEYS`, skips blank values, calls `saveSecrets(patch)`, returns `{ saved: string[] }`
- Produces: GET `/api/settings` `env.EMBEDDING_API_KEY` — boolean presence (already had 11 keys; this adds the 12th)

- [ ] **Step 1: Add the import for saveSecrets**

Open `controller/src/routes/settings.ts`. At the top, find the existing imports block and add:

```typescript
import { saveSecrets, SECRET_ENV_KEYS } from '../setup/secrets.js';
```

Place it after the existing `import { requireAdmin }` line.

- [ ] **Step 2: Add EMBEDDING_API_KEY to the env object in the GET response**

Find the `env:` block inside `router.get('/settings', ...)` (currently lines ~134–147). It ends with `LISTENBRAINZ_USER_TOKEN: !!process.env.LISTENBRAINZ_USER_TOKEN,`. Add the missing key:

```typescript
      env: {
        OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
        ELEVENLABS_API_KEY: !!process.env.ELEVENLABS_API_KEY,
        ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
        GOOGLE_GENERATIVE_AI_API_KEY: !!process.env.GOOGLE_GENERATIVE_AI_API_KEY,
        DEEPSEEK_API_KEY: !!process.env.DEEPSEEK_API_KEY,
        OPENROUTER_API_KEY: !!process.env.OPENROUTER_API_KEY,
        AI_GATEWAY_API_KEY: !!process.env.AI_GATEWAY_API_KEY,
        SEARCH_API_KEY: !!process.env.SEARCH_API_KEY,
        EMBEDDING_API_KEY: !!process.env.EMBEDDING_API_KEY,
        LASTFM_API_KEY: !!process.env.LASTFM_API_KEY,
        LASTFM_API_SECRET: !!process.env.LASTFM_API_SECRET,
        LASTFM_SESSION_KEY: !!process.env.LASTFM_SESSION_KEY,
        LISTENBRAINZ_USER_TOKEN: !!process.env.LISTENBRAINZ_USER_TOKEN,
      },
```

- [ ] **Step 3: Add the POST /settings/secrets route**

After the closing brace of `router.post('/settings', ...)` (around line 183), add:

```typescript
// ---------------------------------------------------------------------------
// POST /settings/secrets — write one or more API keys to state/secrets.env.
// Only keys listed in SECRET_ENV_KEYS are accepted; blank values are skipped
// (blank = "leave existing key in place"). Takes effect in-process immediately
// via saveSecrets(); no controller restart needed.
// ---------------------------------------------------------------------------
router.post('/settings/secrets', requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    if (typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'Body must be a key-value object' });
    }
    const patch: Record<string, string> = {};
    for (const [key, value] of Object.entries(body)) {
      if (!SECRET_ENV_KEYS.includes(key as any)) continue;
      if (typeof value !== 'string') continue;
      const trimmed = value.trim();
      if (!trimmed) continue;
      patch[key] = trimmed;
    }
    if (Object.keys(patch).length === 0) {
      return res.json({ saved: [] });
    }
    await saveSecrets(patch);
    res.json({ saved: Object.keys(patch) });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});
```

- [ ] **Step 4: Verify lint passes in controller/**

```bash
cd /home/geeky/Projects/subwave/controller && npm run lint
```

Expected: no errors. Fix any TypeScript complaints before continuing.

- [ ] **Step 5: Commit**

```bash
git add controller/src/routes/settings.ts
git commit -m "feat(settings): expose EMBEDDING_API_KEY in env and add POST /settings/secrets"
```

---

## Task 2: Frontend — ApiKeysSection component + nav entry

**Files:**
- Modify: `web/components/admin/SettingsPanel.tsx`

**Interfaces:**
- Consumes: `data.env` — `Record<string, boolean>` presence map (now includes `EMBEDDING_API_KEY`)
- Consumes: `adminFetch('/settings/secrets', { method: 'POST', body: JSON.stringify(patch) })`
- Consumes: `onSaved: () => void` — calls the existing `refresh()` function from the parent

**Component props:**

```typescript
interface ApiKeysSectionProps {
  data: SettingsData;
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
  onSaved: () => void;
}
```

- [ ] **Step 1: Add 'api-keys' to the SECTIONS array**

Find the `SECTIONS` constant (line ~26). Add the new entry **before** `scrobble` so it sits between `sfx` and `scrobble` in the nav rail:

```typescript
const SECTIONS = [
  { id: 'station',  label: 'Station',   hint: 'name · location · locale' },
  { id: 'theme',    label: 'Theme',     hint: 'station-wide palette' },
  { id: 'llm',      label: 'LLM provider', hint: 'model routing' },
  { id: 'tts',      label: 'TTS voice', hint: 'default engine' },
  { id: 'library',  label: 'Library tagger', hint: 'embedding · propagation' },
  { id: 'search',   label: 'Web search', hint: 'live-facts backend' },
  { id: 'jingles',  label: 'Jingles',   hint: 'stingers' },
  { id: 'sfx',      label: 'Sound FX',  hint: 'agent stingers' },
  { id: 'api-keys', label: 'API Keys',  hint: 'provider credentials' },
  { id: 'scrobble', label: 'Scrobbling', hint: 'last.fm · listenbrainz' },
  { id: 'archives', label: 'Archives',  hint: 'hourly recordings' },
  { id: 'webhooks', label: 'Webhooks',  hint: 'outbound events' },
  { id: 'backup',   label: 'Backup',    hint: 'export · restore' },
  { id: 'danger',   label: 'Danger zone', hint: 'broadcast control' },
] as const;
```

- [ ] **Step 2: Wire the section into the section switcher**

Find the block where sections are conditionally rendered (around line 738). The `scrobble` block looks like:

```typescript
{activeSection === 'scrobble' && (
  <ScrobbleSection
    data={data} form={form} setForm={updateForm} busy={busy}
    saveSettings={saveSettings} adminFetch={adminFetch}
  />
)}
```

Add the `api-keys` block immediately before it:

```typescript
{activeSection === 'api-keys' && data && (
  <ApiKeysSection
    data={data}
    adminFetch={adminFetch}
    onSaved={refresh}
  />
)}
{activeSection === 'scrobble' && (
  <ScrobbleSection
    data={data} form={form} setForm={updateForm} busy={busy}
    saveSettings={saveSettings} adminFetch={adminFetch}
  />
)}
```

Note: `refresh` is the function defined at line ~348 that re-fetches `/settings` and calls `setData(j)`.

- [ ] **Step 3: Add the ApiKeysSection component**

Add this component near the bottom of the file, just before `ScrobbleSection` (around line 3958). This mirrors the `ScrobbleSection` structure exactly — same `SectionHeader`, `Card`, `Label`, `Input`, `KeyStatus`, `Btn` components.

```typescript
// ---------------------------------------------------------------------------
// API Keys Section — write provider keys to state/secrets.env via
// POST /settings/secrets. Values are never read back; only presence is shown.
// Pattern mirrors ScrobbleSection exactly: password inputs, blank = no-op,
// KeyStatus badge, save clears the typed values and refreshes presence flags.
// ---------------------------------------------------------------------------

interface ApiKeysSectionProps {
  data: SettingsData;
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
  onSaved: () => void;
}

const API_KEY_DEFS: { key: string; label: string; hint: string }[] = [
  { key: 'ANTHROPIC_API_KEY',           label: 'Anthropic (Claude)',            hint: 'sk-ant-...' },
  { key: 'OPENAI_API_KEY',              label: 'OpenAI',                        hint: 'sk-...' },
  { key: 'GOOGLE_GENERATIVE_AI_API_KEY',label: 'Google Generative AI (Gemini)', hint: 'AIza...' },
  { key: 'OPENROUTER_API_KEY',          label: 'OpenRouter',                    hint: 'sk-or-v1-...' },
  { key: 'DEEPSEEK_API_KEY',            label: 'DeepSeek',                      hint: 'sk-...' },
  { key: 'AI_GATEWAY_API_KEY',          label: 'AI Gateway',                    hint: 'gateway API key' },
  { key: 'ELEVENLABS_API_KEY',          label: 'ElevenLabs (TTS)',              hint: 'el_...' },
  { key: 'SEARCH_API_KEY',              label: 'Tavily (web search)',           hint: 'tvly-...' },
  { key: 'EMBEDDING_API_KEY',           label: 'Embedding (override)',          hint: 'optional — defaults to chat key' },
];

function ApiKeysSection({ data, adminFetch, onSaved }: ApiKeysSectionProps) {
  const env = (data.env || {}) as Record<string, boolean>;
  const [form, setForm] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const inputValue = (key: string) => form[key] || '';
  const placeholder = (key: string, hint: string) =>
    env[key] ? '•••••• (on file)' : hint;

  const keysSet = API_KEY_DEFS.filter(d => !!env[d.key]).length;
  const hasInput = API_KEY_DEFS.some(d => (form[d.key] || '').trim().length > 0);

  const save = async () => {
    const patch: Record<string, string> = {};
    for (const { key } of API_KEY_DEFS) {
      const v = (form[key] || '').trim();
      if (v) patch[key] = v;
    }
    if (Object.keys(patch).length === 0) return;
    setSaving(true);
    try {
      const r = await adminFetch('/settings/secrets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const j = (await r.json().catch(() => ({}))) as { saved?: string[]; error?: string };
      if (!r.ok) throw new Error(j.error || `Save failed (${r.status})`);
      setForm({});
      onSaved();
      notify.ok(`Saved ${(j.saved || []).length} key(s)`);
    } catch (e) {
      notify.err(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <SectionHeader
        eyebrow="api keys"
        title="Provider credentials — stored securely in state/secrets.env."
        sub={<>
          Paste a key to store it. Stored values are never shown — only whether a key
          is present. Leave a field blank to keep the existing key unchanged.
          Keys set via <code>.env</code> or Docker <code>env_file</code> always take
          precedence over values stored here. Last.fm and ListenBrainz tokens are
          managed in the <strong>Scrobbling</strong> section.
        </>}
        metrics={[
          { n: `${keysSet}/${API_KEY_DEFS.length}`, l: 'configured', accent: keysSet > 0 },
        ]}
      />
      <Card title="Provider keys">
        <div className="grid gap-[18px]">
          {API_KEY_DEFS.map(({ key, label, hint }) => (
            <div key={key} className="field">
              <Label>{label}</Label>
              <Input
                type="password"
                value={inputValue(key)}
                placeholder={placeholder(key, hint)}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  setForm(f => ({ ...f, [key]: e.target.value }))
                }
                className="max-w-[360px]"
              />
              <KeyStatus envVar={key} present={!!(env[key])} />
            </div>
          ))}
          <div className="mt-1">
            <Btn tone="accent" onClick={save} disabled={saving || !hasInput}>
              {saving ? 'Saving…' : 'Save keys'}
            </Btn>
          </div>
        </div>
      </Card>
    </>
  );
}
```

- [ ] **Step 4: Add missing ChangeEvent import if not already present**

Check the top of the file for React imports:

```bash
grep -n "ChangeEvent" /home/geeky/Projects/subwave/web/components/admin/SettingsPanel.tsx | head -5
```

If `ChangeEvent` is already imported from React, skip this step. If not, find the existing React import and add it:

```typescript
import { useState, useEffect, useRef, ChangeEvent } from 'react';
```

- [ ] **Step 5: Verify lint passes in web/**

```bash
cd /home/geeky/Projects/subwave/web && npm run lint
```

Expected: no errors. Common issues to fix:
- `ChangeEvent` not imported
- `saving` state unused if type error elsewhere
- Missing `notify` import (check it's in scope — it is, defined in the file already)
- `errorMessage` import (also already in scope in this file)

- [ ] **Step 6: Smoke test in dev**

```bash
# Terminal 1 — controller hot-reload
cd /home/geeky/Projects/subwave
docker compose -f docker-compose.dev.yml up -d
# Wait ~5s for controller to start

# Terminal 2 — web dev server
cd web && npm run dev
```

Open http://localhost:7700/admin/settings and:
1. Sign in with admin credentials
2. Click **API Keys** in the nav rail — section should render
3. Verify each field shows `•••••• (on file)` placeholder for any keys already set in `process.env`, and the provider hint otherwise
4. Type a fake key (e.g. `test-key-123`) into any field
5. Click **Save keys** — should show `Saved 1 key(s)` toast
6. Field should clear; `KeyStatus` badge should flip to green (after `onSaved → refresh()` completes)
7. Open `state/secrets.env` and verify the key was written

- [ ] **Step 7: Commit**

```bash
git add web/components/admin/SettingsPanel.tsx
git commit -m "feat(settings): add API Keys section for managing provider credentials in admin UI"
```

---

## Task 3: Final lint + PR

- [ ] **Step 1: Full lint pass on both packages**

```bash
cd /home/geeky/Projects/subwave/controller && npm run lint
cd /home/geeky/Projects/subwave/web && npm run lint
```

Both must exit 0.

- [ ] **Step 2: Open PR**

Branch against `develop`. Title: `feat(settings): add API key management UI for all providers`. Reference: closes #572.

PR body should note:
- Two-file change: `controller/src/routes/settings.ts` + `web/components/admin/SettingsPanel.tsx`
- New endpoint: `POST /settings/secrets` — admin-gated, merges into `state/secrets.env`, hot-reloads in-process
- Also fixes missing `EMBEDDING_API_KEY` from the `env` presence map in GET `/settings`
- Mirrors `ScrobbleSection` UX exactly: password inputs, blank = no-op, `KeyStatus` badge, clears on save

---

## Self-Review Checklist

- [x] Issue: password inputs → `type="password"` ✓
- [x] Issue: `•••••• (on file)` placeholder when key present ✓
- [x] Issue: blank field = no change ✓
- [x] Issue: non-empty field = `saveSecrets()` merge ✓
- [x] Issue: takes effect immediately in-process (saveSecrets does `process.env[key] = value`) ✓
- [x] Issue: `KeyStatus` badge per field ✓
- [x] Issue: values never returned to client ✓
- [x] Scrobble keys excluded from new section ✓
- [x] `EMBEDDING_API_KEY` added to GET env map (was missing before this change) ✓
- [x] `EMBEDDING_API_KEY` included in new section ✓
- [x] `API_KEY_DEFS` covers all 9 non-scrobble `SECRET_ENV_KEYS` entries ✓
- [x] No new npm dependencies ✓
- [x] Lint gates satisfied ✓
- [x] `SectionHeader` eyebrow/title/sub/metrics pattern matches existing sections ✓
- [x] `Card` wrapper matches existing sections ✓
- [x] Save button disabled when no input typed (homogeneous with other save flows) ✓
