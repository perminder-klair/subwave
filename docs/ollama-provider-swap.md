# Switch Ollama provider: `ollama-ai-provider-v2` → `ai-sdk-ollama`

Plan to evaluate replacing the current Ollama AI SDK provider with the
jagreehal package, and prune the workarounds it claims to solve natively.

## Context

The controller currently uses `ollama-ai-provider-v2@3.5.1` (nordwestt) — the
"basic" community provider — and has accumulated **six layered workarounds**
in `controller/src/llm/` to compensate for its weak tool-call / structured-
output behaviour against cloud Ollama models (`:cloud` variants like
`glm-5.1`, `kimi-k2.6`, `minimax-m2.7`):

1. `provider.chat(id)` instead of `provider(id)` in `provider.ts:144-145` —
   the default callable returns a "responses" model that botches tool
   translation.
2. `objectViaToolCall()` in `sdk.ts:245-265` — forced `emit` tool replaces
   `Output.object` for Ollama.
3. Manual `extractJson()` recovery path in `djObject` `sdk.ts:362-372` —
   catches model output the native parser chokes on.
4. `done` tool pattern in `djAgent` `sdk.ts:459-466` + `prepareStep` step-
   cornering `sdk.ts:478-495` + `COMMIT_AFTER_STEPS = 1` `sdk.ts:51` —
   replaces native `Output.object` in tool loops; corners cloud models into
   "discovery step 0, done step 1".
5. `<think>…</think>` stripping (`stripThinking`, `sdk.ts:60-63`) —
   defensive; reasoning tags leak through Ollama's `think:false`.
6. 22 s `timeoutMs` hard ceiling in `dj-agent.ts:106, 213` — fast-fallback
   for pathological cloud runs.

The candidate `ai-sdk-ollama@3.8.4` (jagreehal) targets AI SDK v6 (we're on
`ai@6.0.182`), is built on the official Ollama JS client, and explicitly
claims native fixes for: tool calling with complete responses, auto-detected
structured outputs, automatic JSON repair, and reasoning-tag extraction. The
branch `claude/ollama-provider-evaluation-gO84T` is set up for this.

Scope chosen by the operator: **swap the package AND prune the workarounds
the new package handles natively**, keep the 22 s timeout as a safety net,
benchmark with `picker-test.mjs` before/after to confirm reliability didn't
regress.

## Approach

### Step 1 — Capture baseline benchmark *(before any code change)*

Run the existing harness against the operator's homelab Ollama, including
the two cloud models the sdk.ts header comments call out:

```bash
cd controller
node scripts/picker-test.mjs ollama glm-5.1:cloud 20 short  > /tmp/baseline-glm.txt
node scripts/picker-test.mjs ollama kimi-k2.6:cloud 20 short > /tmp/baseline-kimi.txt
```

Record pass rate, median latency, failure modes (NoObjectGenerated,
hallucinated id, thrown error, timeout). These are the comparison points
for step 6.

### Step 2 — Swap the dependency

In `controller/package.json` — replace:

```diff
- "ollama-ai-provider-v2": "^3.5.1",
+ "ai-sdk-ollama": "^3.8.4",
```

Run `npm install` in `controller/`.

### Step 3 — Rewrite the Ollama branch in `controller/src/llm/provider.ts`

- Change the import: `import { createOllama } from 'ollama-ai-provider-v2'`
  → `import { createOllama } from 'ai-sdk-ollama'` (the package exposes
  both a default `ollama()` factory and `createOllama({ baseURL })` for
  custom hosts; we need the latter because `settings.llm.ollamaUrl` is
  operator-configurable).
- Replace the Ollama `case` body (`provider.ts:132-147`). The new package
  uses the unified AI SDK v6 factory — no more `.chat()` override:
  ```ts
  case 'ollama':
  default: {
    const provider = createOllama({ baseURL: `${ollamaBaseUrl(cfg)}/api` });
    model = provider(id);
    break;
  }
  ```
- Strip the long `// CRITICAL: use provider.chat(id)…` comment — it
  documents a package-specific quirk that's gone.
- At implementation time, verify against the installed package's
  `dist/index.d.ts` that the factory signature matches; if `ai-sdk-ollama`
  exports a different name for the baseURL option (e.g. `host`) or a
  different factory shape, adapt the call but keep the wiring identical.

### Step 4 — Prune the workarounds in `controller/src/llm/sdk.ts`

Drop the Ollama-specific structured-output paths now that the new provider
claims native parity:

- **Delete `needsToolCallObject()`** (`sdk.ts:148-155`). Its only callers
  are the two branches we're removing.
- **Delete `objectViaToolCall()`** (`sdk.ts:245-265`) and its two call
  sites:
  - `djObject` attempt 1: the `if (attempt === 1 && needsToolCallObject())`
    branch (`sdk.ts:345-347`). Falls through to the normal `Output.object`
    branch for Ollama too.
  - `djAgent` no-tools fast-path: the
    `if (schema && toolCount === 0 && needsToolCallObject())` branch
    (`sdk.ts:446-456`). Falls through to the normal `ToolLoopAgent` path.
- **Collapse the `djAgent` done-tool path to the native one**
  (`sdk.ts:459-512`): remove `useDoneTool`, the synthetic `done` tool,
  `useGatedDiscovery`, `prepareStep`, `discoveryToolNames`, and the post-
  loop `doneCall = result.staticToolCalls.find(...)` branch
  (`sdk.ts:524-529`). Result handling collapses to: `object = result.output`
  when `schema` is set, else `stripThinking(result.text)`.
- **Delete `COMMIT_AFTER_STEPS`** (`sdk.ts:51`).
- **Simplify `stopWhen`** to `stepCountIs(maxSteps)` only —
  `hasToolCall('done')` is dead once the done tool is gone.

### Step 5 — Keep the safety nets

- **Keep `timeoutMs`** in `djAgent` (`sdk.ts:517-520`) and its callers
  (`dj-agent.ts:106, 213`). The new provider may be faster but a hard
  ceiling is provider-agnostic insurance.
- **Keep `stripThinking()`** and the second-attempt JSON-repair recovery in
  `djObject` (`sdk.ts:362-372`). They cost nothing when unused (only fire
  when attempt 1 fails) and stay useful for the other providers
  (`openai-compatible`, DeepSeek reasoner variants, etc.). The new
  package's "automatic JSON repair" claim is provider-internal; this is a
  defensive outer layer.
- **Rewrite the long header comment in `djAgent`**: the per-provider
  rationale and the empirical reliability table need updating. Old table
  (`minimax done-tool 10/10` vs `Output.object 0/5`) becomes a historical
  note; replace with the post-swap numbers from step 6.

### Step 6 — Re-benchmark, then smoke-test on the stack

Re-run the same two `picker-test.mjs` invocations against the new path:

```bash
node scripts/picker-test.mjs ollama glm-5.1:cloud 20 short  > /tmp/new-glm.txt
node scripts/picker-test.mjs ollama kimi-k2.6:cloud 20 short > /tmp/new-kimi.txt
diff <(grep -E 'pass|fail' /tmp/baseline-glm.txt) <(grep -E 'pass|fail' /tmp/new-glm.txt)
```

Pass criteria for the swap:

- glm-5.1:cloud pass rate **≥ baseline** (baseline ~97 % per the
  `eaa7e6e` commit notes).
- kimi-k2.6:cloud pass rate **≥ baseline** (baseline was the failure
  case; the new provider's "guaranteed complete responses" claim is
  exactly the hypothesis under test here).
- No new failure mode (e.g. "agent did not call done" should now be gone,
  not replaced by something worse).

If kimi degrades but glm holds, the picker-benchmark skill already exists
to pick a better default model in `controller/.env` — not a blocker.

Then boot the dev stack via the `subwave-control` skill and watch one full
track cycle (~3–5 min) with the `/debug` admin panel open:

- djAgent picker fires on track-end, queues next track.
- A `POST /request` exercises `runRequest`.
- djText is still healthy (idents, links, hourly).
- No `<think>` tags leak into spoken output.

### Step 7 — Commit + push

Single commit on `claude/ollama-provider-evaluation-gO84T`, message
summarising "switch to ai-sdk-ollama; remove done-tool, forced-emit,
prepareStep workarounds — kept timeout + recovery as safety net;
benchmarks: <numbers>".

## Critical files

- `controller/package.json` — dependency swap.
- `controller/src/llm/provider.ts` — Ollama case (lines 20, 132-147,
  165-170 comments).
- `controller/src/llm/sdk.ts` — delete `objectViaToolCall`,
  `needsToolCallObject`, `COMMIT_AFTER_STEPS`, `useDoneTool` /
  `prepareStep` blocks; simplify `djAgent` result extraction; rewrite the
  long `djAgent` header comment.
- `controller/scripts/picker-test.mjs` — used as the benchmark harness,
  **not modified**; just re-run.

## Verification

- `cd controller && npm run lint` — typecheck + ESLint clean. The file
  already type-checks; deletions shouldn't regress.
- Benchmark step 1 vs step 6 — pass rate ≥ baseline for both models.
- Stack smoke-test: full track cycle on the dev compose with admin
  `/debug` showing green djAgent + djObject + djText entries.
- `git diff main -- controller/src/llm/sdk.ts` should be a **net
  deletion** — the success criterion is fewer lines of provider-specific
  scaffolding, not more.

## Rollback

The package swap is a single `package.json` line and a few `sdk.ts`
deletions. If benchmarks regress and the cause can't be fixed within the
new provider's API, revert the commit on the branch — `main` is
untouched.
