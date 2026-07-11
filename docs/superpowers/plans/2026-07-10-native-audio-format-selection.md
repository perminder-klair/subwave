# Native Audio Format Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add persistent, per-station MP3, Opus, AAC, and FLAC selection to the Expo app while disabling unverified combinations and falling back safely to MP3.

**Architecture:** A pure audio-format module owns metadata, platform reliability, availability, preference resolution, and URL selection. The station feed supplies existing server flags; `usePlayer` remains the sole playback owner for hydration, switching, reconnect, and fallback. A presentation-only drawer plugs into the existing Back Panel sheet.

**Tech Stack:** Expo SDK 56, React Native 0.85, TypeScript 6, React Native Track Player 4.1.2, AsyncStorage 2.2, Node assertions.

## Global Constraints

- Always show MP3, Opus, AAC, and FLAC in that order.
- Initially enable MP3 and AAC on iOS and Android; keep Opus and FLAC disabled pending physical-device chained-Ogg transition testing.
- A format is selectable only when both station and platform allow it.
- MP3 is the default and only runtime fallback.
- Preferences are scoped by normalized station origin and retained after a session failure.
- Basic-auth credentials stay in `streamHeaders()`, never in the stream URL.
- Do not change controller, Liquidsoap, dependencies, or station settings.

---

## File Structure

- Create `app/src/lib/audioFormat.ts`: pure types, policy, availability, preference resolution, URL selection, error-generation guard.
- Create `app/src/lib/audioFormatStorage.ts`: AsyncStorage adapter.
- Create `app/scripts/audio-format.test.ts`: dependency-free policy/API tests.
- Create `app/src/player/drawers/AudioFormatDrawer.tsx`: presentation-only selector.
- Modify `app/package.json`, `app/src/lib/types.ts`, `app/src/lib/api.ts`, `app/src/hooks/useStationFeed.ts`, `app/src/hooks/usePlayer.ts`, `app/src/player/drawers/BackPanelDrawer.tsx`, and `app/src/player/PlayerScreen.tsx`.

### Task 1: Pure Format Policy and Persistence

**Files:**
- Create: `app/src/lib/audioFormat.ts`
- Create: `app/src/lib/audioFormatStorage.ts`
- Create: `app/scripts/audio-format.test.ts`
- Modify: `app/package.json`

**Interfaces:**
- Produces: `AudioFormat`, `StreamEnablement`, `StreamUrls`, `FormatAvailability`, `FORMAT_OPTIONS`, `availabilityFor`, `resolveFormatPreference`, `streamPreferenceKey`, `streamUrlFor`, `loadFormatPreference`, and `saveFormatPreference`.

- [ ] **Step 1: Write the failing policy test**

Create `app/scripts/audio-format.test.ts`:

```ts
import assert from 'node:assert/strict';
import {
  FORMAT_OPTIONS, availabilityFor, resolveFormatPreference,
  streamPreferenceKey, streamUrlFor, type StreamUrls,
} from '../src/lib/audioFormat.ts';

const enabled = { mp3: true, opus: true, aac: true, flac: true } as const;
const urls: StreamUrls = {
  mp3: 'https://radio.test/stream.mp3',
  opus: 'https://radio.test/stream.opus',
  aac: 'https://radio.test/stream.aac',
  flac: 'https://radio.test/stream.flac',
};
assert.deepEqual(FORMAT_OPTIONS.map((f) => f.id), ['mp3', 'opus', 'aac', 'flac']);
for (const platform of ['ios', 'android'] as const) {
  const a = availabilityFor(platform, enabled, new Set());
  assert.equal(a.mp3.available, true);
  assert.equal(a.aac.available, true);
  assert.deepEqual(a.opus, { available: false, reason: 'device' });
  assert.deepEqual(a.flac, { available: false, reason: 'device' });
}
assert.equal(availabilityFor('ios', { ...enabled, aac: false }, new Set()).aac.reason, 'station');
assert.equal(availabilityFor('ios', enabled, new Set(['aac'])).aac.reason, 'failed');
assert.equal(resolveFormatPreference('aac', availabilityFor('ios', enabled, new Set())), 'aac');
assert.equal(resolveFormatPreference('opus', availabilityFor('ios', enabled, new Set())), 'mp3');
assert.equal(streamPreferenceKey('https://RADIO.test/'), 'subwave.audio-format.v1:https://radio.test');
assert.equal(streamUrlFor(urls, 'flac'), 'https://radio.test/stream.flac');
console.log('audio-format tests passed');
```

- [ ] **Step 2: Add the test command and prove red**

Add to `app/package.json`:

```json
"test:audio-format": "node --experimental-strip-types scripts/audio-format.test.ts"
```

Run: `cd app && npm run test:audio-format`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `audioFormat.ts`.

- [ ] **Step 3: Implement the pure module**

Create `app/src/lib/audioFormat.ts` with these public contracts:

```ts
export type AudioFormat = 'mp3' | 'opus' | 'aac' | 'flac';
export type NativePlatform = 'ios' | 'android';
export type UnavailableReason = 'station' | 'device' | 'failed';
export type StreamEnablement = Record<AudioFormat, boolean>;
export type StreamUrls = Record<AudioFormat, string>;
export type FormatAvailability = Record<AudioFormat, {
  available: boolean; reason?: UnavailableReason;
}>;

export const FORMAT_OPTIONS = [
  { id: 'mp3', label: 'MP3', description: 'Universal compatibility' },
  { id: 'opus', label: 'Opus', description: 'Efficient, high-quality audio' },
  { id: 'aac', label: 'AAC', description: 'Broadly compatible audio' },
  { id: 'flac', label: 'FLAC', description: 'Lossless processed broadcast' },
] as const;

const DEVICE_SUPPORT = {
  ios: { mp3: true, opus: false, aac: true, flac: false },
  android: { mp3: true, opus: false, aac: true, flac: false },
} as const;

export function availabilityFor(
  platform: NativePlatform, enabled: StreamEnablement,
  failed: ReadonlySet<AudioFormat>,
): FormatAvailability {
  return Object.fromEntries(FORMAT_OPTIONS.map(({ id }) => {
    if (!enabled[id]) return [id, { available: false, reason: 'station' }];
    if (!DEVICE_SUPPORT[platform][id]) return [id, { available: false, reason: 'device' }];
    if (failed.has(id)) return [id, { available: false, reason: 'failed' }];
    return [id, { available: true }];
  })) as FormatAvailability;
}

export function resolveFormatPreference(
  stored: AudioFormat | null, availability: FormatAvailability,
): AudioFormat {
  return stored && availability[stored].available ? stored : 'mp3';
}
export function streamPreferenceKey(base: string): string {
  return `subwave.audio-format.v1:${base.trim().replace(/\/+$/, '').toLowerCase()}`;
}
export function streamUrlFor(urls: StreamUrls, format: AudioFormat): string {
  return urls[format];
}
```

- [ ] **Step 4: Add AsyncStorage persistence**

Create `app/src/lib/audioFormatStorage.ts`:

```ts
import AsyncStorage from '@react-native-async-storage/async-storage';
import { FORMAT_OPTIONS, streamPreferenceKey, type AudioFormat } from './audioFormat';

const IDS = new Set<string>(FORMAT_OPTIONS.map((f) => f.id));
export async function loadFormatPreference(base: string): Promise<AudioFormat | null> {
  const value = await AsyncStorage.getItem(streamPreferenceKey(base));
  return value && IDS.has(value) ? value as AudioFormat : null;
}
export function saveFormatPreference(base: string, format: AudioFormat): Promise<void> {
  return AsyncStorage.setItem(streamPreferenceKey(base), format);
}
```

- [ ] **Step 5: Verify and commit**

Run: `cd app && npm run test:audio-format && npm run typecheck`

Expected: both commands exit 0 and tests print `audio-format tests passed`.

```bash
git add app/package.json app/src/lib/audioFormat.ts app/src/lib/audioFormatStorage.ts app/scripts/audio-format.test.ts
git commit -m "feat(app): add native audio format policy"
```

### Task 2: Stream Discovery and URLs

**Files:**
- Modify: `app/src/lib/types.ts`
- Modify: `app/src/lib/api.ts`
- Modify: `app/src/hooks/useStationFeed.ts`
- Modify: `app/scripts/audio-format.test.ts`

**Interfaces:**
- Produces: `PublicStreamInfo`, `StationApi.streamUrls(): StreamUrls`, and `StationFeed.stream`.

- [ ] **Step 1: Add a failing API URL test**

Append:

```ts
import { createApi } from '../src/lib/api.ts';
const api = createApi('https://user:pass@Radio.Test/');
assert.deepEqual(api.streamUrls(), {
  mp3: 'https://Radio.Test/stream.mp3',
  opus: 'https://Radio.Test/stream.opus',
  aac: 'https://Radio.Test/stream.aac',
  flac: 'https://Radio.Test/stream.flac',
});
assert.ok(api.streamHeaders()?.Authorization?.startsWith('Basic '));
```

Run: `cd app && npm run test:audio-format`

Expected: FAIL because `streamUrls` does not exist.

- [ ] **Step 2: Type the existing server object**

Add to `app/src/lib/types.ts` and add `stream?: PublicStreamInfo` to `NowPlayingResponse`:

```ts
export interface PublicStreamInfo {
  mount: '/stream.mp3';
  format: 'mp3';
  bitrate?: number | null;
  sampleRate?: number | null;
  channels?: number | null;
  opusEnabled?: boolean;
  aacEnabled?: boolean;
  flacEnabled?: boolean;
}
```

- [ ] **Step 3: Expose sibling URLs**

Import `StreamUrls` in `app/src/lib/api.ts`. Replace `streamUrl(): string` with `streamUrls(): StreamUrls` and return:

```ts
streamUrls: () => ({
  mp3: `${cleanBase}/stream.mp3`,
  opus: `${cleanBase}/stream.opus`,
  aac: `${cleanBase}/stream.aac`,
  flac: `${cleanBase}/stream.flac`,
}),
```

Keep `streamHeaders()` unchanged. Mechanically change existing playback call sites to `streamUrls().mp3` so this task remains green.

- [ ] **Step 4: Retain capabilities in the feed**

In `useStationFeed.ts`, import `PublicStreamInfo`, add `stream: PublicStreamInfo | null` to `StationFeed`, add state, reset it on station change, apply `npRes.stream ?? null` through `setIfChanged('stream', ...)`, and return it.

- [ ] **Step 5: Verify and commit**

Run: `cd app && npm run test:audio-format && npm run typecheck`

Expected: both pass.

```bash
git add app/src/lib/types.ts app/src/lib/api.ts app/src/hooks/useStationFeed.ts app/src/hooks/usePlayer.ts app/scripts/audio-format.test.ts
git commit -m "feat(app): discover station audio formats"
```

### Task 3: Player Selection and Fallback

**Files:**
- Modify: `app/src/lib/audioFormat.ts`
- Modify: `app/scripts/audio-format.test.ts`
- Modify: `app/src/hooks/usePlayer.ts`

**Interfaces:**
- Produces on `Player`: `format`, `availability`, `selectFormat`, `formatFailure`.
- Changes hook signature to `usePlayer(api, initialVolume, isConnected, streamEnablement)`.

- [ ] **Step 1: Test the generation guard**

Append:

```ts
import { fallbackForPlaybackError } from '../src/lib/audioFormat.ts';
assert.deepEqual(fallbackForPlaybackError('aac', 4, 4), { fallback: 'mp3', failed: 'aac' });
assert.equal(fallbackForPlaybackError('aac', 3, 4), null);
assert.equal(fallbackForPlaybackError('mp3', 4, 4), null);
```

Run: `cd app && npm run test:audio-format`

Expected: FAIL because the export is missing.

- [ ] **Step 2: Implement the guard**

```ts
export function fallbackForPlaybackError(
  format: AudioFormat, errorGeneration: number, activeGeneration: number,
): { fallback: 'mp3'; failed: AudioFormat } | null {
  if (errorGeneration !== activeGeneration || format === 'mp3') return null;
  return { fallback: 'mp3', failed: format };
}
```

Run the focused test; expected PASS.

- [ ] **Step 3: Extend player inputs and output**

Add `format: AudioFormat`, `availability: FormatAvailability`, `selectFormat(format)`, and `formatFailure` to `Player`. Add the fourth parameter:

```ts
streamEnablement: StreamEnablement =
  { mp3: true, opus: false, aac: false, flac: false }
```

Import `Platform`, policy helpers/types, and storage helpers.

- [ ] **Step 4: Add state, refs, and hydration**

Add `format`, `formatFailure`, `failedFormatsRef`, `formatRef`, `volumeRef`, `playbackGenerationRef`, and `formatHydrationPromiseRef`. Derive availability with:

```ts
availabilityFor(
  Platform.OS === 'ios' ? 'ios' : 'android',
  streamEnablement,
  failedFormatsRef.current,
)
```

On base/enablement changes, asynchronously load and resolve the station preference. Use an `alive` flag and captured base. Reset failures on station change. Store the hydration promise so a first tune waits for it before reading `formatRef`.

- [ ] **Step 5: Centralize every live load**

Add a callback used by tune, reconnect, switching, and fallback:

```ts
const loadFormat = useCallback(async (next: AudioFormat) => {
  const a = apiRef.current;
  if (!a) return;
  const generation = ++playbackGenerationRef.current;
  currentLoadGenerationRef.current = generation;
  formatRef.current = next;
  await loadAndPlay({
    url: streamUrlFor(a.streamUrls(), next),
    headers: a.streamHeaders(),
  });
  await TrackPlayer.setVolume(volumeRef.current);
}, []);
```

Replace every direct MP3 load with `loadFormat(formatRef.current)`. This is required so watchdog reconnects never revert the selected mount.

- [ ] **Step 6: Implement selection**

Reject unavailable choices. Persist a valid choice for `api.base`. While idle, update only the next target. While tuned in, clear the watchdog, set `connecting`, and call `loadFormat(next)`; on a thrown load, arm existing backoff.

- [ ] **Step 7: Implement optional-format fallback**

In `PlaybackError`, call `fallbackForPlaybackError` with the format and generation captured for the active load. For a valid optional-format failure: add it to the failed set, set `formatFailure`, set active target to MP3, and immediately `loadFormat('mp3')`. Do not overwrite AsyncStorage. MP3 errors use existing retry behavior. A late error from an older generation must do nothing.

- [ ] **Step 8: Protect first tune and station changes**

Make `tune()` await `formatHydrationPromiseRef.current` before loading. Capture the station base at tap time and abort if it changes. On station switch, existing teardown remains authoritative, in-memory format returns to MP3, failures clear, and the new preference hydrates.

- [ ] **Step 9: Verify and commit**

Run: `cd app && npm run test:audio-format && npm run typecheck && npm run lint`

Expected: all pass.

```bash
git add app/src/lib/audioFormat.ts app/scripts/audio-format.test.ts app/src/hooks/usePlayer.ts
git commit -m "feat(app): switch live audio formats"
```

### Task 4: Back Panel UI

**Files:**
- Create: `app/src/player/drawers/AudioFormatDrawer.tsx`
- Modify: `app/src/player/drawers/BackPanelDrawer.tsx`
- Modify: `app/src/player/PlayerScreen.tsx`

**Interfaces:**
- Consumes Task 3 player fields and Task 1 format metadata.

- [ ] **Step 1: Create the drawer**

Use props:

```ts
export interface AudioFormatDrawerProps {
  format: AudioFormat;
  availability: FormatAvailability;
  formatFailure: AudioFormat | null;
  onSelect: (format: AudioFormat) => void;
}
```

Render `FORMAT_OPTIONS` as themed Pressable rows with `accessibilityRole="radio"` and checked/disabled accessibility state. Use:

```ts
const REASON_TEXT = {
  station: 'Not enabled by station',
  device: 'Not supported on this device',
  failed: 'Playback failed this session',
} as const;
```

Show `Playback fell back to MP3.` when `formatFailure` is non-null. Match the bordered row vocabulary of Sleep/Themes.

- [ ] **Step 2: Add the Back Panel row**

Add `audioFormatLabel` and `onOpenAudio` props. Import `AudioLines` and add before TIMER:

```tsx
<SectionLabel text="AUDIO" />
<PanelRow
  icon={<AudioLines size={18} color={colors.muted} />}
  title="Audio format"
  value={audioFormatLabel}
  onPress={onOpenAudio}
/>
<View style={{ height: 14 }} />
```

- [ ] **Step 3: Wire feed enablement to the player**

In `PlayerScreen`, derive:

```ts
const streamEnablement = useMemo(() => ({
  mp3: true,
  opus: stream?.opusEnabled === true,
  aac: stream?.aacEnabled === true,
  flac: stream?.flacEnabled === true,
}), [stream?.opusEnabled, stream?.aacEnabled, stream?.flacEnabled]);
```

Restructure hook ordering without conditional calls so `useStationFeed` supplies `stream` and `usePlayer` receives enablement while background metadata polling still follows local tuned-in state. If needed, hold the local tuned-in value in a ref passed as a stable feed option; do not duplicate either hook.

- [ ] **Step 4: Wire sheet state**

Extend sheet state with `'audio'`. Keep format controls from `localPlayer`, not Cast's transport overlay. Resolve the current label from `FORMAT_OPTIONS`, pass the new Back Panel props, title the sheet `Audio format`, and render `AudioFormatDrawer` with the Task 3 fields.

- [ ] **Step 5: Verify and commit**

Run: `cd app && npm run test:audio-format && npm run typecheck && npm run lint`

Expected: all pass with no hook-order or TypeScript errors.

```bash
git add app/src/player/drawers/AudioFormatDrawer.tsx app/src/player/drawers/BackPanelDrawer.tsx app/src/player/PlayerScreen.tsx
git commit -m "feat(app): add audio format selector"
```

### Task 5: Physical-Device and Final Verification

**Files:**
- Verify only.

- [ ] **Step 1: Run the full app checks**

Run:

```bash
cd app
npm run test:audio-format
npm run typecheck
npm run lint
npx expo-doctor
```

Expected: all exit 0; the focused test prints `audio-format tests passed`.

- [ ] **Step 2: Verify Android and iOS**

On one physical device per platform, with an AAC-enabled station, confirm:

1. All four formats appear.
2. MP3/AAC select; Opus/FLAC say `Not supported on this device`.
3. Station-disabled AAC says `Not enabled by station`.
4. Idle and live selection target the correct mount.
5. Per-station preference survives relaunch and station switching.
6. MP3 and AAC survive two track transitions.
7. A forced optional-mount failure falls back visibly to MP3.
8. Background and lock-screen controls still work.
9. AirPlay on iOS and Cast on Android survive switching.

Expected: all pass; capture one selector screenshot per platform and concise device/OS results without committing screenshots.

- [ ] **Step 3: Inspect final scope**

Run: `git diff --check HEAD~4..HEAD`, `git diff --stat HEAD~4..HEAD`, and `git status --short`.

Expected: no whitespace errors, only planned files changed, and the pre-existing `controller/scripts/__pycache__/` remains untouched.

