# DJ system-prompt library — design

**Goal.** The admin Personas page has one global system-prompt template (built-in default or a single
custom string). Operators want to keep several templates and switch between them, and the inline
textarea editor should move into a modal.

## Data model (controller)

Two new settings fields alongside the existing `djPrompt`:

- `djPrompts: Array<{ id, name, text }>` — the saved template library. `id` is server-minted
  (`dp_xxxxxx`, same `mintId` as personas/shows), `name` 1–60 chars, `text` 50–4000 chars and must
  contain `{name}` (same bounds as today's `djPrompt`). Max 20 presets.
- `activeDjPromptId: string` — `''` selects the built-in default template, otherwise must reference
  an entry in `djPrompts`.

`djPrompt` stays in the cache (and in `settings.json`) as the **resolved active text** (`''` when
the built-in default is active). `renderDjPrompt()` and every other reader keep working untouched,
and an older controller pointed at the same `settings.json` still honours the active prompt.

**Load / migration** (`load()`): parse `stored.djPrompts` leniently; if empty and the legacy
`djPrompt` (or `dj.systemPrompt`) is a non-default custom string, seed the library with one entry
named "Custom prompt" and activate it. A dangling `activeDjPromptId` falls back to `''`. Then
resolve `cache.djPrompt` from the active entry.

**Update** (`update(patch)`):

- `djPrompts` → `validateDjPromptsStrict()`: array ≤ 20; per entry name/text bounds as above; ids
  re-minted when missing/invalid/duplicate.
- `activeDjPromptId` → string; after both patches apply, a non-empty id that doesn't exist in
  `next.djPrompts` throws.
- Legacy `djPrompt` (onboarding wizard, older UI) still accepted: `''` → activate built-in;
  non-empty → reuse the library entry with identical text or append a "Custom prompt" entry, then
  activate it.
- Finally `next.djPrompt` is recomputed from the active entry so the persisted file and cache stay
  the single source of truth for readers.

**GET /settings**: `values.djPrompts` + `values.activeDjPromptId` added; `values.djPrompt` (resolved)
and `defaults.djPrompt` (built-in template text) stay for older clients.

## Web UI (`/admin/personas`)

`FormState` swaps `useCustomPrompt`/`systemPrompt` for `djPrompts` + `activeDjPromptId`.

`SystemPromptCard` becomes a **prompt library**:

- A list of rows: "Built-in default" first, then each saved preset (name + char count). Each row has
  an activate control (radio-style; the active row is marked), the built-in row a **View** button,
  preset rows an **Edit** and **Delete** button.
- **New prompt** button appends a preset seeded from the built-in default text (disabled at the
  20-preset cap). Ids minted client-side (`dp_` + 3 random bytes); the server re-mints invalid ones.
- Deleting the active preset falls the selection back to the built-in default. Deletion is a form
  edit — nothing persists until Save.
- **Modal editor** (existing `components/ui/modal.tsx`): name input, mono textarea (~16 rows),
  char counter with `{name}`/min-length hints, "Restore default text", footer Done. Edits write
  straight into form state; the card's existing save bar (whole-form POST to `/settings`) persists.
  The built-in default opens in the same modal read-only.
- Validation: every preset valid (name 1–60, text 50–4000 with `{name}`) and the active id must
  exist; both feed the existing `canSave` gate with per-cause messaging.

Save body sends `djPrompts` + `activeDjPromptId` (no more legacy `djPrompt`).

## Out of scope

Per-persona prompts (the template stays global — personas ride through `{name}`/`{soul}`),
import/export, and the native app (it has no admin surface).
