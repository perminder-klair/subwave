# API Key "Test" Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Test" button beside every API key input field in the admin Settings panel so operators can verify a key works against its provider before (or instead of) saving it.

**Architecture:** A new `POST /settings/secrets/test` backend endpoint receives `{ key, value }`, builds a one-off provider client with the supplied value (never touching `process.env` or `secrets.env`), runs a cheap live probe, and returns `{ ok, message, latencyMs }`. The frontend adds per-key test state alongside the existing `saveKey` pattern, rendering a `Btn sm` and an inline result block that matches the existing embedding "Test embeddings" UI.

**Tech Stack:** TypeScript, Express, Vercel AI SDK (`ai`, `@ai-sdk/*`), React, Tailwind CSS (existing SubWave patterns throughout)

## Global Constraints

- Commit as `geekylakshya` — no Claude co-author line, no em dashes in messages
- Do NOT run `npm run build` — CI handles it; just commit and push
- Do NOT push to Gitea — commit locally only
- Test on LXC 192.168.0.171 (root / see SSH credentials memory)
- Working branch: `feat/api-key-management-ui`
- Test buttons only enabled when the key input has a typed (non-empty) value — "test typed value" decision confirmed
- Backend probe is non-mutating: never writes to `secrets.env` or `process.env`
- Backend always returns HTTP 200 with `{ ok, message, latencyMs }` — probe failure is a normal outcome, not an HTTP error

---

## File Map

| File | Change |
|------|--------|
| `controller/src/routes/settings.ts` | Add `POST /settings/secrets/test` route + `probeKey()` helper |
| `web/components/admin/SettingsPanel.tsx` | Add `KeyTestResult` component + test state + `Btn sm` in 5 locations |

---

### Task 1: Backend — `POST /settings/secrets/test` endpoint

**Files:**
- Modify: `controller/src/routes/settings.ts`

**Interfaces:**
- Produces: `POST /settings/secrets/test` → `{ ok: boolean, message: string, latencyMs: number }`

- [ ] **Step 1: Add imports at the top of `settings.ts`**

The file already imports `probeEmbeddingConfig`, `saveSecrets`, `SECRET_ENV_KEYS`, `settings`. Add the AI SDK provider imports (same set as `onboarding.ts`):

```typescript
import { generateText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
```

Add these after the existing `import { saveSecrets, SECRET_ENV_KEYS } from '../setup/secrets.js';` line.

- [ ] **Step 2: Add the `probeKey` helper function after the `POST /settings/secrets` route**

Insert this entire block after the closing `});` of the `POST /settings/secrets` route (around line 215):

```typescript
// ---------------------------------------------------------------------------
// probeKey — non-mutating live probe for a single secret key.
// Builds a one-off provider client using the supplied value; never writes to
// process.env or secrets.env. Always resolves (never rejects).
// ---------------------------------------------------------------------------
async function probeKey(
  key: (typeof SECRET_ENV_KEYS)[number],
  value: string,
): Promise<{ ok: boolean; message: string }> {
  const cfg = settings.get().llm || {};
  const activeModel = (provider: string) =>
    cfg.provider === provider ? (cfg.model || '') : '';

  switch (key) {
    case 'ANTHROPIC_API_KEY': {
      const model = activeModel('anthropic') || 'claude-haiku-4-5-20251001';
      const m = createAnthropic({ apiKey: value })(model);
      const out = await generateText({ model: m, prompt: 'Reply with the single word OK.', maxOutputTokens: 8 });
      return { ok: true, message: `✓ Anthropic responded · "${(out.text || '').trim().slice(0, 40)}"` };
    }
    case 'OPENAI_API_KEY': {
      const model = activeModel('openai') || 'gpt-4o-mini';
      const m = createOpenAI({ apiKey: value })(model);
      const out = await generateText({ model: m, prompt: 'Reply with the single word OK.', maxOutputTokens: 8 });
      return { ok: true, message: `✓ OpenAI responded · "${(out.text || '').trim().slice(0, 40)}"` };
    }
    case 'GOOGLE_GENERATIVE_AI_API_KEY': {
      const model = activeModel('google') || 'gemini-1.5-flash';
      const m = createGoogleGenerativeAI({ apiKey: value })(model);
      const out = await generateText({ model: m, prompt: 'Reply with the single word OK.', maxOutputTokens: 8 });
      return { ok: true, message: `✓ Google responded · "${(out.text || '').trim().slice(0, 40)}"` };
    }
    case 'DEEPSEEK_API_KEY': {
      const model = activeModel('deepseek') || 'deepseek-chat';
      const m = createDeepSeek({ apiKey: value })(model);
      const out = await generateText({ model: m, prompt: 'Reply with the single word OK.', maxOutputTokens: 8 });
      return { ok: true, message: `✓ DeepSeek responded · "${(out.text || '').trim().slice(0, 40)}"` };
    }
    case 'OPENROUTER_API_KEY': {
      const model = activeModel('openrouter') || 'openai/gpt-4o-mini';
      const m = createOpenRouter({ apiKey: value })(model);
      const out = await generateText({ model: m, prompt: 'Reply with the single word OK.', maxOutputTokens: 8 });
      return { ok: true, message: `✓ OpenRouter responded · "${(out.text || '').trim().slice(0, 40)}"` };
    }
    case 'AI_GATEWAY_API_KEY': {
      return { ok: false, message: 'AI Gateway key cannot be tested without a model URL — save and test via an LLM call.' };
    }
    case 'ELEVENLABS_API_KEY': {
      const r = await fetch('https://api.elevenlabs.io/v1/user', {
        headers: { 'xi-api-key': value },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({})) as { detail?: { message?: string } | string };
        const msg = typeof j?.detail === 'string' ? j.detail : (j?.detail as any)?.message || `HTTP ${r.status}`;
        return { ok: false, message: `ElevenLabs: ${msg}` };
      }
      const u = await r.json() as { first_name?: string };
      return { ok: true, message: `✓ ElevenLabs account verified${u.first_name ? ` (${u.first_name})` : ''}` };
    }
    case 'SEARCH_API_KEY': {
      const r = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: value, query: 'test', max_results: 1 }),
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({})) as { detail?: string | { message?: string } };
        const detail = typeof j?.detail === 'string' ? j.detail : (j?.detail as any)?.message || '';
        return { ok: false, message: `Tavily: ${detail || `HTTP ${r.status}`}` };
      }
      return { ok: true, message: '✓ Tavily API key valid' };
    }
    case 'EMBEDDING_API_KEY': {
      const r = await probeEmbeddingConfig({ apiKey: value } as any);
      return {
        ok: r.code === 'ok',
        message: r.code === 'ok'
          ? `✓ Embeddings working${r.dim ? ` (${r.dim}-dim)` : ''}`
          : r.message,
      };
    }
    case 'LASTFM_API_KEY': {
      const url = `https://ws.audioscrobbler.com/2.0/?method=artist.getinfo&artist=Radiohead&api_key=${encodeURIComponent(value)}&format=json`;
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const j = await r.json().catch(() => null) as { error?: number; message?: string } | null;
      if (!r.ok || j?.error) {
        return { ok: false, message: `Last.fm: ${j?.message || `HTTP ${r.status}`}` };
      }
      return { ok: true, message: '✓ Last.fm API key valid' };
    }
    case 'LISTENBRAINZ_USER_TOKEN': {
      const r = await fetch('https://api.listenbrainz.org/1/validate-token', {
        headers: { Authorization: `Token ${value}` },
        signal: AbortSignal.timeout(8000),
      });
      const j = await r.json().catch(() => ({})) as { valid?: boolean; user_name?: string; message?: string };
      if (!j.valid) {
        return { ok: false, message: `ListenBrainz: ${j.message || 'token not valid'}` };
      }
      return { ok: true, message: `✓ ListenBrainz token valid${j.user_name ? ` (${j.user_name})` : ''}` };
    }
    default:
      return { ok: false, message: `No probe defined for ${key}` };
  }
}
```

- [ ] **Step 3: Add the `POST /settings/secrets/test` route after `probeKey`**

```typescript
// ---------------------------------------------------------------------------
// POST /settings/secrets/test — probe a key against its provider WITHOUT
// saving. Body: { key: string, value: string }. Always 200s with
// { ok, message, latencyMs } — a bad key is a normal, actionable answer.
// ---------------------------------------------------------------------------
router.post('/settings/secrets/test', requireAdmin, async (req, res) => {
  const { key, value } = req.body || {};
  if (!key || !value || typeof key !== 'string' || typeof value !== 'string') {
    return res.status(400).json({ ok: false, message: 'key and value are required', latencyMs: 0 });
  }
  if (!SECRET_ENV_KEYS.includes(key as any)) {
    return res.status(400).json({ ok: false, message: `Unknown key: ${key}`, latencyMs: 0 });
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return res.status(400).json({ ok: false, message: 'value must not be blank', latencyMs: 0 });
  }
  const t0 = Date.now();
  try {
    const result = await probeKey(key as (typeof SECRET_ENV_KEYS)[number], trimmed);
    res.json({ ok: result.ok, message: result.message, latencyMs: Date.now() - t0 });
  } catch (err: any) {
    res.json({ ok: false, message: err?.message || 'probe failed', latencyMs: Date.now() - t0 });
  }
});
```

- [ ] **Step 4: Smoke-test the endpoint on the test LXC**

Deploy the controller image to 192.168.0.171 (see [[rclone-dash deployment]] for redeploy steps). Then run these curl probes:

```bash
# Should return 400 (missing value)
curl -s -X POST http://192.168.0.171:3000/api/settings/secrets/test \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -d '{"key":"ANTHROPIC_API_KEY","value":""}' | jq .

# Should return { ok: false, message: "No probe defined..." } or a real error
curl -s -X POST http://192.168.0.171:3000/api/settings/secrets/test \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -d '{"key":"ANTHROPIC_API_KEY","value":"sk-ant-badkey"}' | jq .

# Should succeed with a real key (use the key from secrets.env on the LXC)
curl -s -X POST http://192.168.0.171:3000/api/settings/secrets/test \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -d '{"key":"ANTHROPIC_API_KEY","value":"<real-key>"}' | jq .
```

Expected for bad key: `{ "ok": false, "message": "...", "latencyMs": N }`
Expected for good key: `{ "ok": true, "message": "✓ Anthropic responded · \"OK\"", "latencyMs": N }`

- [ ] **Step 5: Commit**

```bash
git add controller/src/routes/settings.ts
git commit -m "feat(settings): add POST /settings/secrets/test endpoint for per-key probing"
```

---

### Task 2: Frontend — `KeyTestResult` shared component

**Files:**
- Modify: `web/components/admin/SettingsPanel.tsx`

**Interfaces:**
- Produces: `KeyTestResult` component used by Tasks 3–6
- Consumes: nothing from prior tasks (purely additive)

- [ ] **Step 1: Add `KeyTestResult` component**

Locate the existing `KeyStatus` component definition (search for `function KeyStatus`). Add `KeyTestResult` immediately below it:

```typescript
interface KeyTestResultProps {
  result: { ok: boolean; message: string; latencyMs: number };
}

function KeyTestResult({ result }: KeyTestResultProps) {
  return (
    <div
      className={cn(
        'mt-2 max-w-[560px] rounded border px-3 py-2 text-[11px] leading-[1.6]',
        result.ok
          ? 'border-[var(--accent)] text-[color:var(--accent)]'
          : 'border-red-400/50 text-red-300',
      )}
    >
      {result.message}
      {result.ok && result.latencyMs > 0 && ` · ${result.latencyMs}ms`}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add web/components/admin/SettingsPanel.tsx
git commit -m "feat(settings): add KeyTestResult component for inline key-test feedback"
```

---

### Task 3: Frontend — LlmSection test buttons (primary + fallback)

**Files:**
- Modify: `web/components/admin/SettingsPanel.tsx`

**Interfaces:**
- Consumes: `KeyTestResult` from Task 2, `adminFetch` prop already on `LlmSection`
- Consumes: backend `POST /settings/secrets/test` from Task 1

The `LlmSection` component already has `primaryKeyInput` / `fallbackKeyInput` state and a `saveKey` helper. Add test state and a `testKey` helper alongside them.

- [ ] **Step 1: Add test state and helper to `LlmSection`**

Locate the `LlmSection` component. After the existing state declarations:
```typescript
const [primaryKeyInput, setPrimaryKeyInput] = useState('');
const [fallbackKeyInput, setFallbackKeyInput] = useState('');
```

Add:
```typescript
const [primaryKeyTest, setPrimaryKeyTest] = useState<{ ok: boolean; message: string; latencyMs: number } | null>(null);
const [primaryKeyTesting, setPrimaryKeyTesting] = useState(false);
const [fallbackKeyTest, setFallbackKeyTest] = useState<{ ok: boolean; message: string; latencyMs: number } | null>(null);
const [fallbackKeyTesting, setFallbackKeyTesting] = useState(false);
```

After the existing `useEffect` calls that clear key inputs on provider change:
```typescript
useEffect(() => { setPrimaryKeyTest(null); }, [form.llm.provider]);
useEffect(() => { setFallbackKeyTest(null); }, [form.llm.fallback.provider]);
```

After the existing `saveKey` function, add:
```typescript
const testKey = async (
  envVar: string,
  value: string,
  setTesting: (v: boolean) => void,
  setResult: (r: { ok: boolean; message: string; latencyMs: number } | null) => void,
) => {
  if (!value.trim()) return;
  setTesting(true);
  setResult(null);
  try {
    const r = await adminFetch('/settings/secrets/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: envVar, value: value.trim() }),
    });
    const j = await r.json() as { ok: boolean; message: string; latencyMs: number };
    setResult(j);
  } catch (e) {
    setResult({ ok: false, message: errorMessage(e), latencyMs: 0 });
  } finally {
    setTesting(false);
  }
};
```

- [ ] **Step 2: Add Test button after the primary key field**

Find the primary key input block. It renders when `LLM_ENV_VARS[form.llm.provider]` is set. The block currently ends with:
```tsx
<KeyStatus envVar={keyVar} present={!!data.env?.[keyVar]} />
```

Add immediately after that `<KeyStatus>`:
```tsx
<div className="mt-2 flex items-center gap-2">
  <Btn
    sm
    onClick={() => testKey(keyVar, primaryKeyInput, setPrimaryKeyTesting, setPrimaryKeyTest)}
    disabled={primaryKeyTesting || !primaryKeyInput.trim()}
  >
    {primaryKeyTesting ? 'Testing…' : 'Test key'}
  </Btn>
</div>
{primaryKeyTest && <KeyTestResult result={primaryKeyTest} />}
```

- [ ] **Step 3: Add Test button after the fallback key field**

Find the fallback key input block. It renders when `LLM_ENV_VARS[form.llm.fallback.provider]` is set and ends with:
```tsx
<KeyStatus envVar={keyVar} present={!!data.env?.[keyVar]} />
```

Add immediately after:
```tsx
<div className="mt-2 flex items-center gap-2">
  <Btn
    sm
    onClick={() => testKey(keyVar, fallbackKeyInput, setFallbackKeyTesting, setFallbackKeyTest)}
    disabled={fallbackKeyTesting || !fallbackKeyInput.trim()}
  >
    {fallbackKeyTesting ? 'Testing…' : 'Test key'}
  </Btn>
</div>
{fallbackKeyTest && <KeyTestResult result={fallbackKeyTest} />}
```

- [ ] **Step 4: Verify the UI locally**

Open the admin panel → LLM provider section → switch to Anthropic → a key input appears → type any string → "Test key" button becomes enabled → click → spinner shows → result appears below the `KeyStatus` badge in accent/red border.

- [ ] **Step 5: Commit**

```bash
git add web/components/admin/SettingsPanel.tsx
git commit -m "feat(settings): add Test key button to LLM primary and fallback key inputs"
```

---

### Task 4: Frontend — TtsSection test button

**Files:**
- Modify: `web/components/admin/SettingsPanel.tsx`

**Interfaces:**
- Consumes: `KeyTestResult` from Task 2, `adminFetch` prop on `TtsSection`

The `TtsSection` already has `cloudKeyInput` / `setCloudKeyInput` state and a `saveKey` helper.

- [ ] **Step 1: Add test state and helper to `TtsSection`**

Locate `TtsSection`. After the existing:
```typescript
const [cloudKeyInput, setCloudKeyInput] = useState('');
```

Add:
```typescript
const [cloudKeyTest, setCloudKeyTest] = useState<{ ok: boolean; message: string; latencyMs: number } | null>(null);
const [cloudKeyTesting, setCloudKeyTesting] = useState(false);
```

After the existing `useEffect(() => { setCloudKeyInput(''); }, [form.tts.cloud.provider]);`, add:
```typescript
useEffect(() => { setCloudKeyTest(null); }, [form.tts.cloud.provider]);
```

After the existing `saveKey` helper in `TtsSection`, add:
```typescript
const testCloudKey = async () => {
  const cloudKeyVar = form.tts.cloud.provider === 'elevenlabs' ? 'ELEVENLABS_API_KEY' : 'OPENAI_API_KEY';
  if (!cloudKeyInput.trim()) return;
  setCloudKeyTesting(true);
  setCloudKeyTest(null);
  try {
    const r = await adminFetch('/settings/secrets/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: cloudKeyVar, value: cloudKeyInput.trim() }),
    });
    const j = await r.json() as { ok: boolean; message: string; latencyMs: number };
    setCloudKeyTest(j);
  } catch (e) {
    setCloudKeyTest({ ok: false, message: errorMessage(e), latencyMs: 0 });
  } finally {
    setCloudKeyTesting(false);
  }
};
```

- [ ] **Step 2: Add Test button after the cloud key field**

Find the TTS cloud key input render block. It renders when `!isCompat` (i.e. provider is `elevenlabs` or `openai`). The block currently ends with `<KeyStatus envVar={cloudKeyVar} present={...} />`.

The relevant variable in the render: `const cloudKeyVar = form.tts.cloud.provider === 'elevenlabs' ? 'ELEVENLABS_API_KEY' : 'OPENAI_API_KEY';` (already computed at line ~1721).

Add after `<KeyStatus envVar={cloudKeyVar} present={...} />`:
```tsx
<div className="mt-2 flex items-center gap-2">
  <Btn
    sm
    onClick={testCloudKey}
    disabled={cloudKeyTesting || !cloudKeyInput.trim()}
  >
    {cloudKeyTesting ? 'Testing…' : 'Test key'}
  </Btn>
</div>
{cloudKeyTest && <KeyTestResult result={cloudKeyTest} />}
```

- [ ] **Step 3: Commit**

```bash
git add web/components/admin/SettingsPanel.tsx
git commit -m "feat(settings): add Test key button to TTS cloud provider key input"
```

---

### Task 5: Frontend — LibrarySection test button (embedding key)

**Files:**
- Modify: `web/components/admin/SettingsPanel.tsx`

**Interfaces:**
- Consumes: `KeyTestResult` from Task 2, `adminFetch` prop on `LibrarySection`

`LibrarySection` already has `embeddingKeyInput` / `setEmbeddingKeyInput` state and a `saveKey` helper. The embedding key input only renders for cloud providers (`!['', 'ollama', 'openai-compatible', 'locca'].includes(e.provider)`).

- [ ] **Step 1: Add test state and helper to `LibrarySection`**

Locate `LibrarySection`. After the existing:
```typescript
const [embeddingKeyInput, setEmbeddingKeyInput] = useState('');
```

Add:
```typescript
const [embeddingKeyTest, setEmbeddingKeyTest] = useState<{ ok: boolean; message: string; latencyMs: number } | null>(null);
const [embeddingKeyTesting, setEmbeddingKeyTesting] = useState(false);
```

After the existing `useEffect(() => { setEmbeddingKeyInput(''); }, [form.embedding.provider]);`, add:
```typescript
useEffect(() => { setEmbeddingKeyTest(null); }, [form.embedding.provider]);
```

After the existing `saveKey` helper in `LibrarySection`, add:
```typescript
const testEmbeddingKey = async () => {
  if (!embeddingKeyInput.trim()) return;
  setEmbeddingKeyTesting(true);
  setEmbeddingKeyTest(null);
  try {
    const r = await adminFetch('/settings/secrets/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'EMBEDDING_API_KEY', value: embeddingKeyInput.trim() }),
    });
    const j = await r.json() as { ok: boolean; message: string; latencyMs: number };
    setEmbeddingKeyTest(j);
  } catch (e) {
    setEmbeddingKeyTest({ ok: false, message: errorMessage(e), latencyMs: 0 });
  } finally {
    setEmbeddingKeyTesting(false);
  }
};
```

- [ ] **Step 2: Add Test button after the embedding key field**

Find the embedding key override block (inside the `{e.provider && !['', 'ollama', 'openai-compatible', 'locca'].includes(e.provider) && ...}` conditional). It currently ends with:
```tsx
<KeyStatus envVar="EMBEDDING_API_KEY" present={!!data.env?.['EMBEDDING_API_KEY']} />
```

Add immediately after:
```tsx
<div className="mt-2 flex items-center gap-2">
  <Btn
    sm
    onClick={testEmbeddingKey}
    disabled={embeddingKeyTesting || !embeddingKeyInput.trim()}
  >
    {embeddingKeyTesting ? 'Testing…' : 'Test key'}
  </Btn>
</div>
{embeddingKeyTest && <KeyTestResult result={embeddingKeyTest} />}
```

- [ ] **Step 3: Commit**

```bash
git add web/components/admin/SettingsPanel.tsx
git commit -m "feat(settings): add Test key button to embedding API key override input"
```

---

### Task 6: Frontend — SearchSection test button (Tavily)

**Files:**
- Modify: `web/components/admin/SettingsPanel.tsx`

**Interfaces:**
- Consumes: `KeyTestResult` from Task 2

`SearchSection` does NOT have `adminFetch` in its props — it only receives `{ data, form, setForm, busy, saveSettings }`. Need to add `adminFetch` to `SearchSection`.

- [ ] **Step 1: Add `adminFetch` to `SearchSection` props**

Find the `SearchSection` interface and component signature. Currently:
```typescript
function SearchSection({ data, form, setForm, busy, saveSettings }: SectionProps) {
```

Change to:
```typescript
interface SearchSectionProps extends SectionProps {
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
}
function SearchSection({ data, form, setForm, busy, saveSettings, adminFetch }: SearchSectionProps) {
```

Then find where `SearchSection` is rendered in the main component (in the `activeSection === 'search'` block) and add the `adminFetch` prop:
```tsx
<SearchSection
  data={data} form={form} setForm={updateForm} busy={busy}
  saveSettings={saveSettings} adminFetch={adminFetch}
/>
```

- [ ] **Step 2: Add test state and helper to `SearchSection`**

At the top of `SearchSection`, after the existing derived values:
```typescript
const [tavilyKeyTest, setTavilyKeyTest] = useState<{ ok: boolean; message: string; latencyMs: number } | null>(null);
const [tavilyKeyTesting, setTavilyKeyTesting] = useState(false);
```

Add a helper:
```typescript
const testTavilyKey = async () => {
  const value = form.search.apiKey === 'set' ? '' : form.search.apiKey;
  if (!value.trim()) return;
  setTavilyKeyTesting(true);
  setTavilyKeyTest(null);
  try {
    const r = await adminFetch('/settings/secrets/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'SEARCH_API_KEY', value: value.trim() }),
    });
    const j = await r.json() as { ok: boolean; message: string; latencyMs: number };
    setTavilyKeyTest(j);
  } catch (e) {
    setTavilyKeyTest({ ok: false, message: errorMessage(e), latencyMs: 0 });
  } finally {
    setTavilyKeyTesting(false);
  }
};
```

- [ ] **Step 3: Add Test button after the Tavily key input**

Find the Tavily key input block (inside `{provider === 'tavily' && ...}`). It renders an `<Input>` for `form.search.apiKey`. The block currently ends with a `<KeyStatus envVar="SEARCH_API_KEY" present={tavilyKeySet} />`.

After that `<KeyStatus>`:
```tsx
<div className="mt-2 flex items-center gap-2">
  <Btn
    sm
    onClick={testTavilyKey}
    disabled={
      tavilyKeyTesting ||
      !form.search.apiKey.trim() ||
      form.search.apiKey === 'set'
    }
  >
    {tavilyKeyTesting ? 'Testing…' : 'Test key'}
  </Btn>
</div>
{tavilyKeyTest && <KeyTestResult result={tavilyKeyTest} />}
```

- [ ] **Step 4: Verify end-to-end on test LXC**

Deploy the web image to 192.168.0.171. Open the admin UI → Web search → switch to Tavily → type a key → Test key → result appears inline. Verify:
- Valid key: green border, `✓ Tavily API key valid · Xms`
- Invalid key: red border, `Tavily: Unauthorized` (or similar)
- Empty input: Test button is disabled

- [ ] **Step 5: Commit**

```bash
git add web/components/admin/SettingsPanel.tsx
git commit -m "feat(settings): add Test key button to Tavily search API key input"
```

---

## Self-Review

**Spec coverage:**
- ✓ `POST /settings/secrets/test` endpoint — Task 1
- ✓ Non-mutating probe (never writes process.env or secrets.env) — Task 1 Step 3
- ✓ Returns `{ ok, message, latencyMs }` — Task 1 Step 3
- ✓ Test typed value only (button disabled when input empty) — Tasks 3–6
- ✓ Inline result UI (accent/red border) matching embedding "Test embeddings" pattern — Task 2
- ✓ All LLM cloud key inputs (primary + fallback) — Task 3
- ✓ TTS cloud key (ElevenLabs + OpenAI) — Task 4
- ✓ Embedding key override — Task 5
- ✓ Tavily search key — Task 6
- ✓ Probe strategy per provider (LLM→generateText, ElevenLabs→/v1/user, Tavily→/search, embedding→probeEmbeddingConfig, LastFM/ListenBrainz→respective APIs) — Task 1 Step 2

**Out of scope (follow-up):**
- `LASTFM_API_SECRET`, `LASTFM_SESSION_KEY` — these are part of a multi-step OAuth flow; testing in isolation is not meaningful
- `AI_GATEWAY_API_KEY` — backend returns an informational "cannot test in isolation" message; no UI test button needed since the key field is only shown for the gateway provider, and users can test via a live LLM call

**Placeholder scan:** No TBDs. All code blocks are complete.

**Type consistency:**
- `KeyTestResult` takes `{ ok: boolean; message: string; latencyMs: number }` — matches what the backend returns and what each `testKey` call sets
- `testKey` / `testCloudKey` / `testEmbeddingKey` / `testTavilyKey` all produce the same shape
- `SearchSection` interface change: `SearchSectionProps extends SectionProps` with `adminFetch` added — matches the render call in Task 6 Step 1
