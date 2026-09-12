# Native track shortlisting

The native shortlist path replaces **how candidates are discovered**, not the
station's music policy or the DJ's editorial role.

```text
current track + show/broadcast state
             ↓
      buildShortlist(context)
             ↓
  bounded candidates + factual provenance
             ↓
       djPick(context, shortlist)
             ↓
     chosen track + transition + link
```

`buildShortlist` belongs in the controller. It is local code: it does not call
an LLM and it does not enqueue a track. `djPick` is the main DJ model's single
editorial call. It must choose an id from the supplied shortlist and may write
the on-air link and transition at the same time.

The existing Candidate Pool remains the dead-air-safe fallback. It is not an
operator-selectable picking mode once native shortlisting is live.

## Compatibility contract for the first PR

The first PR is a behavioural substitution, not a new music-selection policy.
It must preserve the following current picker behaviour.

### Scope and guards

Every native source receives the same resolved `PickerScope` used by the
current picker tools:

- track recency and hard no-repeat ids/keys;
- strict show genre, era, mood, energy and vocal locks;
- strict playlist intersection and excluded-playlist ids;
- resolved show playlist tracks; and
- an active sonic-journey waypoint, when one exists.

Candidates still pass through the existing shared collection logic: strict
locks before recency, freshness-biased ordering, de-duplication by id across
all sources, and the existing default cap of three tracks per artist. The
downstream back-to-back artist guard remains authoritative.

The first PR must not weaken any of these guards, add a new musical weighting,
or change the behaviour of the Candidate Pool fallback.

### Sources

The ordinary next-track registry has seventeen conditionally available sources:

`searchLibrary`, `similarSongs`, `topSongsByArtist`, `recentByArtist`,
`songsByGenre`, `tracksByMood`, `tracksByEnergy`, `tracksLikeThis`,
`tracksThatSoundLikeThis`, `searchByLyrics`, `searchBySound`, `deepCuts`,
`recentlyAdded`, `starredSongs`, `randomSongs`, `showPlaylistTracks`, and
`tracksTowardJourney`.

`identifyRequestedTrack` is request-only and is not part of ordinary
shortlisting.

Availability remains source-owned. In particular, embedding/search sources are
absent when their backing index or query capability is unavailable; a source
with no usable data must not be offered as an empty, time-wasting call.

Most sources contribute at most eight accepted tracks. `showPlaylistTracks`
may contribute twelve. A source's raw result can be wider (for example a 60
neighbour KNN search) because the existing collection rules deliberately thin
it only after filtering and freshness ordering.

### Passes and repeat calls

`picker.shortlistPasses` is the native **shortlist pass budget**. It accepts
one to five passes and defaults to three. A native pass may reuse a source:
vanilla permitted repeated tool calls, so the planner must not impose
artificial source uniqueness.

Vanilla lets a model make more than one call in a round, and lets it decide the
arguments from preceding results. Native code cannot reproduce an arbitrary
model's private decision process byte-for-byte. The compatibility requirement
is therefore observable rather than transcript-identical: the native plan must
use the same source registry, gates, arguments and filtering semantics, and be
benchmarked against recorded vanilla runs before its source policy changes.

No new source preference, music heuristic, or optimisation belongs in this
first policy. Those are follow-up work after the compatibility PR is accepted.

### Compatibility handoff to the DJ

The current tool-loop agent accumulates every accepted source result in a
`seen` map; it has no global eighteen-track cap. This can grow by roughly eight
tracks for each productive tool call and is the context growth this project
removes.

There is **no fixed global candidate cap** in the first native implementation.
The Candidate Pool's 18-track cap belongs to its fallback policy and is not a
property of the current agent path. Imposing it here would discard candidates
that vanilla currently lets the DJ consider.

The native shortlist instead preserves the existing per-source caps,
de-duplication and accumulated-result behaviour. In the observed one-source per
pass shape this is normally up to eight accepted candidates per productive pass
(for example, four passes can yield up to 32 unique candidates). The model
still receives far less context because it no longer receives the tool
definitions, tool-loop turns, or raw tool transcripts.

The builder records the number of candidates before and after every source and
after de-duplication. A global ceiling may be introduced only as a separately
benchmarked optimisation, never as an incidental carry-over from the Candidate
Pool fallback. `djPick` is schema-validated against the ids it receives.

## Provenance and Booth Log

`buildShortlist` returns factual data, not prose:

```ts
type ShortlistResult = {
  candidates: any[];
  sourceRuns: Array<{
    source: string;
    args: Record<string, unknown>;
    returned: number;
    accepted: number;
    elapsedMs: number;
    error?: string;
  }>;
  uniqueCandidates: number;
  appliedGuards: string[];
  elapsedMs: number;
};
```

The Booth Log renders one completed **Shortlist Pick** event, with expandable
factual context, source runs, counts, selected track and transition. The DJ's
`selectionReason` is separate from its on-air link. It is a private Booth Log
note, never speech: one natural, varied sentence that names the selected artist
and title and explains the musical fit without announcing the track or implying
its queue position. The controller replaces a weak or queue-oriented model
note with a concise fallback. It adds a separate, listener-friendly factual
source hint (for example, “Surfaced through mood and energy matching.”) from
the selected candidate's provenance. The DJ must not invent source names/counts;
it may name a guest only when that guest's Musical Leanings genuinely settled a
close tie.

## Acceptance evidence

Before the native path replaces the tool loop, compare it with recorded vanilla
bench runs across ordinary picks, strict shows, playlist shows, thin indexes,
journeys, deep-cut nudges and empty-source cases. For each run retain:

- source names and arguments;
- raw/accepted/de-duplicated/final counts;
- final shortlist ids and source provenance;
- total shortlist latency; and
- whether fallback was required.

The first PR is ready only when it retains valid, varied candidates under the
same guards while removing the discovery-tool definitions and transcripts from
the DJ model's context.

## Session handover — 4 September 2026

### Scope and branch

Native track shortlisting is being developed in:

```text
feat/track-cpu-shortlisting
/home/jaz666/codex/subwave-track-cpu-shortlisting
```

The work is deliberately independent of the paused Producer Routing and
FunctionGemma paths.

### Decisions made

- The primary path will become `buildShortlist(context)` followed by
  `djPick(context, shortlist)`.
- `buildShortlist` is controller-native and makes no LLM calls. `djPick` is the
  one editorial DJ-model call, returning a valid shortlist id, transition,
  on-air link and a separate selection reason.
- The existing Candidate Pool remains the automatic dead-air-safe fallback; it
  will not remain an operator-selectable mode after parity is demonstrated.
- The first PR is a vanilla-compatible substitution. It preserves source
  availability, arguments, scope, filtering, per-source caps, de-duplication,
  repeated source calls, the 1--5 discovery-pass budget and existing deep-cut
  behaviour. It adds no new musical heuristic.
- There is no fixed 18-track cap in the first native shortlist. That cap belongs
  to the Candidate Pool fallback, not the agent path. The native handoff keeps
  the existing accumulated per-source candidate behaviour.
- User-facing terminology after rollout: **Track Shortlist**, **DJ selection**,
  and **Backup selection**. The Booth Log should render one expandable
  **Shortlist Pick** event with code-generated factual provenance and a separate
  DJ-written selection reason.

### Evidence captured

Vanilla benchmarking with the same 8B local model shows the agent normally
uses almost all available discovery passes:

| discovery setting | average tools | `djAgentPick` average | pick success |
| ---: | ---: | ---: | ---: |
| 1 | 1.0 | 20.6 s | 85/85 |
| 2 | 1.9 | 24.1 s | 54/55 |
| 3 | 2.8 | 27.0 s | 32/36 |
| 4 | 3.8 | 47.7 s | 31/36 |
| 5 | 4.7 | 92.3 s | 32/39 |

Five rounds reached a 196.1 s p95. Discovery tools recorded no failures. Real
station traces show repeated calls are normal, especially
`tracksTowardJourney`, with mood, audio/text similarity, show playlists,
energy, random, search and deep cuts also occurring. This supports preserving
source repetition and identifies the repeated LLM/tool turns and growing
transcript as the bottleneck.

The next benchmark must measure separately:

1. `buildShortlist` latency for equivalent one-pass and five-pass source plans.
2. `djPick` latency, input tokens and success for the resulting one-pass and
   five-pass shortlist payloads.

Use the same current-track/show/journey context for repeated measurements and
record p50, p95, candidate counts, source runs and fallback outcomes.

### Completed feature work

- `6ade317b` — defines this vanilla-compatible shortlisting contract.
- `bca3c58e` — adds `controller/src/music/shortlist.ts`, a replayable native
  shortlist runner plus focused tests. It executes an explicit recorded
  source/argument plan through the current picker registry without an LLM,
  retaining the existing filtered/de-duplicated `seen` accumulator and factual
  per-source provenance. It is not yet live-wired and has no automatic source
  planner.

Verification completed for `bca3c58e`:

```text
controller npm run typecheck      passed
controller npm test -- shortlist-runner   passed (2 tests)
```

### Station state

The integration checkout is `/home/jaz666/Docker/subwave`, branch
`test-station/vanilla-debug-handoffs-prompt-safety-live`.

- It now includes upstream `v1.11.0`, debug features, prompt safety and
  show-boundary handoffs. The live boundary timing repair is `c220b6a6`.
- Controller and web were rebuilt to 1.11.0; the controller is healthy.
- The discovery bench is live under Admin → System → Discovery.
- Existing local `.dockerignore` and `controller/scripts/functiongemma/`
  changes in the integration checkout were intentionally preserved.
- Announce before any controller or web rebuild/restart. The user is currently
  collecting five-round baseline data, so do not deploy shortlisting work yet.

### Related follow-up

`djAgentSegment` is still a true skill tool-loop whenever the old Agentic
Picker setting is enabled: `SKILL.md` supplies the brief and `tool.mjs` is the
model-callable data capability. A later weak-model/creative-model path should
be controller-selected skill → controller-fetched data → one structured
generation call. Keep this separate from the native-shortlisting PR.

### Next action

After the user captures sufficient five-round data, turn representative live
source traces into replay fixtures and implement the conservative state-led
source planner: journey, show playlist, current-track audio/text similarity,
mood/energy and the existing deep-cut nudge. Do not introduce new music
heuristics or a global shortlist cap.

### Replay-fixture prerequisite

The captured discovery-route logs currently record only source names and
result counts. They do **not** include the source arguments or the pick context
required to make faithful replay fixtures. Before implementing the automatic
source planner, obtain a full trace export containing those fields, or add
detailed redacted trace logging long enough to capture representative picks.

Redaction must retain the fields needed for replay (source, arguments,
current-track/show/journey context, discovery round and result identifiers or
stable candidate metadata) while excluding credentials, tokens and unrelated
prompt contents. Do not restart the controller merely to add this observability
without first notifying the user; they are collecting latency data.

### Replay-trace capture

`picker.replayTrace` now emits one factual, redacted event for every completed
agentic picker run. It contains the resolved replay scope, minimal
current-track and show context, one-based discovery rounds, source arguments
and returned candidate ids. It deliberately omits prompts, model responses,
credentials and unrelated session history.

The change is not deployed to the integration station. Notify the user before
any controller rebuild or restart; after deployment, retain representative
events as replay fixtures before starting the automatic source planner.

### Captured source-plan evidence — 5 September 2026

The integration station captured 94 `picker.replayTrace` records before its
next controller change. The set includes 69 journey contexts, 10 strict-show
contexts, 8 calls with an empty source result, 40 playlist contexts and 25
repeated-source runs. It covers journey, playlist, audio/text similarity,
mood/energy, search, random and deep-cut sources. Strict-playlist evidence is
still desirable before rollout, but is not needed to begin the planner seam.

`planShortlistSources(context, availableSources)` and native
`buildShortlist(context)` now exist in `controller/src/music/shortlist.ts`.
The planner is controller-native and availability-gated: it leads with an
active journey or show playlist, follows the observed mood/energy and
current-track similarity lanes, preserves repeated calls when its pass budget
wraps, and retains the existing caller-decided deep-cut nudge. It is not yet
wired into the live picker or the DJ selection call.

`controller/src/music/dj-pick.ts` now supplies that selection seam: one
structured `djShortlistPick` call receives the candidate payload, can select
only one supplied id, and writes the existing link/transition fields plus a
separate editorial `selectionReason`. It cannot make discovery calls or claim
source provenance. The queue records the final post-artist-guard selection as
a **Shortlist Pick** Booth Log event, with the model-written private note and
controller-written source hint kept separate.

### Native cascade integration

The development branch now runs `buildShortlist → djPick` in the ordinary
next-track cascade. The existing enqueue path, artist guard, queue de-duplicate
handling, circuit-breaker classification and Candidate Pool fallback remain in
place. The old next-track Agentic Picker toggle no longer selects the pool; it
continues to govern the unrelated listener-request agent. This is not yet
deployed for station testing. Booth Log presentation and latency benchmarking
remain before rollout.

### Live benchmark and handover — 5 September 2026

The native candidate has since been integrated into the test-station checkout
and is live for controlled station testing. The live controller is healthy on
test-station commit `692851da`; that integration branch also carries the
debug/stat compatibility additions described below. Its user-owned local
changes (`.dockerignore` and `controller/scripts/functiongemma/`) must remain
untouched. The rebased development branch is `feat/track-cpu-shortlisting` at
`f790c145`, now based on upstream `v1.12.0`.

#### Observed first benchmarks

These are early live samples on the local
`Meta-Llama-3.1-8B-Instruct-Q5_K_M` service. They establish the direction and
operating envelope, not a portable cloud-model claim. Show/context mix differs
between runs, so compare a given round count against its matching vanilla run,
not a different round count as a causal experiment.

| source-pass setting | vanilla agentic picker | native shortlist primary pick | observed result |
| ---: | --- | --- | --- |
| 3 | 27.0 s, 24.3k tokens/pick | 15.4 s, 6.5k tokens/pick | 43% lower latency; 73% fewer tokens |
| 4 | 47.0 s, 31.9k tokens/pick | 14.3 s, 9.4k tokens/pick | 70% lower latency; 70% fewer tokens |
| 5 | 92.3 s, 37.2k tokens/pick (38/39 OK) | 19.4 s, 11.5k tokens/pick (57/58 OK) | 79% lower latency; 69% fewer tokens |

The five-pass native run made five controller source calls per shortlist. The
extra source passes add comparatively little latency because discovery no
longer requires another model/tool turn. They do grow the final candidate
payload, so token cost and required model context grow more noticeably. This
is the intended operator-facing trade-off: more discovery breadth, one final
model choice, still much cheaper than the corresponding agent loop.

#### Operating constraints and decisions

- The current setting is still `llm.discoverySteps`. Native planning performs
  exactly that many source passes; it does not stop early after a suitable
  candidate appears. While an LLM fallback is enabled, `promptDiscoverySteps()`
  takes the lower primary/fallback value, so both must be set to the desired
  number. Move this to a dedicated **DJ Behaviour** shortlist-pass setting in
  follow-up work.
- A five-pass strict playlist run built 43 candidates and sent 11,989 input
  tokens. With llama.cpp running at `--ctx-size 12000`, the model produced no
  parseable JSON and the Candidate Pool fallback completed the pick. Controller
  `numCtx` was 16,384, but that setting applies only to Ollama; it is not sent
  to an OpenAI-Compatible endpoint. The server's `--ctx-size` was the binding
  limit. Match llama.cpp to at least 16k now; assess 20k--24k, subject to RAM,
  before treating five passes as reliable. The admin Debug → LLM recent calls
  panel now reports an in-memory recommendation from the largest successful
  `djShortlistPick`/`djShortlistRepick` input: 25% headroom plus a 1,024-token
  response reserve, rounded up to 1,024-token steps (minimum 8,192). It resets
  when the controller restarts so it benchmarks the active station setup rather
  than preserving stale evidence.
- The existing `djAgentRepick` is still called by the artist-variety guard.
  Example: the first shortlist choice was Placebo, which the guard replaced
  with Rage Against the Machine from the already-built alternatives. Add a
  native `djShortlistRepick` that selects only allowed alternative artists from
  the same shortlist, with no rediscovery and no legacy agent path.
- Reinstate explicit persona **Music Leanings** as editorial input to the final
  native selector only. It must not override shortlist eligibility, show locks
  or recency.
- Native debug records now emulate the former picker view: the one
  `djShortlistPick` call carries controller source names/arguments, returned and
  accepted counts, source timing, tool count and equivalent steps. The Stats
  page includes `djShortlistPick` in Agent Runs. The dedicated Booth Log
  Shortlist Pick presentation remains outstanding.
- Review API, MCP and webhook surfaces before publicising the path: consumers
  may currently assume picker activity is an LLM tool loop.

#### Upstream and verification

The development branch rebased cleanly onto v1.12.0. The release's
announce-only link support overlaps `dj-agent.ts` and its pick schema; the
rebased code retains both announce-link composition and the native picker.
The strict single-artist playlist source change is automatically used by the
native builder through the shared picker registry.

Verified after rebase:

```text
controller npm run typecheck                                  passed
controller npm test -- shortlist-runner                       passed
controller npm test -- picker-lock-forwarding                 passed
controller npm test -- picker-show-source                     passed
controller npm test -- link-style                             passed
```

The full controller test suite was not rerun after the rebase. An earlier full
suite attempt was blocked by the local analyzer test environment lacking
NumPy, not by shortlist code.

#### Resume point

Continue collecting normal station data without deploying further shortlist
changes. Native `djShortlistRepick` landed in `dc0a31d6`: the artist-variety
guard now makes its corrective editorial call only over the already-filtered
alternative subset of the existing Track Shortlist. It uses the
`djShortlistRepick` telemetry kind, cannot rediscover, and fails softly into
the guard's existing relaxation/pool-rescue policy. The legacy
`djAgentRepick` remains only on its non-native salvage path.

Persona **Musical Leanings** is restored in the Persona Identity editor below
Soul, with its previous 500-character persisted `musicLean` field. The native
primary selector and native artist-variety repick receive it as a private soft
tie-breaker only; it neither affects shortlisting/eligibility nor enters
listener-facing speech. The prompt explicitly forbids it from overriding the
shortlist, show rules, rotation, safety or musical flow.

An eligible guest co-host can now add a weaker Musical Leanings nudge on 25%
of picks. It is drawn only from a guest's configured `musicLean`, never their
Soul, and is passed through the same native repick path if the artist guard
fires. The selector must name the guest naturally in `selectionReason` only
when that nudge genuinely settles a close tie.

The final native selection now records one **Shortlist Pick** Booth Log event
after the artist guard, ensuring that its track, private Booth Log note and
source hint describe the track that actually airs. The event reaches both the
web-fed `djLog` and the durable shortlist trace. Source hints are
controller-generated friendly labels, never raw registry identifiers.

### Deferred compatibility evidence

Before publicising native shortlisting, produce a non-airing paired report from
one frozen station moment: run the legacy three-round Agentic Picker and the
native three-pass Shortlister against the same track, show, locks and library
state. Record each route's source/tool trace, candidates, selected track,
input/output/total token usage, LLM call count, per-stage timing, total wall
time, and fallback outcome. The selections need not match exactly; the evidence
is that both remain in the same eligible musical neighbourhood while the native
route removes model-led discovery overhead.

The first non-airing runner is `controller/scripts/shortlist-paired-compare.ts`.
Given one saved replay trace, it fixes both routes to three discovery
opportunities, never enqueues or saves settings, and prints a Markdown table of
the Agentic Picker tool calls and Track Shortlist sources with their returned
tracks. The trace remains the frozen-moment input: do not compare ordinary live
picks from different station states.

Next, benchmark the new private Booth Log selection-note payloads and gate any
further context-window or operator-setting change on peak-token evidence rather
than an average.

### Overnight candidate-source rotation — 7 September 2026

The completed soak established the native path as operationally reliable: the
Stats window recorded **337/337** successful `djShortlistPick` calls, averaging
18.4 seconds and 2.75M input/output tokens in total (about 8.2k per primary
shortlist). Corrective `djShortlistRepick` also completed 89/89 times. The
legacy agent metric was no longer representative of normal selection work, so
the admin presentation now names native **discovery passes**, **candidate
sources**, and **Track shortlists** instead of tools, steps, and Agent Runs.

The planner now uses a stable three-lane source rotation:

1. **Context** — active sonic journey, show playlist, or mood/energy brief.
2. **Continuity** — audio similarity, semantic similarity, or catalogue
   similarity to the current track.
3. **Exploration** — deep cuts, recently added material, starred tracks, or a
   library wildcard.

Four and five pass configurations repeat context then continuity. Source choice
within a lane is deterministically rotated from the current track id, so a
controller restart does not reset the mix. The existing epsilon-greedy
exploration draw makes that pass `deepCuts` specifically. Registry availability,
strict playlist locking, recency, blocklists and candidate de-duplication remain
the existing picker registry's authority.

`feat/track-cpu-shortlisting` was rebased onto current upstream `develop` and
pushed at `3a6c3ef5`. It includes the rotation (`bbc70b92`), the native source
trace retained on `djShortlistPick`, and the object-call telemetry seam needed
to expose that trace in Debug/Stats. Focused verification passed:

```text
controller npm test -- shortlist-runner     8 passed
controller npm run typecheck                passed
```

The test station is running the proven existing integration composition plus
the rotation at local commit `670a131a`. It also retains the resumed Show
Boundary Handoffs, Prompt Safety, and source-trace diagnostics. Controller and
web were rebuilt successfully and the controller health check passed. The
rollback source ref is `test-station/backup-before-overnight-shortlist` at
`8f00b778`; return the integration checkout to that ref and rebuild controller
and web if the overnight trial requires rollback. The local `.dockerignore`
change is user-owned and intentionally uncommitted.

#### DJ Behaviour control — 8 September 2026

Native shortlist breadth now has its own **DJ Behaviour → Track Shortlist
passes** control. `picker.shortlistPasses` accepts 1--5 and runs exactly that
many native source passes. Three is the shipped default: one **Context** source
(journey, show playlist, or mood/energy), one **Continuity** source (audio,
semantic, or catalogue similarity), and one **Exploration** source (deep cuts,
recent additions, starred music, or wildcard). One pass concentrates on the
current context; two adds continuity but omits the exploration lane. Four and
five repeat context then continuity, widening the candidate set and final
editorial prompt without adding model-led discovery. It does not alter the
separate Agentic Segment tool-loop budget (`llm.discoverySteps`). The settings
rail has one DJ Behaviour entry, which owns this picker control.

#### Next action

Let the fresh controller telemetry window collect overnight evidence. Review
the `djShortlistPick` source-run sequence and failure rate first; accept the
rotation only if the exploration lane appears regularly without increasing
fallbacks or materially worsening shortlist latency. The deferred frozen-moment
legacy-versus-native paired comparison remains the next non-live benchmark.

### End-of-session handover — 10 September 2026

#### PR state

[PR #1634](https://github.com/perminder-klair/subwave/pull/1634) is now ready
for review (not draft), mergeable against `develop`, and green on controller,
web and MCP lint. The feature branch is
`feat/track-cpu-shortlisting` at `db92ecaf`.

The branch has been merged with the recently landed Prompt Safety, Sleeve
Notes, Show Handover and Pause-and-talk work. The final conflict resolutions
preserve both feature sets:

- pause-and-talk uses the newer coordinated handover exchange;
- **DJ Behaviour** remains a single sidebar entry; and
- its Save button owns talk placement, pause-and-talk minimum duration,
  general DJ behaviour, and `picker.shortlistPasses`.

No further merge work is currently outstanding. Do not change the PR back to
draft unless the user explicitly asks.

#### Confirmed runtime behaviour

- Ordinary next-track selection is now **native Track Shortlist → Candidate
  Pool fallback**. The old Agentic Picker tool loop is not a first fallback for
  normal picks.
- The legacy `pickerAgent` setting currently controls the separate
  listener-request agent only. That request path still needs a tool-capable
  model; when it is unavailable or fails, the established request matcher
  remains the fallback.
- A sensible later follow-up is a request-specific native shortlist: gather
  intent-relevant candidates controller-side, then let one constrained editorial
  call choose among them. It must rank request fulfilment ahead of ordinary
  programme-flow criteria.

#### Live evidence and documentation

The paired three-round comparison is working and its Markdown records belong
in `docs/internals/track-shortlisting-comparisons.md`. It is an internal
evidence record, not a public feature or an item to mention in the PR text.
Continue collecting a small, varied set of frozen-moment comparison examples.
Each should retain show criteria, source/tool trace, returned tracks, latency,
calls, tokens, selected track and fallback outcome.

The overnight twelve-hour sample following the final station change recorded:

| Kind | Calls | Successful | Average latency | Tokens |
| --- | ---: | ---: | ---: | ---: |
| `djShortlistPick` | 152 | 152/152 | 14.8 s | 1.06M |
| `djShortlistRepick` | 62 | 62/62 | 5.7 s | 296.2k |

The repick volume is expected to be elevated for strict shows with a small
permitted library (the observed overnight show had 1,114 eligible tracks).

A useful real-life Musical Leanings trace occurred at 05:15 on 9 September:
Lucy’s native three-pass shortlist selected **Morcheeba — Blue Chair** after
Context (`tracksByMood`), Continuity (`tracksThatSoundLikeThis`) and Exploration
(`starredSongs`) returned 24 candidates. The private selection reason explicitly
referred to Lucy’s broad melodic tastes. The full candidate list and raw reason
were provided in the session conversation; use that material only as an
operator-facing case study, never as listener-facing copy.

#### Small follow-ups, not PR blockers

- Some Booth Log `selectionReason` values reach the output character limit
  mid-sentence. The choice and provenance are unaffected. Later, either lower
  the requested length or instruct the model to finish one concise sentence
  within the schema limit.
- The old setting name is now slightly misleading because it affects listener
  requests rather than ordinary picking. Rename or clarify it only as separate
  follow-up work, alongside any native request-shortlist design.

#### Working-tree caution

The separate `/home/jaz666/codex/subwave-docs` repository contains uncommitted
user-authored documentation edits. Preserve them; do not reset, clean, or
rewrite that worktree as part of Track Shortlisting maintenance.
