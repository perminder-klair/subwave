# Web Audio Format Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fifth gear control to the web player rail that opens an Audio drawer where listeners can select and persist MP3, Opus, AAC, or FLAC playback.

**Architecture:** Keep stream choice, URL switching, and runtime fallback inside `usePlayer`, supported by pure format/preference helpers in `web/lib/audioFormat.ts`. Feed the controller's existing public mount flags through `useStationFeed`; render availability and selection in a presentation-only `AudioDrawer` attached to the existing player sheet system.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript 5.8, Tailwind CSS, Radix Dialog through the existing `Sheet`, Lucide icons, Node's strict assertion module for pure tests.

## Global Constraints

- MP3 remains the default until the listener explicitly selects another format.
- Show MP3, Opus, AAC, and FLAC at all times, with distinct station-disabled and browser-unsupported reasons.
- Switch immediately while tuned in and remember the explicit choice per station origin.
- Preserve the existing iOS-family and Firefox chained-Ogg guard for Opus.
- A failed optional mount falls back to MP3 for the current page session without deleting the stored preference.
- Do not change Liquidsoap, station enablement settings, the native apps, or server endpoints.
- Preserve non-standard `NEXT_PUBLIC_STREAM_URL` behavior: the verbatim MP3 URL works, while optional sibling URLs remain unavailable when they cannot be inferred.

---

## File map

- Create `web/lib/audioFormat.ts`: format types, metadata, station/browser availability, preference key/load/save, and effective-selection helpers.
- Create `web/scripts/audio-format.test.ts`: dependency-free tests for the pure helper contract.
- Modify `web/package.json`: add the focused `test:audio-format` command.
- Modify `web/lib/stationOrigin.ts`: expose optional Opus, AAC, and FLAC mount URLs.
- Modify `web/lib/types.ts`: type the existing `/now-playing.stream` payload.
- Modify `web/hooks/useStationFeed.ts`: retain the public stream capability payload.
- Modify `web/hooks/usePlayer.ts`: restore preferences, select/reconnect formats, expose availability, and fall back to MP3 on optional-stream error.
- Create `web/components/drawers/AudioDrawer.tsx`: accessible four-format radio UI and fallback notice.
- Modify `web/components/CommandPalette.tsx`: add `audio` to `PlayerDrawer` and expose an Audio command.
- Modify `web/components/DotRail.tsx`: append the gear item and move the five-item rail upward.
- Modify `web/components/PlayerApp.tsx`: wire feed, player, rail, drawer, and title together.
- Modify `web/public/sw.js`: bypass AAC and FLAC live mounts as it already does MP3 and Opus.

---

### Task 1: Pure audio-format model and preferences

**Files:**
- Create: `web/lib/audioFormat.ts`
- Create: `web/scripts/audio-format.test.ts`
- Modify: `web/package.json`

**Interfaces:**
- Produces: `AudioFormat`, `StreamEnablement`, `BrowserSupport`, `FormatAvailability`, `AUDIO_FORMATS`, `availabilityFor()`, `preferenceKey()`, `loadFormatPreference()`, `saveFormatPreference()`, and `effectiveFormat()`.
- Consumes: no application state; functions remain browser-independent by accepting storage and support data as arguments.

- [ ] **Step 1: Write the failing pure tests**

Create `web/scripts/audio-format.test.ts` with cases for all four formats, station-disabled versus browser-unsupported reasons, per-station keys, invalid stored values, and MP3 fallback:

```ts
import assert from 'node:assert/strict';
import {
  AUDIO_FORMATS,
  availabilityFor,
  effectiveFormat,
  loadFormatPreference,
  preferenceKey,
  saveFormatPreference,
  type AudioFormat,
} from '../lib/audioFormat.ts';

const enabled = { mp3: true, opus: true, aac: false, flac: true } as const;
const supported = { mp3: true, opus: false, aac: true, flac: true } as const;

assert.deepEqual(AUDIO_FORMATS.map(x => x.id), ['mp3', 'opus', 'aac', 'flac']);
assert.deepEqual(availabilityFor(enabled, supported), {
  mp3: { available: true, reason: null },
  opus: { available: false, reason: 'Not supported by this browser' },
  aac: { available: false, reason: 'Not enabled by this station' },
  flac: { available: true, reason: null },
});
assert.notEqual(preferenceKey('/api'), preferenceKey('https://other.example/api'));

const values = new Map<string, string>();
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => { values.set(key, value); },
};
saveFormatPreference(storage, '/api', 'flac');
assert.equal(loadFormatPreference(storage, '/api'), 'flac');
values.set(preferenceKey('/api'), 'wav');
assert.equal(loadFormatPreference(storage, '/api'), null);

const available = availabilityFor(enabled, supported);
assert.equal(effectiveFormat('flac', available), 'flac');
assert.equal(effectiveFormat('opus', available), 'mp3');
assert.equal(effectiveFormat(null, available), 'mp3');

console.log('audio-format: all assertions passed');
```

- [ ] **Step 2: Add the test command and verify the test fails**

Add this script to `web/package.json`:

```json
"test:audio-format": "node --experimental-strip-types scripts/audio-format.test.ts"
```

Run: `cd web && npm run test:audio-format`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/audioFormat.ts`.

- [ ] **Step 3: Implement the pure model**

Create `web/lib/audioFormat.ts`:

```ts
export type AudioFormat = 'mp3' | 'opus' | 'aac' | 'flac';
export type StreamEnablement = Record<AudioFormat, boolean>;
export type BrowserSupport = Record<AudioFormat, boolean>;
export type FormatAvailability = Record<AudioFormat, {
  available: boolean;
  reason: 'Not enabled by this station' | 'Not supported by this browser' | null;
}>;

export const AUDIO_FORMATS = [
  { id: 'mp3', label: 'MP3', description: 'Universal compatibility' },
  { id: 'opus', label: 'Opus', description: 'Efficient, high-quality audio' },
  { id: 'aac', label: 'AAC', description: 'Modern compressed audio' },
  { id: 'flac', label: 'FLAC', description: 'Lossless broadcast audio' },
] as const satisfies readonly { id: AudioFormat; label: string; description: string }[];

const FORMAT_SET = new Set<AudioFormat>(AUDIO_FORMATS.map(x => x.id));

export function availabilityFor(
  enabled: StreamEnablement,
  supported: BrowserSupport,
): FormatAvailability {
  return Object.fromEntries(AUDIO_FORMATS.map(({ id }) => {
    const reason = !enabled[id]
      ? 'Not enabled by this station'
      : !supported[id]
        ? 'Not supported by this browser'
        : null;
    return [id, { available: reason === null, reason }];
  })) as FormatAvailability;
}

export function preferenceKey(stationId: string): string {
  return `subwave:audio-format:${encodeURIComponent(stationId)}`;
}

export function loadFormatPreference(
  storage: Pick<Storage, 'getItem'>,
  stationId: string,
): AudioFormat | null {
  const value = storage.getItem(preferenceKey(stationId));
  return value && FORMAT_SET.has(value as AudioFormat) ? value as AudioFormat : null;
}

export function saveFormatPreference(
  storage: Pick<Storage, 'setItem'>,
  stationId: string,
  format: AudioFormat,
): void {
  storage.setItem(preferenceKey(stationId), format);
}

export function effectiveFormat(
  preferred: AudioFormat | null,
  availability: FormatAvailability,
): AudioFormat {
  return preferred && availability[preferred].available ? preferred : 'mp3';
}
```

- [ ] **Step 4: Run the focused test**

Run: `cd web && npm run test:audio-format`

Expected: PASS and `audio-format: all assertions passed`.

- [ ] **Step 5: Commit the pure model**

```bash
git add web/lib/audioFormat.ts web/scripts/audio-format.test.ts web/package.json
git commit -m "test(web): define audio format selection model"
```

---

### Task 2: Expose all mount URLs and public capabilities

**Files:**
- Modify: `web/lib/stationOrigin.ts`
- Modify: `web/lib/types.ts`
- Modify: `web/hooks/useStationFeed.ts`
- Modify: `web/public/sw.js`

**Interfaces:**
- Consumes: `AudioFormat` and `StreamEnablement` from Task 1.
- Produces: `StationStreams` with `mp3: string`, `opus: string | null`, `aac: string | null`, `flac: string | null`; `PublicStreamInfo`; and `StationFeed.stream`.

- [ ] **Step 1: Extend the pure test with URL derivation expectations**

Export a new `streamsFromMp3Override()` helper from `stationOrigin.ts` only if it can remain free of React/environment reads. Prefer instead adding `deriveSiblingMounts()` to `audioFormat.ts`, then add:

```ts
import { deriveSiblingMounts } from '../lib/audioFormat.ts';

assert.deepEqual(deriveSiblingMounts('/stream.mp3'), {
  mp3: '/stream.mp3',
  opus: '/stream.opus',
  aac: '/stream.aac',
  flac: '/stream.flac',
});
assert.deepEqual(deriveSiblingMounts('https://custom.example/live'), {
  mp3: 'https://custom.example/live',
  opus: null,
  aac: null,
  flac: null,
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npm run test:audio-format`

Expected: FAIL because `deriveSiblingMounts` is not exported.

- [ ] **Step 3: Implement URL derivation and wire station origins**

Add to `audioFormat.ts`:

```ts
export interface AudioStreamUrls {
  mp3: string;
  opus: string | null;
  aac: string | null;
  flac: string | null;
}

export function deriveSiblingMounts(mp3: string): AudioStreamUrls {
  const marker = '/stream.mp3';
  const index = mp3.lastIndexOf(marker);
  if (index === -1) return { mp3, opus: null, aac: null, flac: null };
  const prefix = mp3.slice(0, index);
  const suffix = mp3.slice(index + marker.length);
  return {
    mp3,
    opus: `${prefix}/stream.opus${suffix}`,
    aac: `${prefix}/stream.aac${suffix}`,
    flac: `${prefix}/stream.flac${suffix}`,
  };
}
```

Replace `StationStreams` in `stationOrigin.ts` with `AudioStreamUrls`, use `deriveSiblingMounts(STREAM_URL_OVERRIDE || '/stream.mp3')`, and derive directory station streams with `deriveSiblingMounts(`${base}/stream.mp3`)`.

- [ ] **Step 4: Type and retain the existing public payload**

Add to `web/lib/types.ts`:

```ts
export interface PublicStreamInfo {
  mount: string;
  format: 'mp3';
  bitrate?: number | null;
  sampleRate?: number | null;
  channels?: number | null;
  opusEnabled: boolean;
  flacEnabled: boolean;
  aacEnabled: boolean;
}
```

Add `stream?: PublicStreamInfo` to `NowPlayingResponse`. Add `stream: PublicStreamInfo | null` to `StationFeed`, a corresponding state variable, update it from `npRes.stream ?? null`, and return it.

- [ ] **Step 5: Keep every live mount out of the service worker**

Change `web/public/sw.js` so the early bypass accepts all four paths:

```js
const LIVE_STREAM_PATHS = new Set([
  '/stream.mp3',
  '/stream.opus',
  '/stream.aac',
  '/stream.flac',
]);
if (LIVE_STREAM_PATHS.has(url.pathname)) return;
```

Update the file's opening comment to name all four mounts.

- [ ] **Step 6: Verify focused tests and types**

Run: `cd web && npm run test:audio-format && npm run typecheck`

Expected: both commands PASS.

- [ ] **Step 7: Commit mount discovery**

```bash
git add web/lib/audioFormat.ts web/scripts/audio-format.test.ts web/lib/stationOrigin.ts web/lib/types.ts web/hooks/useStationFeed.ts web/public/sw.js
git commit -m "feat(web): discover available audio mounts"
```

---

### Task 3: Make `usePlayer` format-selectable

**Files:**
- Modify: `web/hooks/usePlayer.ts`
- Modify: `web/lib/audioFormat.ts`
- Modify: `web/scripts/audio-format.test.ts`

**Interfaces:**
- Consumes: `StationStreams`, `StreamEnablement`, and the Task 1 preference/availability helpers.
- Produces: `UsePlayerOptions.streamEnablement`; player fields `format`, `availability`, `selectFormat`, and `formatFailure`.

- [ ] **Step 1: Add browser-support policy tests**

Add a pure `browserSupportFor()` policy that accepts generic codec answers and platform flags. Test the chained-Ogg rule without using the DOM:

```ts
import { browserSupportFor } from '../lib/audioFormat.ts';

const codecs = { mp3: 'probably', opus: 'probably', aac: 'maybe', flac: '' } as const;
assert.deepEqual(browserSupportFor(codecs, { ios: false, firefox: false }), {
  mp3: true, opus: true, aac: true, flac: false,
});
assert.equal(browserSupportFor(codecs, { ios: true, firefox: false }).opus, false);
assert.equal(browserSupportFor(codecs, { ios: false, firefox: true }).opus, false);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npm run test:audio-format`

Expected: FAIL because `browserSupportFor` is not exported.

- [ ] **Step 3: Implement the support policy**

Add to `audioFormat.ts`:

```ts
type CanPlayAnswer = '' | 'maybe' | 'probably';

export function browserSupportFor(
  codecs: Record<AudioFormat, CanPlayAnswer>,
  platform: { ios: boolean; firefox: boolean },
): BrowserSupport {
  return {
    mp3: codecs.mp3 !== '',
    opus: codecs.opus === 'probably' && !platform.ios && !platform.firefox,
    aac: codecs.aac !== '',
    flac: codecs.flac !== '',
  };
}
```

- [ ] **Step 4: Replace silent Opus upgrade with explicit format state**

In `usePlayer.ts`, add these public fields:

```ts
format: AudioFormat;
availability: FormatAvailability;
selectFormat: (format: AudioFormat) => void;
formatFailure: AudioFormat | null;
```

Add `streamEnablement?: StreamEnablement` to `UsePlayerOptions`, defaulting to MP3-only. On mount, build browser codec answers with:

```ts
const tester = document.createElement('audio');
const codecs = {
  mp3: tester.canPlayType('audio/mpeg'),
  opus: tester.canPlayType('audio/ogg; codecs=opus'),
  aac: tester.canPlayType('audio/aac'),
  flac: tester.canPlayType('audio/flac'),
};
```

Use `browserSupportFor`, mark null URLs disabled in the effective station enablement, and compute availability. Overlay `failedFormatsRef` so a format that fails at runtime becomes unavailable for the rest of the page session with reason `Stream failed; using MP3`. Extend `FormatAvailability`'s reason union and the drawer rendering to accept that exact reason. Restore `loadFormatPreference(localStorage, apiUrl)` after hydration. Obtain `apiUrl` alongside `streams` from `useStationOrigin`; it is the stable per-station preference identity.

Delete the current automatic Opus-upgrade effect and replace `opusFailedRef` with `failedFormatsRef: Set<AudioFormat>`.

- [ ] **Step 5: Implement immediate selection and fallback**

Implement `selectFormat(next)` so it ignores unavailable values, stores the explicit preference, updates the URL/ref, clears the current failure notice, and, when tuned in, increments the generation then assigns the cache-busted URL and calls `play()` with status `connecting`.

In `onError`, resolve the active format from a ref. For a non-MP3 format:

```ts
failedFormatsRef.current.add(activeFormatRef.current);
setFormatFailure(activeFormatRef.current);
activeFormatRef.current = 'mp3';
streamUrlRef.current = streamsRef.current.mp3;
setFormat('mp3');
setStreamUrl(streamsRef.current.mp3);
```

Do not overwrite localStorage during this runtime fallback. Continue through the existing exponential reconnect scheduling so MP3 resumes.

- [ ] **Step 6: Run focused tests and typecheck**

Run: `cd web && npm run test:audio-format && npm run typecheck`

Expected: both commands PASS.

- [ ] **Step 7: Commit player behavior**

```bash
git add web/hooks/usePlayer.ts web/lib/audioFormat.ts web/scripts/audio-format.test.ts
git commit -m "feat(web): switch and persist audio formats"
```

---

### Task 4: Add the gear rail item and Audio drawer

**Files:**
- Create: `web/components/drawers/AudioDrawer.tsx`
- Modify: `web/components/CommandPalette.tsx`
- Modify: `web/components/DotRail.tsx`
- Modify: `web/components/PlayerApp.tsx`

**Interfaces:**
- Consumes: `AudioFormat`, `FormatAvailability`, `AUDIO_FORMATS`, and the new `Player` fields from Task 3.
- Produces: an accessible Audio drawer and fifth rail control.

- [ ] **Step 1: Create the presentation-only drawer**

Create `AudioDrawer.tsx` with this public contract:

```ts
export interface AudioDrawerProps {
  format: AudioFormat;
  availability: FormatAvailability;
  failure: AudioFormat | null;
  onSelect: (format: AudioFormat) => void;
}
```

Render a `<fieldset>` with `<legend className="sr-only">Audio format</legend>`. Map `AUDIO_FORMATS` to labelled radio inputs. Disable unavailable rows, display `entry.description`, and display `availability[entry.id].reason` when present. Show a non-color-only selected indicator such as “Selected”. If `failure` is non-null, render `Couldn't load {LABEL}; playback fell back to MP3.` in a `role="status"` notice above the options.

Use existing theme tokens (`bg-bg`, `text-ink`, `text-muted`, `border-ink`, `text-vermilion`) and `v3-focus`; do not introduce raw light/dark colors.

- [ ] **Step 2: Extend the drawer identifier and palette**

Change the union in `CommandPalette.tsx`:

```ts
export type PlayerDrawer = 'timeline' | 'booth' | 'request' | 'schedule' | 'audio';
```

Add `{ label: 'Audio format', hint: '', onSelect: run(() => onOpenDrawer('audio')) }` to the command palette. Render the `<Kbd>` only when `hint` is non-empty so the command does not advertise an unimplemented shortcut.

- [ ] **Step 3: Add the fifth rail item and shift the group upward**

Import `Settings` from `lucide-react`. Extend the DotRail item model with an optional fixed icon and append:

```ts
{ k: 'audio', l: 'Audio', icon: <Settings size={20} strokeWidth={1.5} /> }
```

Use the fixed icon before counts/request handling. Change the rail container from vertically centered to an upward-biased layout that retains safe top/bottom bounds, for example:

```tsx
className="absolute top-16 right-0 bottom-20 z-20 flex w-24 flex-col items-center justify-start gap-1 pt-2 sm:top-20 sm:pt-4"
```

Confirm visually that all five controls remain above the transport bar at the narrowest supported viewport and inside the contained showcase.

- [ ] **Step 4: Wire PlayerApp**

Import `AudioDrawer`. Add `audio: 'Audio format'` to `DRAWER_TITLES`. Derive station enablement from the feed:

```ts
const streamEnablement = {
  mp3: true,
  opus: stream?.opusEnabled === true,
  aac: stream?.aacEnabled === true,
  flac: stream?.flacEnabled === true,
};
```

Pass it to `usePlayer({ streamEnablement })`, destructure the new format fields, and add:

```tsx
{drawer === 'audio' && (
  <AudioDrawer
    format={format}
    availability={availability}
    failure={formatFailure}
    onSelect={selectFormat}
  />
)}
```

Because the feed arrives after the initial render, memoize `streamEnablement` or have `usePlayer` depend on its boolean members rather than object identity.

- [ ] **Step 5: Run all web static verification**

Run: `cd web && npm run test:audio-format && npm run lint`

Expected: pure tests, ESLint, and `tsc --noEmit` all PASS.

- [ ] **Step 6: Commit the UI**

```bash
git add web/components/drawers/AudioDrawer.tsx web/components/CommandPalette.tsx web/components/DotRail.tsx web/components/PlayerApp.tsx
git commit -m "feat(web): add audio format drawer"
```

---

### Task 5: Browser verification and final regression pass

**Files:**
- Modify only files from Tasks 1–4 if verification finds a defect.

**Interfaces:**
- Consumes: the complete feature.
- Produces: verified responsive behavior and a clean web-client validation run.

- [ ] **Step 1: Start the web client against the dev stack**

Run: `cd web && npm run dev`

Expected: Next.js reports the player at `http://localhost:7700` with no compilation error. If the radio dev stack is not already running, use the repository's SUB/WAVE control workflow before testing live mounts.

- [ ] **Step 2: Verify clean-profile and availability behavior**

In a fresh browser profile, open `/listen`, confirm MP3 is selected, open the gear drawer, and confirm all four rows appear. Compare disabled reasons with `/api/now-playing.stream`: station-disabled takes precedence over browser-unsupported.

- [ ] **Step 3: Verify live switching and persistence**

With at least one optional mount enabled, tune in and select it. Confirm the audio element reconnects immediately, remains tuned in, and the selected radio state updates. Reload and confirm the same station restores the explicit format. Switch to another directory station and confirm its preference remains independent.

- [ ] **Step 4: Verify runtime fallback**

Use browser devtools request blocking for the selected optional mount, select it, and confirm playback falls back to MP3, the optional row becomes unavailable for the page session, and the drawer displays the fallback status. Reload without blocking and confirm the stored optional preference is tried again.

- [ ] **Step 5: Verify rail layouts and accessibility**

Check desktop, a narrow mobile viewport, and the contained landing showcase. Confirm five controls fit without overlapping the top or transport bars, the gear opens/closes the shared sheet, keyboard focus is visible, arrow/tab navigation reaches each radio, disabled reasons are readable, and the selected state is announced.

- [ ] **Step 6: Run final verification**

Run:

```bash
cd web
npm run test:audio-format
npm run lint
npm run build
```

Expected: all three commands exit 0. Review `git diff --check` and confirm only intended feature files changed.

- [ ] **Step 7: Commit any verification fixes**

If verification required changes:

```bash
git add web
git commit -m "fix(web): polish audio format selection"
```

If no files changed, do not create an empty commit.
