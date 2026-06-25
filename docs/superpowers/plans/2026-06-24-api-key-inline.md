# API Key Inline Inputs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move API key inputs out of the standalone "API Keys" section and into the existing provider sections — LLM, TTS cloud, and Library/Embedding — so the key field appears contextually next to the provider it belongs to.

**Architecture:** The `POST /settings/secrets` backend endpoint (already shipped in the same branch) is unchanged. Only the frontend changes: remove `ApiKeysSection` + the `api-keys` nav entry; extend `LlmSection`, `TtsSection`, and `LibrarySection` to accept `adminFetch` + `refresh` props and render an inline password input below the existing `KeyStatus` badge for each cloud provider. The key is saved when the section's existing save button is clicked — one action saves both the provider config (`POST /settings`) and the key if typed (`POST /settings/secrets`).

**Tech Stack:** Next.js 15 / TypeScript, same `web/components/admin/SettingsPanel.tsx` file, no new dependencies.

## Global Constraints

- No new npm dependencies
- `POST /settings/secrets` backend is **unchanged** — only frontend changes in this plan
- Scrobble keys (LASTFM, LISTENBRAINZ) stay in `ScrobbleSection` — untouched
- Search API key stays in `SearchSection` via the existing `settings.json` path — untouched
- Lint gate: `cd web && npm run lint` must exit 0 (`eslint . && tsc --noEmit`)
- Commit author `geekylakshya`, no Claude co-author, no em-dashes
- Branch: `feat/api-key-management-ui` (continue on same branch, don't reset)

## Provider → Key mapping

| Section | Condition | Key var |
|---------|-----------|---------|
| LLM (primary) | `LLM_ENV_VARS[form.llm.provider]` exists | `LLM_ENV_VARS[form.llm.provider]` (one of: ANTHROPIC, OPENAI, GOOGLE, DEEPSEEK, OPENROUTER, AI_GATEWAY) |
| LLM (fallback) | `LLM_ENV_VARS[form.llm.fallback.provider]` exists | `LLM_ENV_VARS[form.llm.fallback.provider]` |
| TTS cloud | `!isCompat` (not openai-compatible) | `form.tts.cloud.provider === 'elevenlabs' ? 'ELEVENLABS_API_KEY' : 'OPENAI_API_KEY'` |
| Library / Embedding | embedding provider is a cloud provider (not `ollama`, not `openai-compatible`, not `locca`, not ``) | `'EMBEDDING_API_KEY'` |

`LLM_ENV_VARS` (already defined at line 46):
```ts
{ anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', google: 'GOOGLE_GENERATIVE_AI_API_KEY', deepseek: 'DEEPSEEK_API_KEY', openrouter: 'OPENROUTER_API_KEY', gateway: 'AI_GATEWAY_API_KEY' }
```

## Inline key input pattern (use exactly for all four placements)

```tsx
// Local state — one string per key slot, cleared on successful save
const [primaryKeyInput, setPrimaryKeyInput] = useState('');

// Helper: save a key to secrets.env; returns true on success
const saveKey = async (envVar: string, value: string): Promise<boolean> => {
  if (!value.trim()) return true;
  try {
    const r = await adminFetch('/settings/secrets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [envVar]: value.trim() }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({})) as { error?: string };
      notify.err(j.error || `Key save failed (${r.status})`);
      return false;
    }
    return true;
  } catch (e) {
    notify.err(errorMessage(e));
    return false;
  }
};

// In the section's save handler, after saveSettings(...):
const keyVar = LLM_ENV_VARS[form.llm.provider];
if (keyVar && primaryKeyInput.trim()) {
  const ok = await saveKey(keyVar, primaryKeyInput);
  if (ok) { setPrimaryKeyInput(''); refresh(); }
}
```

Inline field (placed immediately below the existing `KeyStatus` badge):
```tsx
<div className="field">
  <Label>{providerLabel} API key</Label>
  <Input
    type="password"
    value={primaryKeyInput}
    placeholder={data.env?.[keyVar] ? '•••••• (on file)' : providerKeyHint}
    onChange={(e: ChangeEvent<HTMLInputElement>) => setPrimaryKeyInput(e.target.value)}
    className="max-w-[360px]"
  />
  <div className="field-hint">
    Stored in <code>state/secrets.env</code>, takes effect immediately. Leave blank to keep the existing key.
  </div>
</div>
```

Provider key hints (use in placeholder when no key is set):
```
ANTHROPIC_API_KEY       → 'sk-ant-...'
OPENAI_API_KEY          → 'sk-...'
GOOGLE_GENERATIVE_AI_API_KEY → 'AIza...'
DEEPSEEK_API_KEY        → 'sk-...'
OPENROUTER_API_KEY      → 'sk-or-v1-...'
AI_GATEWAY_API_KEY      → 'gateway API key'
ELEVENLABS_API_KEY      → 'el_...'
EMBEDDING_API_KEY       → 'optional — defaults to chat key'
```

## File map

| File | Change |
|------|--------|
| `web/components/admin/SettingsPanel.tsx` | Remove `api-keys` from SECTIONS + switcher + ApiKeysSection component; extend LlmSection, TtsSection, LibrarySection |

---

## Task 1: Remove ApiKeysSection; update LlmSection with inline key inputs

**Files:**
- Modify: `web/components/admin/SettingsPanel.tsx`

**What to remove:**
1. `{ id: 'api-keys', label: 'API Keys', hint: 'provider credentials' }` from `SECTIONS` array (line ~35)
2. `{activeSection === 'api-keys' && data && (<ApiKeysSection ... />)}` block from the section switcher (line ~739)
3. The `ApiKeysSectionProps` interface, `API_KEY_DEFS` constant, and `ApiKeysSection` function component (~lines 3960–4075)

**What to add to LlmSection (function starts at line 1713):**

LlmSection currently receives `SectionProps` (no `adminFetch`). Add `adminFetch` and `refresh`:
- Add props: extend the function signature from `SectionProps` to `SectionProps & { adminFetch: (path: string, init?: RequestInit) => Promise<Response>; refresh: () => void }`
- Add `useState` for `primaryKeyInput` and `fallbackKeyInput`
- Add the `saveKey` helper inside the component
- Modify the `save` function (currently line 1714): after calling `saveSettings(...)`, also call `saveKey` for each typed key
- Add inline key field below the primary provider `KeyStatus` badge (line 1925–1930): wrap in `{LLM_ENV_VARS[form.llm.provider] && (...)}` — key var = `LLM_ENV_VARS[form.llm.provider]`
- Add inline key field below the fallback provider `KeyStatus` badge (line 2088–2091): wrap in `{LLM_ENV_VARS[form.llm.fallback.provider] && (...)}` — key var = `LLM_ENV_VARS[form.llm.fallback.provider]`
- Update call site (line ~701) to pass `adminFetch={adminFetch}` and `refresh={refresh}`

**Modified `save` function for LlmSection:**
```tsx
const save = async () => {
  saveSettings({
    llm: {
      provider: form.llm.provider,
      model: form.llm.model,
      ollamaUrl: form.llm.ollamaUrl,
      numCtx: form.llm.numCtx,
      baseUrl: form.llm.baseUrl,
      reasoning: form.llm.reasoning,
      pickerAgent: form.llm.pickerAgent,
      requestWebResolve: form.llm.requestWebResolve,
      agentTimeoutMs: form.llm.agentTimeoutMs,
      pauseWhenEmpty: form.llm.pauseWhenEmpty,
      fallback: {
        enabled: form.llm.fallback.enabled,
        provider: form.llm.fallback.provider,
        model: form.llm.fallback.model,
        ollamaUrl: form.llm.fallback.ollamaUrl,
        numCtx: form.llm.fallback.numCtx,
        baseUrl: form.llm.fallback.baseUrl,
        reasoning: form.llm.fallback.reasoning,
      },
    },
  });
  // Save API keys if typed — these go to secrets.env, not settings.json
  const primaryKeyVar = LLM_ENV_VARS[form.llm.provider];
  if (primaryKeyVar && primaryKeyInput.trim()) {
    const ok = await saveKey(primaryKeyVar, primaryKeyInput);
    if (ok) { setPrimaryKeyInput(''); refresh(); }
  }
  const fallbackKeyVar = LLM_ENV_VARS[form.llm.fallback.provider];
  if (fallbackKeyVar && fallbackKeyInput.trim()) {
    const ok = await saveKey(fallbackKeyVar, fallbackKeyInput);
    if (ok) { setFallbackKeyInput(''); refresh(); }
  }
};
```

Note: `saveSettings` is fire-and-forget (it calls its own async handler internally), so no `await` needed on it — the existing code already does this.

**Primary provider inline field** (insert immediately after the closing `}` of the existing KeyStatus block at line 1930):
```tsx
{LLM_ENV_VARS[form.llm.provider] && (
  <>
    <KeyStatus
      envVar={LLM_ENV_VARS[form.llm.provider]!}
      present={!!data.env?.[LLM_ENV_VARS[form.llm.provider]!]}
    />
    <div className="field">
      <Label>{llmProviderLabel(form.llm.provider)} API key</Label>
      <Input
        type="password"
        value={primaryKeyInput}
        placeholder={data.env?.[LLM_ENV_VARS[form.llm.provider]!] ? '•••••• (on file)' : primaryKeyHint}
        onChange={(e: ChangeEvent<HTMLInputElement>) => setPrimaryKeyInput(e.target.value)}
        className="max-w-[360px]"
      />
      <div className="field-hint">
        Stored in <code>state/secrets.env</code>, takes effect immediately. Leave blank to keep the existing key.
      </div>
    </div>
  </>
)}
```

Where `primaryKeyHint` is derived:
```tsx
const KEY_HINTS: Record<string, string> = {
  ANTHROPIC_API_KEY: 'sk-ant-...',
  OPENAI_API_KEY: 'sk-...',
  GOOGLE_GENERATIVE_AI_API_KEY: 'AIza...',
  DEEPSEEK_API_KEY: 'sk-...',
  OPENROUTER_API_KEY: 'sk-or-v1-...',
  AI_GATEWAY_API_KEY: 'gateway API key',
  ELEVENLABS_API_KEY: 'el_...',
  EMBEDDING_API_KEY: 'optional — defaults to chat key',
};
const primaryKeyHint = KEY_HINTS[LLM_ENV_VARS[form.llm.provider]!] ?? '';
```

Define `KEY_HINTS` at module level (near `LLM_ENV_VARS` at line 46), not inside the component.

**Fallback provider inline field** — identical pattern, insert after the existing fallback KeyStatus block (line 2091), using `fallbackKeyInput` / `setFallbackKeyInput` and `LLM_ENV_VARS[form.llm.fallback.provider]`.

- [ ] **Step 1: Remove the standalone ApiKeysSection**

Find and delete these three things from `web/components/admin/SettingsPanel.tsx`:
1. `{ id: 'api-keys', label: 'API Keys', hint: 'provider credentials' }` line in SECTIONS array
2. `{activeSection === 'api-keys' && data && ...}` block in the section switcher
3. `ApiKeysSectionProps` interface + `API_KEY_DEFS` constant + `ApiKeysSection` function (~90 lines starting around line 3960)

After deletion, run `cd /home/geeky/Projects/subwave/web && npm run lint` to confirm no errors from the deletion before adding new code.

- [ ] **Step 2: Add KEY_HINTS constant at module level**

At approximately line 52 (after the `LLM_ENV_VARS` constant), add:
```tsx
const KEY_HINTS: Record<string, string> = {
  ANTHROPIC_API_KEY: 'sk-ant-...',
  OPENAI_API_KEY: 'sk-...',
  GOOGLE_GENERATIVE_AI_API_KEY: 'AIza...',
  DEEPSEEK_API_KEY: 'sk-...',
  OPENROUTER_API_KEY: 'sk-or-v1-...',
  AI_GATEWAY_API_KEY: 'gateway API key',
  ELEVENLABS_API_KEY: 'el_...',
  EMBEDDING_API_KEY: 'optional — defaults to chat key',
};
```

- [ ] **Step 3: Extend LlmSection signature and add state + saveKey helper**

Change line 1713:
```tsx
// Before:
function LlmSection({ data, form, setForm, busy, saveSettings }: SectionProps) {

// After:
interface LlmSectionProps extends SectionProps {
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
  refresh: () => void;
}
function LlmSection({ data, form, setForm, busy, saveSettings, adminFetch, refresh }: LlmSectionProps) {
```

Add immediately after the function signature opening:
```tsx
  const [primaryKeyInput, setPrimaryKeyInput] = useState('');
  const [fallbackKeyInput, setFallbackKeyInput] = useState('');

  const saveKey = async (envVar: string, value: string): Promise<boolean> => {
    if (!value.trim()) return true;
    try {
      const r = await adminFetch('/settings/secrets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [envVar]: value.trim() }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({})) as { error?: string };
        notify.err(j.error || `Key save failed (${r.status})`);
        return false;
      }
      return true;
    } catch (e) {
      notify.err(errorMessage(e));
      return false;
    }
  };
```

- [ ] **Step 4: Update LlmSection save function**

Replace the existing `save` function (lines 1714–1736) with the new async version shown in the plan above.

- [ ] **Step 5: Add inline key field for primary provider**

Replace the existing primary KeyStatus block (lines 1925–1930):
```tsx
// Before:
{LLM_ENV_VARS[form.llm.provider] && (
  <KeyStatus
    envVar={LLM_ENV_VARS[form.llm.provider]!}
    present={!!data.env?.[LLM_ENV_VARS[form.llm.provider]!]}
  />
)}

// After:
{LLM_ENV_VARS[form.llm.provider] && (() => {
  const keyVar = LLM_ENV_VARS[form.llm.provider]!;
  return (
    <>
      <KeyStatus envVar={keyVar} present={!!data.env?.[keyVar]} />
      <div className="field">
        <Label>{llmProviderLabel(form.llm.provider)} API key</Label>
        <Input
          type="password"
          value={primaryKeyInput}
          placeholder={data.env?.[keyVar] ? '•••••• (on file)' : (KEY_HINTS[keyVar] ?? '')}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setPrimaryKeyInput(e.target.value)}
          className="max-w-[360px]"
        />
        <div className="field-hint">
          Stored in <code>state/secrets.env</code>, takes effect immediately. Leave blank to keep the existing key.
        </div>
      </div>
    </>
  );
})()}
```

- [ ] **Step 6: Add inline key field for fallback provider**

Replace the existing fallback KeyStatus block (lines 2088–2092):
```tsx
// Before:
{LLM_ENV_VARS[form.llm.fallback.provider] && (
  <KeyStatus
    envVar={LLM_ENV_VARS[form.llm.fallback.provider]!}
    present={!!data.env?.[LLM_ENV_VARS[form.llm.fallback.provider]!]}
  />
)}

// After:
{LLM_ENV_VARS[form.llm.fallback.provider] && (() => {
  const keyVar = LLM_ENV_VARS[form.llm.fallback.provider]!;
  return (
    <>
      <KeyStatus envVar={keyVar} present={!!data.env?.[keyVar]} />
      <div className="field">
        <Label>{llmProviderLabel(form.llm.fallback.provider)} API key</Label>
        <Input
          type="password"
          value={fallbackKeyInput}
          placeholder={data.env?.[keyVar] ? '•••••• (on file)' : (KEY_HINTS[keyVar] ?? '')}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setFallbackKeyInput(e.target.value)}
          className="max-w-[360px]"
        />
        <div className="field-hint">
          Stored in <code>state/secrets.env</code>, takes effect immediately. Leave blank to keep the existing key.
        </div>
      </div>
    </>
  );
})()}
```

- [ ] **Step 7: Update LlmSection call site**

Find the section switcher call for LLM (line ~701):
```tsx
// Before:
<LlmSection
  data={data} form={form} setForm={updateForm} busy={busy}
  saveSettings={saveSettings}
/>

// After:
<LlmSection
  data={data} form={form} setForm={updateForm} busy={busy}
  saveSettings={saveSettings} adminFetch={adminFetch} refresh={refresh}
/>
```

- [ ] **Step 8: Lint check**

```bash
cd /home/geeky/Projects/subwave/web && npm run lint
```

Expected: exit 0. Fix any TypeScript errors before committing.

- [ ] **Step 9: Commit**

```bash
git add web/components/admin/SettingsPanel.tsx
git commit -m "feat(settings): move API key inputs inline to LLM section, remove standalone API Keys page"
```

---

## Task 2: Add inline key inputs to TtsSection and LibrarySection

**Files:**
- Modify: `web/components/admin/SettingsPanel.tsx`

**TtsSection** (function at line 1267):

TtsSection currently has `SectionProps`. Add `adminFetch` and `refresh`:
```tsx
interface TtsSectionProps extends SectionProps {
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
  refresh: () => void;
}
function TtsSection({ data, form, setForm, busy, saveSettings, adminFetch, refresh }: TtsSectionProps) {
```

Add state + `saveKey` helper (identical to LlmSection's `saveKey` — it's a small function, not worth extracting to a shared util).

The TTS section cloud key location: around line 1681–1684, the KeyStatus badge is inside `{!isCompat && (...)}`. Add the key input field immediately below it.

TTS cloud key var:
```tsx
const cloudKeyVar = form.tts.cloud.provider === 'elevenlabs' ? 'ELEVENLABS_API_KEY' : 'OPENAI_API_KEY';
```

The TTS section's save already calls `saveSettings(...)`. Find that save function (around line 1699–1712) and extend it to also call `saveKey(cloudKeyVar, cloudKeyInput)` if the cloud engine is enabled and a key was typed.

Note: the TTS section has multiple sub-sections (piper, kokoro, cloud, etc.). Only the cloud sub-section needs the key input. Gate it on the cloud engine being selected or configured.

Update the TtsSection call site (line ~695):
```tsx
<TtsSection
  data={data} form={form} setForm={updateForm} busy={busy}
  saveSettings={saveSettings} adminFetch={adminFetch} refresh={refresh}
/>
```

**LibrarySection / Embedding** (function at line 2347):

The LibrarySection includes the embedding configuration. Find where the embedding provider is configured (the `form.embedding.provider` dropdown). Add `EMBEDDING_API_KEY` input when the embedding provider is a cloud provider:

Cloud embedding providers (those that need a key) = any provider in `EMBEDDING_PROVIDERS` that is NOT `ollama`, `openai-compatible`, `locca`, or `''`. Check `settings.EMBEDDING_PROVIDERS` to confirm the exact list, but the safe check is:

```tsx
const embeddingNeedsKey = form.embedding.provider && 
  !['ollama', 'openai-compatible', 'locca', ''].includes(form.embedding.provider);
```

When `embeddingNeedsKey` is true, show:
```tsx
<div className="field">
  <Label>Embedding API key override</Label>
  <Input
    type="password"
    value={embeddingKeyInput}
    placeholder={data.env?.['EMBEDDING_API_KEY'] ? '•••••• (on file)' : 'optional — defaults to chat key'}
    onChange={(e: ChangeEvent<HTMLInputElement>) => setEmbeddingKeyInput(e.target.value)}
    className="max-w-[360px]"
  />
  <div className="field-hint">
    Only needed when the embedding provider uses a different API key than the chat provider.
    Stored in <code>state/secrets.env</code>.
  </div>
</div>
<KeyStatus envVar="EMBEDDING_API_KEY" present={!!data.env?.['EMBEDDING_API_KEY']} />
```

Extend LibrarySection's save to call `saveKey('EMBEDDING_API_KEY', embeddingKeyInput)` when a key was typed.

Update LibrarySection call site (line ~712):
```tsx
<LibrarySection
  data={data} form={form} setForm={updateForm} busy={busy}
  saveSettings={saveSettings} adminFetch={adminFetch} refresh={refresh}
/>
```

- [ ] **Step 1: Extend TtsSection — signature, state, saveKey, cloud key field**

Make the changes described above. Gate the key input on `!isCompat` (same guard as the existing KeyStatus badge). State variable: `const [cloudKeyInput, setCloudKeyInput] = useState('');`.

Read the TTS section's save function carefully before modifying it — it may call `saveSettings` with a complex payload. Extend it by calling `saveKey(cloudKeyVar, cloudKeyInput)` after the existing `saveSettings(...)` call, only when `cloudKeyInput.trim()` is non-empty.

- [ ] **Step 2: Update TtsSection call site**

Line ~695 — add `adminFetch={adminFetch} refresh={refresh}`.

- [ ] **Step 3: Extend LibrarySection — signature, state, saveKey, embedding key field**

Find the embedding provider configuration in LibrarySection (the `form.embedding.provider` select/input). Place the `EMBEDDING_API_KEY` input and KeyStatus badge immediately after the embedding provider selector. State variable: `const [embeddingKeyInput, setEmbeddingKeyInput] = useState('');`.

Extend the Library save function to also call `saveKey('EMBEDDING_API_KEY', embeddingKeyInput)` when typed.

- [ ] **Step 4: Update LibrarySection call site**

Line ~712 — add `adminFetch={adminFetch} refresh={refresh}`.

- [ ] **Step 5: Lint check**

```bash
cd /home/geeky/Projects/subwave/web && npm run lint
```

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add web/components/admin/SettingsPanel.tsx
git commit -m "feat(settings): add inline API key inputs to TTS cloud and embedding sections"
```

---

## Task 3: Final lint pass + push branch

- [ ] **Step 1: Full lint on both packages**

```bash
cd /home/geeky/Projects/subwave/controller && npm run lint
cd /home/geeky/Projects/subwave/web && npm run lint
```

Both must exit 0.

- [ ] **Step 2: Push and open PR**

```bash
git push -u origin feat/api-key-management-ui
```

Then open PR at: `https://github.com/geekylakshya/subwave/compare/develop...feat/api-key-management-ui`

PR title: `feat(settings): inline API key inputs per provider section`

PR body:
```
Closes #572

## What changed
- Removed the standalone "API Keys" nav section
- LLM section: API key input appears when a cloud provider (Anthropic, OpenAI, Google, etc.) is selected — saves with the LLM settings in one click
- TTS section: API key input appears when ElevenLabs or OpenAI cloud TTS is configured
- Library section: EMBEDDING_API_KEY input appears when a cloud embedding provider is selected
- `POST /settings/secrets` backend (from the earlier commit) is unchanged

## Files changed
- `web/components/admin/SettingsPanel.tsx` only

## UX rationale
Key fields appear contextually next to the provider they authenticate — no separate section to navigate to. Selecting a provider and seeing the key field in the same card is the natural flow.
```
