# Imaging → Beds: protect the built-in & generate via ElevenLabs

**Date:** 2026-07-23
**Area:** `/admin/imaging` → Beds tab; controller bed library; ElevenLabs Music API
**Status:** proposed — awaiting review

## Summary

Three changes to the admin **Imaging → Beds** area, in order of size:

1. **Ship one built-in bed on new installs** — *already done*, confirmed. Nothing to build.
2. **Protect the built-in bed from deletion** — mirror the SFX/jingle `builtin` guard. This reverses the current deliberate "beds are deletable" design.
3. **Generate a bed via ElevenLabs**, mirroring the SFX Create flow — but using the ElevenLabs **Music API** (`/v1/music`, `force_instrumental`) instead of the sound-effects endpoint, because beds must be ≥30 s and sound-generation is capped at 22 s.

Everything reuses existing patterns (SFX library, jingle protection, the shared ElevenLabs key resolution). No new settings keys, no Liquidsoap changes, no changes to bed selection/playback.

## Background: what exists today

- **Bed library backend:** `controller/src/broadcast/beds.ts` — files at `<STATE_DIR>/beds/<slug>.mp3`, sidecar `<STATE_DIR>/beds.json` mapping name → `{name, description, durationSec, file, source, createdAt}`. `source ∈ 'bundled' | 'upload'`. Floor `MIN_DURATION_SEC = 30`.
- **The bundled default:** `DEFAULT_BEDS = [{ name: 'ambient-room', … bundled: sounds/bed.mp3 }]` (71 s). `ensureDefaults()` copies it into `state/beds/` on first boot (server startup, `server.ts`). So **new installs already get exactly one bed** — Goal 1 is satisfied.
- **Deletion today is deliberate:** `beds.remove()` deletes *any* bed and, for a bundled one, pushes its name onto a `retired` list so `ensureDefaults()` won't resurrect it. The header comment (`beds.ts:10-18`) spells out that defaults are intentionally deletable, and the delete-confirm dialog (`ImagingPanel.tsx:446`) promises "A bundled bed stays deleted."
- **SFX is the protection template:** `sfx.ts` items carry `builtin: boolean`; `sfx.remove()` throws `if (info.builtin)`; the route surfaces it as HTTP 400; the UI disables the delete button when `s.builtin` and shows a tooltip.
- **SFX generation:** `controller/src/audio/sfx-gen.ts` calls ElevenLabs `POST /v1/sound-generation` directly (the AI SDK has no sound-effects primitive). It resolves the key via a private `apiKey()` — `settings.tts.cloud.apiKey` when `tts.cloud.provider === 'elevenlabs'`, else `ELEVENLABS_API_KEY` env — and exposes `isConfigured()`, which backs the UI's `generatorReady` gate. Length is clamped to `[0.5, 22]`.
- **Beds UI:** `web/components/admin/imaging/BedsSection.tsx` is **import-only** (no Create button; empty-state says "beds can't be generated"). `ImagingPanel.tsx` owns state/handlers (`uploadBed`, `deleteBed`, the delete-confirm dialog). Shapes in `web/components/admin/imaging/types.ts`.

## Why the Music API (Goal 3 rationale)

A bed is an *instrumental the DJ talks over*, and `bed-policy.pickBed` only selects beds whose measured `durationSec ≥` the link length, with a hard floor of 30 s (`MIN_DURATION_SEC`). ElevenLabs sound-generation maxes at 22 s and produces *sound effects*, not musical instrumentals — so a literal "same as SFX" cannot produce a valid bed. The **Music API** fits exactly:

- `POST https://api.elevenlabs.io/v1/music`, header `xi-api-key` (the *same* key as SFX).
- Body: `prompt`, `music_length_ms` (3 000–600 000), `force_instrumental: true` (guarantees no vocals — essential for a bed), `model_id`.
- Query `output_format` (default `auto`); we request `mp3_44100_128`.
- Returns raw audio bytes (200 / `application/octet-stream`); `422` on validation error.

**Caveat carried into the spec:** Music is a separately-metered ElevenLabs feature and may need a specific plan tier. We cannot cheaply probe entitlement, so `generatorReady` for beds means only "a key is present" (same as SFX). A key without Music entitlement surfaces the API's error string on generate, exactly as a failed SFX generate does today.

---

## Design

### Part A — Shared ElevenLabs key resolution (small refactor)

Beds must resolve the ElevenLabs key identically to SFX, and must not import from the sfx module (beds don't depend on sfx). Extract the resolver into a new tiny module.

**New: `controller/src/audio/elevenlabs.ts`**
```ts
export function elevenLabsKey(): string   // the current sfx-gen apiKey() body
export function isConfigured(): boolean    // !!elevenLabsKey()
```

- `sfx-gen.ts` imports `elevenLabsKey` / `isConfigured` from it (drops its private `apiKey`).
- `routes/sfx.ts` imports `isConfigured` from `../audio/elevenlabs.js` (was `../audio/sfx-gen.js`).
- `bed-gen.ts` (Part C) and `routes/beds.ts` import from it too.

This is the only change to SFX code, and it is behaviour-preserving.

### Part B — Protect the built-in bed (Goal 2)

Mirror the SFX `builtin` posture and retire the `retired` mechanism (it existed *solely* to remember a deleted default, which will no longer be possible).

**`beds.ts`:**
- Sidecar item gains `builtin: boolean`. `list()` returns `builtin: !!info.builtin` (and keeps `source`).
- `DEFAULT_BEDS` installs are stamped `builtin: true, source: 'bundled'`.
- `remove()` throws `if (info.builtin) throw new Error('cannot delete the built-in bed')`; drops the `retired` bookkeeping.
- `ensureDefaults()`:
  - Drop the `retired` skip. The bundled default is always (re)installed if missing.
  - **In-place upgrade:** if the default already exists but lacks `builtin: true`, stamp it `true` and persist. This upgrades existing installs' `ambient-room` to protected without re-copying audio.
- `loadMeta()` stays tolerant of a legacy `retired` key (ignored, not rewritten) so old sidecars don't error.

**`routes/beds.ts`:** `DELETE /beds/:name` already surfaces the thrown error as 400 — no change needed beyond the new message. Update the file header comment (it currently states "no generate route" — see Part C).

**`web/components/admin/imaging/`:**
- `types.ts`: `BedEntry` gains `builtin?: boolean`.
- `BedsSection.tsx`: disable the delete `Button` when `b.builtin` (tooltip "Built-in beds can't be deleted"), mirroring `SfxSection.tsx:141-152`. Show a `builtin` badge for it (keep `uploaded` for uploads; the existing `bundled` badge is replaced by `builtin` for clarity/consistency with SFX).
- `ImagingPanel.tsx`: fix the delete-confirm copy (`:446`) to match SFX/jingles — `Delete the bed "X"? This removes the audio file permanently.` (drop the now-false "stays deleted" sentence; built-ins never reach this dialog).

**Behaviour change to sign off (flagged):** On upgrade, an install that had *deliberately deleted* `ambient-room` (name currently in `retired`) will get it **reinstalled as a protected built-in**. This is intentional: the escape hatch for "I find the bed annoying" is the **feature toggle** — `settings.beds.enabled` defaults to **off**, and turning beds off silences the bed without deleting the asset. Deletion was never the right lever. The beds feature is recent, so few (if any) installs will have retired it. *If you'd rather respect a prior deletion, the alternative is to keep `retired` and only protect the bed when present — say so and I'll switch.*

### Part C — Generate a bed via the Music API (Goal 3)

**New: `controller/src/audio/bed-gen.ts`** (mirrors `sfx-gen.ts`)
```ts
export const BED_GEN_MAX_SEC = 120;  // ceiling; a bed is trimmed per-link, so >2 min just burns credits
export async function generateBed(
  prompt: string,
  { durationSec, outPath }: { durationSec?: number; outPath: string },
): Promise<string>
```
- Endpoint `https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128`.
- Key via `elevenLabsKey()`; throw a clear "key not configured" error when absent.
- Body: `{ prompt, model_id: 'music_v1', force_instrumental: true, music_length_ms }` where
  `music_length_ms = round(clamp(durationSec, MIN_DURATION_SEC, BED_GEN_MAX_SEC) * 1000)`, defaulting to **45 s** when unset.
- On `!res.ok`: throw `ElevenLabs music generation failed (<status>): <detail…>` (mirror `generateSfx`).
- Write bytes straight to `outPath` (already MP3); no transcode.
- `model_id` is a single constant — easy to bump to `music_v2` later.

**`beds.ts` → add `create(...)`** (mirrors `sfx.create`)
```ts
export async function create({ name, description, prompt, durationSec }): Promise<item>
```
- slugify + validate name/prompt; reject an existing name (can't clobber a built-in).
- Clamp/validate `durationSec` to `[MIN_DURATION_SEC, BED_GEN_MAX_SEC]`.
- `generateBed(prompt, { durationSec, outPath: <DIR>/<slug>.mp3 })`.
- Probe measured duration; **same gate as `importAudio`**: if `measured == null || measured < MIN_DURATION_SEC`, unlink + throw (defensive — we force a ≥30 s length, but the probe is truth).
- Write sidecar item `{ name, description, prompt, durationSec: measured ?? requested, file, source: 'generated', builtin: false, createdAt }`. (New: beds sidecar now stores `prompt` for generated beds; absent/empty for uploads.)

**`routes/beds.ts`:**
- `GET /beds` → also return `generatorReady: isConfigured()` and `maxGenDurationSec: BED_GEN_MAX_SEC` (alongside existing `beds`, `minDurationSec`).
- **New `POST /beds`** (generate): validate `name`, `prompt` (≤500), `durationSec` (finite, within `[MIN_DURATION_SEC, BED_GEN_MAX_SEC]`); call `beds.create(...)`; `queue.log('scheduler', …)`; return created. Validation → 400; generation failure → 500 (mirrors `routes/sfx.ts`).
- Update the header comment (the "no generate route" note is no longer true).

**`bed-policy.ts` / `queue.maybePushBed`:** no change. A generated bed is just a bed with a measured `durationSec`; `pickBed` already handles it.

**UI — `BedsSection.tsx` + `ImagingPanel.tsx`** (mirror the SFX Create flow):
- Library `PanelHead` gains a `+ Create` button beside `Import`, disabled while `busy`.
- New Create modal: **Name**, **Duration · s** (`min=30`, `max=120`, default `45`), **Description** (operator-facing), **Generation prompt** (≤500 chars, placeholder e.g. *"warm lo-fi ambient pad, no drums, soft and neutral"*). Create button gated on `bedsData.generatorReady && name && prompt`.
- When `!generatorReady`, show the same "no ElevenLabs key" `V3Alert` SFX shows (built-in works without a key; a key is only needed to generate).
- Empty-state caption changes from "beds can't be generated — import an instrumental" to "generate via ElevenLabs or import an instrumental."
- `types.ts`: add `BedsForm { name; description; prompt; durationSec }` and `BedsData.generatorReady?`, `BedsData.maxGenDurationSec?`.
- `ImagingPanel.tsx`: add `bedsForm` state + `createBed()` handler (mirror `createSfx()`; `POST /beds`, then `refreshBeds()`).

### Data shape summary

`beds.json` item, after:
```
{ name, description, prompt?, durationSec, file, source: 'bundled'|'upload'|'generated', builtin: boolean, createdAt }
```
`GET /beds` → `{ beds: BedEntry[], minDurationSec, maxGenDurationSec, generatorReady }`
`BedEntry` → `{ name, description?, size?, durationSec?, source?, builtin? }`

## Non-goals

- No change to Liquidsoap, bed selection (`bed-policy`), or the push path (`queue.maybePushBed`).
- No new bundled bed asset — Goal 1 already ships `ambient-room` from `sounds/bed.mp3`.
- No new settings keys; the ElevenLabs key continues to ride `settings.tts.cloud` / `ELEVENLABS_API_KEY`.
- No bed loudnorm on generate (consistent with import — level vs. voice is the operator's call; the broadcast limiter catches peaks).

## Files touched

**Controller**
- `controller/src/audio/elevenlabs.ts` — new (shared key resolver).
- `controller/src/audio/bed-gen.ts` — new (Music API client).
- `controller/src/audio/sfx-gen.ts` — use shared resolver.
- `controller/src/broadcast/beds.ts` — `builtin` flag, protected `remove()`, `create()`, `ensureDefaults()` upgrade + drop `retired`, header comment.
- `controller/src/routes/beds.ts` — `generatorReady`/`maxGenDurationSec` on GET, new `POST /beds`, header comment.
- `controller/src/routes/sfx.ts` — import `isConfigured` from the shared module.

**Web**
- `web/components/admin/imaging/types.ts` — `BedEntry.builtin`, `BedsForm`, `BedsData.generatorReady`/`maxGenDurationSec`.
- `web/components/admin/imaging/BedsSection.tsx` — Create modal, `+ Create` button, key alert, delete-disable on built-in, empty-state copy.
- `web/components/admin/imaging/ImagingPanel.tsx` — `bedsForm` state, `createBed()`, delete-confirm copy.

**Docs / copy**
- Grep `web/` manual + landing for "beds can't be generated" / import-only bed copy and update (recent commit `97711f37` touched manual/landing for Imaging). Update `docs/` if a beds reference exists.

## Testing & rollout

- Merge gate is `npm run lint` (`eslint . && tsc --noEmit`) in `controller/` and `web/` — both must pass.
- No test runner. The pure clamp in `bed-gen` is trivial; no new pure-test harness unless `bed-policy`'s test file makes one obvious.
- Manual verification: fresh `state/` boots with one **built-in** bed whose delete button is disabled; with an ElevenLabs key, Create produces a ≥30 s instrumental that appears in the library and is selectable for a long link; without a key, Create is gated and the alert shows; upload path unchanged.
- Prod note: controller changes need an image rebuild (`docker compose up -d --build controller`); dev hot-reloads.

## Open decisions flagged for review

1. **Retire vs. protect on upgrade** (Part B) — reinstall a previously-deleted `ambient-room` as protected (recommended), or respect the prior deletion?
2. **Duration range** — Create offers 30–120 s, default 45 s. Reasonable? (Beds are trimmed per-link, so the exact length rarely matters beyond "≥ the longest link.")
3. **Model** — `music_v1` (safe default) vs `music_v2` (newer, possibly costlier/less available).
