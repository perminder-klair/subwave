# Extended Sleeve Notes: integration review map

Most feature code is contained in `controller/src/sleeve-notes/` and its admin views. Review the shared boundaries below alongside the [feature internals](enriched-sleeve-notes.md). The feature is opt-in, but switching it off does not revert shared LLM, timing or telemetry changes in this branch.

## Shared boundaries

Paths are repository-relative. Test names refer to `controller/scripts/` unless prefixed with `web/`.

| Boundary | Behaviour to review | Regression coverage |
| --- | --- | --- |
| Ordinary picking and track links: `broadcast/dj-agent/enqueue.ts`, `llm/internal/prompts/scripts.ts` | Enrichment follows the selected track. A Spark is optional, may be passed, and must not alter the pick. Release reservations on failed generation/queue insertion. Disabled metadata paths must not create/migrate the research DB. | `verified-facts.test.ts`, `link-style.test.ts`, `sleeve-notes-spark-packet.test.ts`, `sleeve-notes-link-isolation.test.ts` |
| Automatic Banter and manual segments: `broadcast/scheduler.ts`, `skills/_agent.ts`, `skills/loader.ts`, `routes/dj.ts` | Eligible automatic slots can try Sleeve Notes, including Produced Episodes, then fall back. Manual Banter remains Banter. Manual feature requests retain material, host, timing and publication guards. | `sleeve-notes-segment.test.ts`, `sleeve-notes-broadcast-gate.test.ts`, `sleeve-notes-lifecycle.test.ts` |
| Queue/TTS and speech timing: `broadcast/queue.ts`, `broadcast/queue/intro-render.ts`, `broadcast/queue/voice-io.ts`, `audio/tts.ts` | Offer/render/airing are distinct. Bound speech by the actual track play and final rendered duration. Feature disable must not strand speech already committed to a mixer silence. Review shared timing changes independently of the feature flag. Song-opening station IDs retain upstream skip-if-busy and marker-aware holds; cancelled Sleeve Notes release the shared voice reservation. | `sleeve-notes-speech-tracking.test.ts`, `speech-budget.test.ts`, `tts-measurements.test.ts`, `pause-talk-recovery.test.ts`, `jingle-overlay.test.ts` |
| Agent activity, LLM budget and telemetry: `llm/agent-activity.ts`, `broadcast/dj-budget.ts`, `llm/internal/core/failover.ts`, `llm/internal/strategy/object.ts` | Overlapping interactive work blocks research correctly. Quiet-time deferrals are not provider failures. Background work obeys the station hard cap. Structured output changes must preserve other model consumers. | `agent-activity.test.ts`, `sleeve-notes-token-budget.test.ts`, `llm-failover.test.ts`, `llm-local-parse-errors.test.ts`, `llm-deadline-hits.test.ts` |
| Settings and credentials: `schemas/settings.ts`, `settings/patch-registry.ts`, `settings/store.ts` | Master off by default; collection pause is independent. Redacted tokens survive unrelated saves; explicit clearing works. Validation/mirrors and Save/Discard use the existing settings boundary. | `extended-sleeve-notes.test.ts`, `settings-patch-schema.test.ts`, `sleeve-notes-settings-lifecycle.test.ts`, `web/tests/notes-settings.test.ts` |
| Music identity and library state: `music/library-db/tracks.ts`, `music/subsonic.ts`, `music/musicbrainz.ts` | Metadata/server changes invalidate local bindings and late responses. Catalogue matching must yield during scans/broadcast work and must not treat a failed empty response as library deletion. | `sleeve-notes-local-identity.test.ts`, `sleeve-notes-library-connections.test.ts`, `sleeve-notes-no-genius.test.ts`, `brain-queue.test.ts` |
| Backup and restore: `backup/zip.ts`, `routes/backup.ts` | Research is an optional WAL-safe archive entry. Refuse unsafe/future/corrupt restores before changing state; coordinate active research, restore queued jobs and clear display caches. | `sleeve-notes-backup.test.ts`, `sleeve-notes-upgrade.test.ts` |
| HTTP/admin integration: `routes/sleeve-notes.ts`, `routes/debug.ts`, Dash and Notes components | Auth/master gates apply to writes. Cached reads remain read-only. Correct/edit/restore/delete require explicit actions and current-version/source checks. Expensive display queries run in the read-only worker. | `sleeve-notes-cached-browsing.test.ts`, `sleeve-notes-manual-review.test.ts`, `sleeve-notes-dashboard-worker.test.ts`, `sleeve-notes-queue-actions.test.ts`, `web/tests/airing-reviews.test.tsx`, `web/tests/notes-overview.test.tsx` |
| Presentation and manual | Review the manual/sidebar/tab integration as shared UI changes, including responsive layouts and theme behaviour. | `web/tests/sleeve-notes-master-switch.test.tsx`, admin-query audit |

## Reproducing checks

Controller tests must run through `npm test`; it provides isolated temporary state. Do not run test files directly against a station. Test providers are synthetic/mocked and do not require credentials or paid calls.

```sh
cd controller
npm test -- sleeve-notes
npm test -- brain-queue
npm test -- speech-budget
npm test -- agent-activity
npm test -- verified-facts
npm test -- link-style
npm run lint
```

Also exercise the existing shared suites relevant to a proposed change: pause-talk recovery, talk scheduling, LLM failover/object parsing, backups and settings. The full controller suite is `npm test`. From `web/`, use `npm test` and `npm run lint`; from `app/` and `mcp-subwave/`, use their lint/type gates. Generated schema/theme drift checks remain the upstream CI contracts.

## Acceptance that unit tests cannot establish

Use the [tester guide](../testing/extended-sleeve-notes.md) for source builds, backup/recovery, first enable, optional Genius, normal playback and UI checks. In particular, observe the broadcast with research and multiple admin tabs active, test the actual LLM/provider configuration, and inspect the factual quality of retained stories.

Further early-review targets include bulk catalogue edits and confirmed-empty libraries, source outages/backoff, disk-full/permission recovery, changed clocks, indistinguishable replacement music servers, interrupted upgrades/restores, large collections and remaining synchronous maintenance. A catalogue scan that starts and finishes between checks cannot always be detected. Passing synthetic tests does not establish uninterrupted audio, provider coverage, model compliance or a fixed cost per track. No live destructive fault-injection result is claimed.

## Early-review corrections

The render tracker now counts outstanding promises independently of queue-item
addresses. Regression coverage includes invalidation, failed renders, replacement,
identity transfer and transfer over another active render. Banter timing limits
apply to automatic slots; skipped automatic exchanges enter the scheduler log
without being reported as speech. Feature-disable checks guard both sides of TTS
and release story reservations on rejection.

Disabled cached browsing is explicitly limited to saved-data GET views. Its
asynchronous read-only handle remains open through completion, and library-only
stories use the same boundary. Tests cover absent caches, retained snapshots,
authentication, rejected writes and unchanged on-disk data. Test directories use
the shared lifecycle helpers; HTTP fixture shutdown closes connections before
removing state. A previously reported isolated connection-reset flake has not been
reproduced in the verified full run; this is not a guarantee against future flakes.

The web production build uses upstream's default `next build`. Initial database
creation is one public schema, with a distinct application id and explicit refusal
of pre-release experiments; the reset instructions are in the tester guide.

Validation for this correction pass: 5,403 controller tests and 464 web tests pass;
controller/web/app/MCP lint and types pass; generated schema/theme mirrors show no
drift; admin-query audit passes; the default Turbopack production build succeeds.
Controller ESLint has 1,733 existing warnings, matching the reviewed upstream
baseline. The consolidated schema was compared against the previous schema: all
145 tables/indexes/triggers and the initial revision row match. These checks do
not replace the pending real-station reset, provider research and on-air checks.

## Upstream compatibility checklist

For each upstream release, compare the feature branch against both the release tag
and develop. Keep a copy of the prior station source/images and a compatible backup.
Review overlapping behaviour even when Git merges without conflicts:

- Queue/voice: render invalidation, host changes, track replacement, reservations,
  timing, publication and manual Banter must retain their established behaviour.
- Research/settings: off, pause, provider opt-out, token redaction, save/discard and
  library/server replacement must preserve operator intent and stop late results.
- Persistence: initialise a fresh store, reopen a populated store, upgrade the last
  public schema, reject future/experimental backups and test an interrupted job.
- Admin/theme: shared navigation, Skip controls, cached reads, responsive layouts,
  light/dark themes and Lite/reduced-motion behaviour need explicit review.
- Run the focused boundary workflow plus lint/type and generated-mirror checks.
  Run broader suites when shared behaviour changes. Build with upstream's default
  bundler, then test on a backed-up station before publishing.

Record observed live results separately from synthetic checks. On 22 October the
operator reported a multi-host Sleeve Notes segment within an hour of starting a
fresh research database, using recently collected Wikipedia material. This is an
observed first-run result, not a promised collection time for every station.

## Identity and diagnostics follow-up

All three provisional Genius entry points (encountered tracks, library seeds and
sample traversal) use the shared unambiguous-library artist resolver. A bounded,
rotating catalogue-worker pass reconciles old provisional children, even when
Genius capture is off. It preserves recording ids/evidence, skips artist-level
research and separate canonical identities, and keeps historical artist rows.
Browse/dossier local-match labels now use actual library associations or the
existing unambiguous cached-library identity, rather than merely having an MBID.
Public schema 1 upgrades to 2 by adding indexes only; no reset is needed.

Progress explanations use the same policy as the worker gate. Indexed timestamps
show source collection, completed research and the next retry. A page-only warning
covers ready work with no progress for six hours while excluding deliberate pause,
listener and budget gates. Explicit storage inspection runs in the existing
read-only worker; it never polls or contacts a provider. Browser-local snapshots
support file-size comparisons. A focused CI workflow covers broadcast/off-state,
recovery and identity boundaries; the compatibility checklist above covers upstream
integration and live acceptance.

Validation: 365 Sleeve Notes checks and 466 web tests pass. Follow-up intro-render,
library-matching, traversal, seeding and no-Genius suites pass. Controller/web
lint/types, generated mirrors and admin-query audit pass; controller warnings stay
at the existing 1733. The default production build passes. Isolated desktop/mobile
browser checks verify explicit-only storage requests, table rendering, theme
switches, no page overflow and no browser errors; UI detector reports no findings.
An isolated current-station database snapshot reduced seven visible 2Pac entries to
one without changing its 1022 recordings, 5294 facts or 658 sources, and with zero
foreign-key errors. This was not a live data repair or a substitute for station
acceptance. Live containers remain for the operator to rebuild.


## Outgoing segment handover ownership

A station check on 22 October found an outgoing-host Sleeve Notes exchange airing
following the incoming show's handover and hourly check. Background research did
resume, confirming that the earlier permanent-pause repair worked independently.

Prepared Sleeve Notes briefs now retain the commissioning show/host epoch through
writing, rendering, deferred delivery and the final speech-file publication check.
Both manual and automatic requests stand down once a handoff has claimed the
boundary. A same-presenter show change also invalidates the old editorial context.
Cancelled publication does not hold the voice serialiser for the unplayed clip's
duration or create aired bookkeeping; unsuccessful segments release unused fact
reservations. Already-published audio and committed pause-and-talk delivery retain
their existing ownership. Ordinary manual Banter and other manual speech keep their
established overrides.

Regression coverage is in `sleeve-notes-handover.test.ts`, including real speech-file
waiting, late writing/TTS, same-host show changes and deferred exchanges. The
focused boundary workflow includes this suite. A new on-air handover check is still
required after rebuilding the controller; synthetic checks do not establish the
live audio outcome.

Validation: the feature suite passed 369 checks during development. After the
final ownership/policy refinements, all 6 handover regressions and 32 segment
checks pass. Shared voice (122), host-speech (17), handoff (87) and talk-placement
(4) checks pass. Controller types and focused lint pass with one pre-existing
explicit-any warning in the untouched capability-selection line. No live LLM
calls or container changes were made; a new on-air acceptance result is pending.


## Library relationship source recognition

The Library Connections summary still counts each directed sample/cover relationship
once, with both recordings in the current library. Traversed Genius recordings can
be local without a played-track attachment. Previously the target matcher recognised
them, while the summary's source-side SQL required an explicit attachment or MBID.

The existing background matcher now resolves a source through the same artist,
exact-title, recording-identity and duplicate-copy guards used for targets. A
nullable source local-track reference is published in the revision-checked derived
edge patch. Public schemas 1 and 2 upgrade transactionally to 3; deletion/metadata
invalidation clears the reference through an indexed foreign key. The summary uses
these cached matches without another provider call or matching pass. Disabled
pre-upgrade cached browsing retains the older query without modifying the store.

Verification: 375 feature checks passed, with final matching, upgrade and identity
checks covering unplayed sources, inverse/copy deduplication, conflicting recording
identities, live-version retags, external endpoints, deletion and old-schema cached
reads. Controller types and focused lint pass. An isolated station snapshot changed
from 1 to 137 unique library relationships while preserving facts, recordings and
sources, with no foreign-key errors. This was an offline copy; live collection and
container rebuilding remain under operator control. The count refreshes after the
next successful quiet-time background match and normal Overview refresh.


## Station acceptance before the draft update — 23 October

The operator confirmed ordinary manual Banter airs correctly. Research resumed
after the controller rebuild. Provisional artist duplicates progressively collapsed
through the alphabetical repair; the progress tooltip and explicit storage
inspection worked as intended. Library Connections rose from 1 to 137 after the
background pass, matching the offline verification while retaining the requirement
that both recordings are local.

A manually requested Sleeve Notes segment during the next handoff was refused
before speech queued. This confirms the live handoff-admission guard. Late writing,
rendering and publication races, and adjacent shows with the same host, remain
covered by regression tests rather than a claimed live reproduction of each race.
The previous outgoing-voice incident also showed research resuming afterwards.

These observations support updating the testing draft. Multi-day storage growth,
additional real LLM/provider combinations and destructive environment/recovery
experiments remain further testing work. This record does not claim those checks
were completed or establish uninterrupted audio in every failure scenario.


## Final-review verification — 23 October

The operator accepted the light-theme Station Brain refinement after a station web
rebuild. The final feature code passed the full isolated controller suite (5420
checks, zero failures or skips) and the full web suite (466 checks). Controller,
web, native-app and standalone-MCP lint/type gates pass; the controller retains
1733 existing lint warnings. Schema/theme regeneration has no source drift and
the admin-query audit passes. The default Turbopack production build passed on
retry after reporting the inherited upstream Next.js security advisory.

The feature boundary workflow now also runs the Station Brain connection/theme
checks. Live acceptance includes manual Banter, research resumption after rebuild,
progressive artist consolidation, progress/storage controls, the library count
rising to 137, and refusal of a manual Sleeve Notes request during a handoff.
Writing/rendering/publication races and same-host show changes retain automated
coverage; no separate live reproduction of every race is claimed.

The inherited Next.js 16.4.0 advisory remains an upstream dependency follow-up;
a successful build retry does not remediate it. The PR description links the
advisory and distinguishes supported public-schema upgrades from experimental
research-only resets. Longer storage, provider and destructive fault/recovery
trials remain further testing, not claimed completed acceptance.

## Upstream reconciliation — 24 October

Integrated develop through b1e61819, including optional song-opening station IDs,
lyrics/queued lookups, file details and library run logs. Resolved shared queue,
voice I/O and server-route conflicts while retaining Sleeve Notes publication
cancellation and source admission. Duration measurements stay in the shared audio
helper; optional IDs retain their null-on-skip contract and marker-aware hold.
Settings coverage is 52 of 57 keys. A handover regression also checks that cancelled
speech releases upstream's voice-busy reservation.

The final combined code passes 5568 controller checks and 501 web checks, with no
failures or skips. Package lint/types, generated mirrors and the admin-query audit
pass; controller lint retains 1726 inherited warnings. No station source, containers,
settings or live data were changed during this PR reconciliation.

## Biography coverage and browsing follow-up

Review now separates factual flags from Research gaps. Biography discovery uses
MusicBrainz's explicit English Wikipedia relationship when the preferred Wikidata
item/sitelink is absent. Operators can correct research-only artist identities,
set an article URL, rescan an artist, or run a paced metadata-only library scan.
These operations do not merge artists or change canonical recording matches.
Source-generation checks, durable backoff and quiet/broadcast gates apply to late
results and retries. Public schemas 1–3 upgrade additively to schema 4; the tester
guide explains backup and rollback requirements.

Shared-boundary coverage includes the MusicBrainz request throttle, feature-off
read-only access, source/queue restart behaviour, backups and generated settings
schemas. Tests are `sleeve-notes-research-corrections`, `sleeve-notes-research-gaps`,
`sleeve-notes-wikipedia`, `sleeve-notes-dashboard-worker`,
`sleeve-notes-cached-browsing` and `sleeve-notes-artist-identity`.

Browse Library's artist query now starts from each artist's indexed recordings,
rather than repeating a broad recording-claim search. Lists and dossiers use the
existing read-only worker. Search matches Station Brain's delayed typing and
clear behaviour. Tests check the query plan, response parity, timer responsiveness
and unchanged database bytes. Browser checks cover searching, clearing, page and
navigation resets, album scope and mobile overflow.

The station operator reported stable rapid tab switching across two independent
browser sessions and stable browsing during an active research job after the fix.
These are observed acceptance checks, not a sustained-load benchmark or a guarantee
that every possible controller stall has been eliminated.

The combined update with upstream develop through `677cc2ed` passes 5,618
controller tests and 506 web tests, with no failures or skips. Controller/web
lint and types, the generated schema mirror and the admin-query audit pass;
controller lint retains 1,726 existing warnings and no errors. No production
build, container restart or live database operation was performed during this
PR reconciliation. Upstream's MP3 cue-landing, mobile lyrics and appearance-modal
changes are retained; the shared queue merge preserves feature cancellation and
speech reservations.

## Stats redesign reconciliation — 30 October

Adopt upstream's numbered Stats layout and weekly recap. Keep its extracted
Stats sections and slowest-render detail, moving the existing voice generation
and speaking-pace figures into Engine room. Retain per-engine/presenter histories
and deferred-work counts. Deferred research is excluded from failed-call labels,
request-path completion ratios and the LLM health sample; an entirely deferred
sample is idle rather than a successful or failed set of model calls.

Regression checks cover both the upstream slowest-render field and retained pace
fields in the same controller response, display of those fields in the new page,
older responses without pace fields, and deferred-work health. Verified 29 focused
controller checks (Stats, TTS measurements, research budget and broadcast gates),
all 541 web tests, controller/web lint and types, generated schema parity and
isolated desktop/mobile browser checks. Controller lint has 1,747 warnings and
zero errors. No production build, station deployment or database changes are
part of this reconciliation.
