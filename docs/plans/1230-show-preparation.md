# Custom skills that prepare a show

Approved design for [issue #1230](https://github.com/perminder-klair/subwave/issues/1230), now implemented. The signatures below record the planning sketch; the implementation uses the existing picker and speech interfaces.

## Problem

The requested show chooses one random library artist, plays that artist's music, and builds an intro, facts and closing summary around them. Custom skills currently fetch data for spoken segments. Their results do not control the music picker or the fallback playlist, and naming a skill in a brief cannot execute it.

Add a reusable, optional **show preparation skill**. The controller runs its data tool before selecting the episode's first track, saves the result, and gives that result to music selection and speech. The first version selects one required skill explicitly in the show editor. This covers the reported workflow without relying on the model to choose whether to call it.

## Usage

The operator creates or imports `random-artist-pick`, enables it, assigns it to the host, and selects it in the show's new **Show preparation skill** field. They enable Programme for the existing intro, feature and outro structure. Preparation also works for ordinary shows and when station voice is off.

```json
{
  "name": "Artist deep dive",
  "programme": true,
  "preparationSkill": "random-artist-pick",
  "topic": "Explore the prepared artist's career. Open by naming them, connect their records with the supplied research, and close with a summary."
}
```

The existing five-argument `tool.mjs` function stays the execution contract. Its result opts into the following preparation shape:

```js
return {
  available: true,
  subject: artist.name,
  data: {
    // Bounded library information and research results, including sources.
    research,
  },
  music: { type: 'artist', artistId: artist.id },
};
```

`music` is optional, so another custom skill can prepare a subject and data without restricting music. `{ available: false, reason: '...' }` means preparation found nothing usable. Arbitrary legacy segment output is not guessed into an artist restriction. The reported tool will need this small return-shape adaptation.

Ship a copy-ready `random-artist-pick` example with `SKILL.md` and `tool.mjs`. Add `services.library.randomArtist({ minDistinctTracks: 2 })` to the existing station facade. The example chooses an artist, gathers bounded research through `services.searchWeb`, and returns the preparation result. Missing web results produce empty research rather than invented facts. The example is installed and enabled explicitly.

## Shape

### Callers first

```ts
// Prepare for the track's forecast show without rolling the outgoing session.
const episode = await showPreparation.ensure({ context: pickCtx });
// The same episode view supplies both the music source and editorial context.
await runTrackEvent(queue, pickCtx, { ...pickOptions, episode });

// An LLM-free fallback build observes the same saved choice.
const episode = await showPreparation.ensure({ context: liveCtx });
await buildAndPublishAutoPlaylist({ context: liveCtx, episode });

// Reading speech context cannot execute a tool or choose another artist.
const episode = showPreparation.read({ context: beatCtx });
await generateProgrammeFeature({ ...featureArgs, editorial: episode.editorial });
```

These are proposed signatures, not calls already present in the repository. Existing stable LLM barrels remain the import boundaries.

### Domain sketch

Derive tool-output and durable-record types from their Zod schemas. Parse external JSON once. The public view has explicit variants rather than independent nullable locks and track lists.

```ts
type OccurrenceId = string & { readonly __brand: 'ShowOccurrenceId' };

type ShowOccurrence = {
  id: OccurrenceId;
  showId: string;
  source: 'scheduled' | 'takeover';
  startsAt: number;
  endsAt: number;
};

type EpisodeMusic =
  | { kind: 'ordinary'; identity: string }
  | {
      kind: 'artist';
      identity: string;
      artist: LibraryArtist;
      tracks: readonly CatalogTrack[];
      ids: ReadonlySet<string>;
    };

type EpisodeEditorial =
  | { kind: 'ordinary' }
  | {
      kind: 'prepared';
      subject: string;
      data: PreparationData;
      research: 'available' | 'absent';
      music: 'restricted' | 'ordinary' | 'degraded';
    };

type PreparationStatus =
  | { kind: 'unconfigured' }
  | { kind: 'pending'; occurrence: ShowOccurrence }
  | { kind: 'selected'; occurrence: ShowOccurrence }
  | { kind: 'ready'; occurrence: ShowOccurrence; skill: string }
  | { kind: 'failed'; occurrence: ShowOccurrence; reason: string }
  | { kind: 'degraded'; occurrence: ShowOccurrence; reason: string };

type EpisodeView = {
  status: PreparationStatus;
  music: EpisodeMusic;
  editorial: EpisodeEditorial;
};

interface ShowPreparation {
  recover(): Promise<void>;
  ensure(args: { context: SessionContext }): Promise<EpisodeView>;
  read(args: { context: SessionContext }): EpisodeView;
}
```

`CatalogTrack` reuses the existing music track projection. `LibraryArtist` is the resolved library identity. `PreparationData` is validated, bounded JSON. Music membership and canonical artist naming never come from model-generated text.

### Ownership

| Location | Responsibility |
| --- | --- |
| New `broadcast/show-preparation.ts` | Sole owner of preparation, occurrence lookup, concurrent-call coalescing, durable results and status. |
| New `broadcast/show-occurrence.ts` | Pure identity and span calculation using the existing show, schedule, takeover and station-time rules. |
| New `schemas/show-preparation.ts` | Tool result and stored-state schemas. Imports only Zod. |
| Existing `llm/segment-tools.ts` | Reuse `fetchSegmentData` for bounded data-only execution, with the existing eight-second timeout and error handling. |
| Existing `skills/eligibility.ts` | Shared automatic eligibility, including the distinction between preparation and spoken use. |
| New `music/episode-source.ts` | Exact artist catalogue resolution and shared membership policy for automatic music. |
| Existing library and StationServices modules | Exact artist reads and the additive random-artist helper. |

The preparation owner writes one atomic `state/show-preparations.json` inside the controller's configured state directory. It stores occurrence snapshots and accepted tool results, not a second copy of the track database. It retains current, incoming and temporarily interrupted scheduled occurrences, then prunes expired records. Track catalogues are derived and cached under the saved artist identity.

The public interface hides execution, persistence and retry sequencing. Music consumes one source value; speech consumes one editorial snapshot. No caller reads the preparation file or executes the chosen tool independently.

## Occurrence and recovery rules

- One episode is one contiguous scheduled airing or one takeover identified by its persisted start. A six-hour show keeps its chosen artist across the DJ's four-hour chat reset. A later airing gets a new choice.
- Resolve scheduled spans in the station timezone with absolute timestamps. Test midnight, the weekly seam and daylight-saving transitions. For a show occupying every hour of the week, Sunday 00:00 station time starts a new episode.
- Returning from a temporary takeover reuses the underlying scheduled occurrence's saved choice while that occurrence remains active.
- Preparation starts before the first incoming music pick, including same-host transitions. Startup and fallback refresh can also call `ensure`. It does not depend on Programme, spoken handoffs, listener count, voice enablement or an LLM token budget.
- Coalesce simultaneous calls. Save the parsed tool result before slower catalogue resolution. Save a ready result before exposing its music or editorial context. A catalogue retry reads the accepted result instead of rerunning the random chooser.
- Recover records before the track watcher and automatic selection start. Once saved, artist selection survives a controller restart. Arbitrary external tool execution can repeat if the process crashes before saving its result; do not claim transactional execution of operator code.
- Freeze the selected preparation skill and subject for the airing. Changes to that skill selection after commitment take effect on the next airing. Catalogue safety checks remain live.
- Recheck occurrence and configuration ownership after asynchronous work. A cancelled takeover or expired incoming episode cannot publish a new fallback or supply current-show speech. Capture outgoing and incoming editorial snapshots separately.

## Eligibility and repeated execution

Preparation checks global enablement, host ownership, tool availability and readiness through existing policy. Custom skills remain disabled until enabled. Speech-only cohost casting, cooldowns and talk windows do not gate data-only preparation.

Reserve the configured preparation skill from automatic spoken use during its episode. The segment director, skill crons, programme feature menu and automatic pinned-feature runner must use the same purpose-aware rule. Otherwise a later feature can rerun the random chooser and announce another artist. Preparation does not update successful-air cooldowns or talk bookkeeping.

Strict show saves reject identical nonempty `preparationSkill` and `segmentSkill` values with a field error. Manual Run now and explicit operator commands retain their existing override semantics.

## Music and speech

Resolve the artist by exact library ID. Prefer indexed artist reads from a complete metadata mirror, including untagged tracks. If that mirror is unavailable or incomplete, use bounded artist-only Subsonic reads. Do not scan the whole library, use popularity-ranked top songs as the full catalogue, or use loose artist-name aliases as a hard membership rule. A collaboration belongs when its track artist or explicit lead album artist ID matches the selected artist.

Carry one episode source in `PickerScope`. Add a guaranteed episode-tracks discovery tool and intersect every discovery result with the permitted IDs before inserting it into `seen`. Feed the same source to the pool picker and `auto.m3u` builder. Preserve the restriction through repair, repick and ordinary recency relaxation.

Intentional single-artist music bypasses artist-variety rescue and per-artist caps. Preserve track identity deduplication and size the hard no-repeat window from the actual permitted catalogue. Prefer at least two distinct songs in the random example. A custom one-song result remains valid, with fallback repetition covering the interval when `queue.push` refuses the currently playing song.

Intersect with strict pinned-playlist membership, excluded playlists, blocklist and applicable duration rules. Retain existing show-filter semantics within the artist universe. Do not silently remove either the artist restriction or strict playlist membership to satisfy a preference. Diagnose an empty intersection.

The fallback build key includes occurrence and prepared-source identity. A build checks that identity again before atomic publication. This prevents an outgoing or ordinary asynchronous build from replacing the new artist fallback. Preparation completion triggers the existing rebuild path; it adds no second scheduler or mixer writer. In-flight playback retains normal boundary behavior.

Feed the saved editorial snapshot into producer planning, both picker/link paths, programme intro/feature/outro, cohost scripts and the incoming handoff greeting. Outgoing signoffs use outgoing context. Incoming greetings receive their own research with clean prompt memory. Preserve `PROGRAMME_GROUNDING_RULE` and the current actual-track cue checks. Do not append raw preparation data to chat history.

Cap subject at 160 characters, artist ID at 256, stored result data at 32 KB and prompt rendering at 6 KB. Render source data as delimited data with instructions to use supplied evidence, never as executable instructions. Preserve source labels and URLs when provided; URLs do not need to be spoken. Empty research allows artist-specific music and discussion of known library records, without invented career facts.

## Failure behavior

Configuration failures, unavailable data and malformed results produce a visible reason. Transient tool and catalogue failures get bounded retries, with at most two automatic attempts per stage and a one-minute backoff. Catalogue retries preserve the accepted artist choice. Changed prerequisites can reopen an attempt that has never accepted a subject; expose an admin Retry action for that case. A ready episode cannot be automatically redrawn.
The live test also requires an operator catalogue retry after those attempts are
exhausted. It rechecks the accepted subject without re-running the tool.

If preparation cannot establish a usable artist source, the station continues its ordinary playback and does not announce a successful exclusive artist episode. If a previously ready catalogue becomes unusable, mark it degraded and use the existing broadcast safety fallback. This emergency exception can play another artist; normal artist rotation remains inside the chosen catalogue. Missing research is a separate state from unavailable music.

Explicit listener requests and manual queues continue to follow existing policy. The new restriction governs automatic music selection.

## Implementation order

1. **Define occurrence identity and result boundaries.** Add `preparationSkill` with an empty default to the show schema, normalization, vocabulary and resolved-show projection. Add result/storage schemas and pure occurrence fixtures.
2. **Build preparation and catalogue ownership.** Reuse the data-only runner and shared eligibility. Add durable selected/ready states, bounded retries, recovery and exact artist access. Add random-artist facade support for tagged, untagged and not-yet-mirrored libraries.
3. **Connect all automatic music paths.** Prepare incoming context before selection; thread one source into agent, pool and fallback. Update artist-variety policy, catalogue-sized recency, rebuild identity and stale publication checks.
4. **Connect the episode's speech.** Supply the saved subject and research to plans, links, beats, cohost scripts and handoffs. Prevent automatic re-execution of the preparation skill.
5. **Complete the operator experience.** Add the Show editor field, eligibility hints, missing-reference display, selected artist/status and failure feedback. Carry the field through form hydration/save and community import/export. Count preparation associations in SkillsPanel. Use existing admin query ownership and shared installed-skill reconciliation.
6. **Ship the example and verify.** Add the copy-ready skill, document its output contract and failure/request behavior, update relevant internals and community docs, regenerate the schema mirror, and complete automated plus rendered verification.

Preparation skill choices expose actual tool availability and readiness. Saved missing or disabled choices remain visible. Community exports contain stable skill slugs and show configuration; imported references remain inert until the local skill is installed, enabled and host-eligible. Runtime choices and research are not community configuration.

## Verification

Use real temporary state and SQLite fixtures plus the actual tool runner. Add tests around observable outcomes rather than reproducing implementation logic.

| Area | Required evidence |
| --- | --- |
| Tool and eligibility | Enabled and allowed tool succeeds; disabled, missing, host-disallowed, errored, timed-out and malformed tools explain failure; data-only preparation produces no audio. |
| Durability | Concurrent callers share one result; accepted choice persists before use; restarts and catalogue retries reuse it; bounded retries cannot repeatedly redraw after selection. |
| Occurrences | Same-host shows, muted shows, late boot, six-hour show with four-hour session roll, midnight/week/DST seams, takeover start/cancel/expiry, interrupted-show return and stale completion. |
| Music | Agent, pool and fallback IDs stay in the permitted source through repair and starvation; artist rescue cannot escape; one/two-song cases, duplicate rips, strict playlist conflicts and live blocklist changes. |
| Fallback publication | Source change rebuilds despite unchanged show ID; a stale asynchronous build cannot overwrite the current fallback. |
| Editorial | Repeated features read the same artist; absent research invents no source data; solo/cohost/link/greeting contexts are correct; outgoing data stays out of incoming prompt memory. |
| UI and configuration | Save/reload preserves the field; missing/disabled tool and feature conflict remain understandable; skill usage and community references round-trip; status and Retry obey preparation state. |

Run controller and web `npm test` and `npm run lint`, schema-mirror drift checks, rendered form checks and required admin-query audits. Verify a fixture airing through the isolated worktree stack: first incoming pick, a fallback turn, intro/feature/outro and a controller restart all retain the chosen artist. No Liquidsoap pipeline change is planned. A later implementation PR targets `develop`.

## Synthesis decision and alternatives

Two structurally distinct designs were compared: direct required preparation and a tool-enabled AI episode producer. An independent review scored both 21/25. Direct preparation is the base because it completes the single-tool request with fewer model decisions and a smaller configuration.

Adapt the producer design's separate music/editorial views, partial-research status, durable accepted evidence, bounded retries and stable occurrence snapshots. Reuse the existing data runner instead of creating another execution path. Keep artist catalogue policy independent of chat sessions and spoken handoffs.

An AI producer that chooses among several custom tools is viable, including for muted and ordinary shows, but adds provider routing and acceptance work. That extension can reuse this occurrence owner if brief-driven tool choice becomes a requirement. Adding custom setup tools to every track pick would repeat setup and compete with music discovery budgets. Storing preparation only on `ProgrammeState` or `BoundaryHandoff` would leave same-host, ordinary and long-running shows without stable ownership. Prompt-only artist instructions would leave fallback music unenforced.

Accepted tradeoffs are an explicit result contract, one additional durable state file and a documented emergency playback exception. The first implementation step is occurrence identity and result schemas, followed by a persisted preparation fixture before connecting live music or UI.
