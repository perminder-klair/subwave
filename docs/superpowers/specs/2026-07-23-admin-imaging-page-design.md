# Admin "Imaging" page — move Jingles / SFX / Beds out of Settings

**Date:** 2026-07-23
**Status:** design, awaiting review
**Scope:** web UI only (no controller, broadcast, or state changes)

## Problem

Three of the fifteen sections in `/admin/settings` — **Jingles**, **Sound FX**, and
**Beds** — are miscategorised. The rest of Settings is *pure configuration*: knobs you
set once (Station, LLM, TTS, stream formats, loudness, archives, backup). These three are
*content you curate*: you upload files, generate audio (TTS / ElevenLabs), and delete
assets. That is the same category as **Library, Shows, Personas, and Skills** — all of
which are already **top-level nav items under the "Programming" group**, not buried inside
Settings.

Each of the three is *mostly* an asset manager with a thin settings header riding on top:

| Section  | Assets (the bulk)                                   | Settings (the header)              |
|----------|-----------------------------------------------------|------------------------------------|
| Jingles  | stinger WAVs — TTS-generate, upload, delete         | `jingleRatio` (1 per N tracks)     |
| Sound FX | ElevenLabs-generated / uploaded effects             | `sfx.enabled` on/off               |
| Beds     | talk-over instrumentals — upload, delete            | `beds.enabled` + link-length threshold |

They belong together under a single concept: the station's **imaging** — the audio
furniture the DJ drops between and over tracks (the real-radio term for jingles, IDs,
stingers, and beds).

## Decision

Create a new top-level admin page **Imaging** at `/admin/imaging`, hosting the three as
**tabs** (`Jingles · SFX · Beds`), and add it to the sidebar's **Programming** group.
Remove the three sections from Settings. The thin settings toggles ride along on their
tabs — same as Personas and Skills, which also mix a little config with their content.

Confirmed decisions:
- **Name:** Imaging
- **Structure:** one page, three tabs (mirrors `/admin/connect`'s tab pattern)

## Architecture

The pattern already exists twice in the codebase and we follow it exactly:

- **Route wrapper** (`app/admin/connect/page.tsx`): a server component that sets
  `metadata.title` and renders the client panel.
- **Tabbed client panel** (`components/admin/connect/ConnectPanel.tsx`): a `Seg` tab
  control, `?tab=` deep-linking via `history.replaceState`, one child component per tab.
- **Deep-link + redirect** (`SettingsPanel.tsx`): the existing precedent where the old
  standalone `/admin/{archives,backup}` routes redirect into Settings so bookmarks keep
  working. We do the reverse for the three moved sections.

### New files

**`web/app/admin/imaging/page.tsx`** — route wrapper.
```tsx
import type { Metadata } from 'next';
import ImagingPanel from '../../../components/admin/imaging/ImagingPanel';
export const metadata: Metadata = { title: 'Imaging' };
export default function AdminImagingPage() { return <ImagingPanel />; }
```

**`web/components/admin/imaging/ImagingPanel.tsx`** — the tab host. This is where the
state and handlers currently living in `SettingsPanel` for these three sections move to.
It owns:

- **Data fetches** (the three `refresh*` functions, polled on a 3s interval like Settings):
  - `data` ← `GET /settings` (for `jingleRatio`, `sfx.enabled`, `beds.enabled`, threshold, jingle list)
  - `sfxData` ← `GET /sfx`
  - `bedsData` ← `GET /beds`
- **Handlers** (moved verbatim from `SettingsPanel`): `saveSettings`, `createJingle`,
  `deleteJingle`, `uploadJingle`, `createSfx`, `deleteSfx`, `uploadSfx`, `uploadBed`,
  `deleteBed`.
- **Local UI state:** `busy`, `jingleText`, `sfxForm`, `jingleRatio` (a single string —
  see refactor below, *not* the whole `FormState`), and the three confirm-dialog states
  (`confirmDelete`, `confirmDeleteSfx`, `confirmDeleteBed`) with their `V3AlertDialog`s.
- **Tabs:** `type TabId = 'jingles' | 'sfx' | 'beds'`, default `'jingles'`, `Seg` control,
  `?tab=` deep-link read on mount + `history.replaceState` on switch (copy from
  `ConnectPanel`). Tab labels carry the live counts (e.g. `Jingles · 4`) so the
  at-a-glance count the settings rail used to show is preserved.

**`web/components/admin/imaging/types.ts`** — the imaging-only types moved out of
`settings/shared.tsx`: `SfxData`, `SfxForm`, `BedsData`, `JingleImportResult`,
`JingleImportFailure`. (`SettingsData`, `SaveSettings`, and `SectionHeader` stay in
`settings/shared.tsx` — they are generic settings-save primitives, and Imaging's toggles
legitimately write settings through them, so importing them from `../settings/shared` is
correct, not a smell.)

### Moved files

Move the three section components from `components/admin/settings/` to
`components/admin/imaging/`:
- `JinglesSection.tsx`
- `SfxSection.tsx`
- `BedsSection.tsx`

They keep importing `SectionHeader` / `SaveSettings` / `SettingsData` from
`../settings/shared`, and their moved types from `./types`.

### Refactor: decouple `JinglesSection` from `FormState`

`JinglesSection` currently `extends SectionProps`, which drags in the entire `form` /
`setForm` machinery — but it only ever reads/writes **one field**, `form.jingleRatio`
(confirmed: the only `form.*` references are `form.jingleRatio` on lines 33, 96, 98, 104).
Rebuilding Settings' ~200-line `FormState` hydration on the Imaging page just to feed one
string would be wasteful.

Change its props to take that one value directly:
```ts
// was: interface JinglesSectionProps extends SectionProps { … }
interface JinglesSectionProps {
  data: SettingsData;
  jingleRatio: string;
  setJingleRatio: (v: string) => void;
  busy: boolean;
  saveSettings: SaveSettings;
  jingleText: string;
  setJingleText: (s: string) => void;
  createJingle: () => Promise<boolean>;
  uploadJingle: (/* unchanged */) => Promise<JingleImportResult | null>;
  onDelete: (filename: string | null) => void;
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
}
```
`ImagingPanel` holds `jingleRatio` as a `useState<string>` hydrated from
`data.values.jingleRatio`. `SfxSection` and `BedsSection` already read their toggle
straight off `data.values` and never touch `form`, so they move with **no signature
change**.

### Settings cleanup (`SettingsPanel.tsx`)

Remove everything the three sections needed:
- From `SECTIONS`: drop the `jingles`, `sfx`, `beds` entries.
- Delete state: `jingleText`, `sfxData`, `sfxForm`, `confirmDeleteSfx`, `bedsData`,
  `confirmDeleteBed`, `confirmDelete` (jingle), and `refreshSfx` / `refreshBeds` (and
  their calls in the poll interval and mount effect).
- Delete handlers: `createJingle`, `deleteJingle`, `uploadJingle`, `createSfx`,
  `deleteSfx`, `uploadSfx`, `uploadBed`, `deleteBed`.
- Delete render branches: the `activeSection === 'jingles' | 'sfx' | 'beds'` blocks and
  their three `V3AlertDialog`s.
- Delete the sidebar-rail count badge special-casing for `jingles` / `sfx` / `beds`
  (the `s.id === 'jingles' …` ternary in the section rail collapses back to `s.hint`).
- Remove `jingleRatio` from `FormState` and its hydration line — it is no longer read by
  any settings section. (Verify no other Settings section references it first.)
- Drop now-unused imports (`JinglesSection`, `SfxSection`, `BedsSection`, `Music`,
  `AudioLines`, `Waves`, and any type-only imports that moved to `imaging/types`).

### Backward-compat redirect

Old bookmarks like `/admin/settings?section=jingles` must not dead-end. Add a small
effect at the top of `SettingsPanel` (alongside the existing `?section` deep-link
handler): if `?section` is one of `jingles | sfx | beds`, `router.replace(
'/admin/imaging?tab=<id>')`. Mirrors the archives/backup precedent already documented in
`SettingsPanel`.

### Sidebar (`AdminShell.tsx`)

Add to the **Programming** `NAV_SECTIONS` group, after Skills:
```ts
{ href: '/admin/imaging', id: 'imaging', label: 'Imaging', icon: Podcast },
```
Import `Podcast` from `lucide-react` — a distinct mic/broadcast-waves glyph, deliberately
different from the three tab icons (Music / AudioLines / Waves) and from every existing
sidebar icon. The breadcrumb in `ShellHeader` resolves automatically because it
looks the label up from `NAV` — no special-case needed (unlike DJ Doc / Playlists).

### Internal-link sweep

Grep the web app for links into the moved sections and repoint them at
`/admin/imaging?tab=…`:
```
grep -rn "section=jingles\|section=sfx\|section=beds\|settings?section=jingles" web/
```
Check onboarding, dash, and any "manage jingles" call-to-action. The controller API
routes (`/jingles`, `/sfx`, `/beds`) are unchanged, so no backend link changes.

## Data flow (unchanged)

Imaging talks to the same controller endpoints Settings used:
`GET/POST/DELETE /jingles`, `POST /jingles/upload`, `GET/POST/DELETE /sfx`,
`POST /sfx/upload`, `GET /beds`, `POST /beds/upload`, `DELETE /beds/:name`, and
`POST /settings` for the three toggles. Nothing server-side changes; this is a pure
front-end reorganisation.

## Testing

- **Lint/type gate:** `cd web && npm run lint` (eslint + `tsc --noEmit`) — the merge gate.
  Catches dangling imports and the `JinglesSection` prop change.
- **Manual (dev stack):**
  1. Sidebar shows **Imaging** under Programming; clicking it lands on `/admin/imaging`
     with the Jingles tab active and breadcrumb reading "Imaging".
  2. Each tab: create/generate, upload, and delete an asset; toggles save and reflect.
  3. Deep-link `/admin/imaging?tab=sfx` opens the SFX tab directly.
  4. Old `/admin/settings?section=beds` redirects to `/admin/imaging?tab=beds`.
  5. `/admin/settings` no longer lists Jingles / SFX / Beds and its other 12 sections
     still work (Station, Danger zone save-and-restart especially).

## Non-goals

- No change to jingle/sfx/bed generation, storage, or Liquidsoap playback.
- No redesign of the three sections' internals beyond the `JinglesSection` prop slimming.
- No consolidation of the three into a shared component — they stay three distinct tabs.

## Risks / notes

- **`FormState.jingleRatio` removal** is the one cross-cutting edit inside Settings;
  verify nothing else in `SettingsPanel` reads it before deleting (grep confirmed only
  `JinglesSection` did, but re-check after the move).
- The three components importing from `../settings/shared` creates an `imaging → settings`
  import edge. Acceptable: those are generic settings-save primitives. If we later want a
  hard boundary, promote `SectionHeader` + `SaveSettings` + `SettingsData` into a neutral
  `components/admin/shared/` — out of scope here.
