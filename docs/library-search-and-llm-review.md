# Library Search & LLM Prompt Review

_Review date: 2026-05-16. Scope: how SUB/WAVE searches the Navidrome library
(repeated-result risk) and how the LLM prompts are built._

**Status (2026-05-16): all recommendations below have been implemented**, except
finding D (mood routing) — the library on this machine was never tagged, so
that path is expected to be dormant. See the priority table at the end for the
per-item mapping to changed files._

Files reviewed: `controller/src/music/subsonic.js`, `music/picker.js`,
`music/library.js`, `routes/request.js`, `broadcast/scheduler.js`,
`llm/dj.js`, `llm/sdk.js`, `llm/tools.js`, `llm/log.js`, plus `state/auto.m3u`
and `state/logs/radio.log`.

---

## Part 1 — Library search: are we querying Navidrome properly?

### Summary

The search layer works, but several paths are **deterministic and shallow**, so
the same handful of tracks resurface. The most serious issue is that **genre
requests never actually search by genre**. Evidence from `radio.log` (last ~80
track-title log lines): `Pal Pal (Sickick Remix)` ×6 and `Walking on Water` ×4
against most others ×1 — a real skew (log lines aren't 1:1 with plays, so the
multiples are inflated, but the imbalance is genuine).

### Findings

#### A. **[High] Genre requests don't search by genre — `getSongsByGenre` is dead code**

- `subsonic.getSongsByGenre()` exists (`subsonic.js:55`) but is **called
  nowhere**. `grep` confirms zero call sites.
- `REQUEST_SYSTEM` (`dj.js:164`) explicitly tells the model to put *real
  genres* — `"punjabi"`, `"lofi"`, `"jazz"` — into `search_terms`.
- `request.js` step 2b then feeds those terms to `subsonic.search()`, which
  hits the Subsonic **`search3`** endpoint — a full-text match across
  **title / artist / album only**. It does *not* consult the ID3 genre tag.
- Consequence: "play some hip hop" → `search3("hip hop")` matches almost
  nothing, because virtually no track *titles* contain the literal words "hip
  hop". Yet `auto.m3u` shows every track carries a real genre tag
  (`Hip-Hop`, `Regional Indian`, `Alternative Rap`, `New Age`, `Worldwide`…).
  The entire genre catalogue is invisible to genre requests.

**Fix:** Add a `genre` field to `REQUEST_SCHEMA`, have `matchRequest` populate
it, and in `request.js` route genre hits through `subsonic.getSongsByGenre()`
(randomise the result, since `getSongsByGenre` returns a stable list). Keep
free-text `search3` only for artist/title terms.

#### B. **[High] `search3` is deterministic and capped at 25 — same query → same top-25**

- `subsonic.search(term, { songCount: 25 })` always returns the first 25 hits
  by relevance, in the same order. No `songOffset` is ever passed (the endpoint
  supports it).
- For an artist with >25 tracks, songs ranked 26+ are **unreachable** through
  this path. `randomFresh` then picks randomly within that fixed 25 minus the
  25 recently-played ids — so on a busy station the effective pool can shrink
  to single digits.
- **Worse:** a *bare* artist request ("play Diljit Dosanjh") sets
  `matched.artist` but leaves `sort=null, scope=song`. Step 2a only fires when
  `matched.sort || scope==='album'`, so bare artist requests **skip the
  catalogue-walking `pickByArtistAndSort` path** and fall to the shallow 25-row
  `search3` path instead. The deep-catalogue path exists but isn't used for the
  most common request shape.

**Fix:** In `request.js` step 2a, also take the artist path when `matched.artist`
is set and no specific song title was named (i.e. the search terms are just the
artist). `pickByArtistAndSort` walks artist → albums → songs and reaches the
*whole* catalogue. Separately, consider a random `songOffset` or a larger
`songCount` for the generic search path.

#### C. **[Medium] Picker memoisation freezes a shuffled result for 30 minutes**

In `picker.js`, the `recent-tracks` and `frequent-tracks` sources are wrapped in
`memo(..., CACHE_TTL_MS, async () => tracksFromAlbums(shuffle(albums)…))`.
Because the `shuffle()` happens **inside** the memoised function, the 12 chosen
tracks are frozen for the full 30-minute TTL. Every pick in that window sees the
*identical* recent/frequent candidates; only the `notRecent` filter rotates them
out as they play. The shuffle that was meant to add variety is defeated by the
cache.

(`playlist:` and `similar-artist:` memos are fine — they wrap deterministic
calls and shuffle/cap *outside* the memo.)

**Fix:** Memoise the raw album list (or a larger track pool), then `shuffle` +
`slice` *per pick* outside the memo. Or drop the TTL for these two sources to
~5 min.

#### D. **[Medium] Mood routing is inert — `moods.json` doesn't exist**

`state/` has no `moods.json`, so `library.songsByMood()` returns `[]` for every
mood. That silently disables:

- picker source #2 (`mood-library`, cap 10),
- the auto-playlist `mood` source (`scheduler.js:68`),
- request paths 2c (mood-tagged) and 2e (dominant-mood fallback),
- the agent's `tracksByMood` tool.

Vibe requests ("something calm", "rainy day") therefore fall straight through to
`getSimilarSongs` / `getStarred`. This isn't a code bug, but a large slice of the
"smart" routing is dormant until someone runs `npm run tag`. Worth surfacing in
the admin UI ("library untagged — mood routing disabled").

#### E. **[Low] `getSimilarSongs2` is deterministic**

Same seed song always returns the same similar list (it's a stable Last.fm-backed
result). Used in picker source #1 and request path 2d. `notRecent` + `randomFresh`
mitigate it, but during a session the same seed keeps yielding the same
neighbours. Acceptable; just be aware it's not a variety source.

#### F. **[Medium] No per-artist cap in the candidate pool**

`buildCandidates` de-dupes by **song id only**. Nothing stops the 18-slot pool
being dominated by one artist (similar-songs + similar-artist + a frequent album
can easily stack the same name). `PICKER_SYSTEM` tells the LLM "avoid same
artist back-to-back", but the LLM can only choose from what it's handed — if 12
of 18 candidates are one artist, variety collapses regardless of the prompt.

**Fix:** Cap candidates per artist (e.g. max 2–3) in `buildCandidates` before
the final shuffle/cap.

### Things that are correct

- Subsonic auth uses proper salt+token MD5 — good.
- `recentlyPlayedIds(25)` + `notRecent` filtering is applied consistently across
  the picker, request route and auto-playlist. `history` is capped at 50.
- `auto.m3u` currently holds 30 **distinct** tracks (verified) — the
  auto-playlist builder dedupes correctly.
- The picker pool path logs source counts (`pool 18 (similar=8 recent=4 …)`) —
  this is the right place to *see* finding D in production (a permanent
  `mood-library=0` is the tell).

---

## Part 2 — LLM prompts

The prompt architecture is solid: a shared "right now" context block, rotating
narrative **angles**, an opener blocklist, and a recap of recent on-air lines —
three independent anti-repeat layers for DJ scripts. Recommendations below are
refinements, not rewrites.

### Findings

#### 1. **[Medium] The picker is choosing nearly blind**

`pickNextTrack` sends candidates as `{ id, title, artist, moods, energy }`. But:

- `album`, `year`, `genre` are **dropped**, even though `PICKER_SYSTEM` asks the
  model to judge "era" and "tempo" flow — it can't, those fields aren't there.
- `moods` / `energy` are almost always `null` (untagged library — finding D).

So in practice the LLM picks the next track from **title + artist strings
alone**. Add `year` and `genre` to the candidate payload (already on every
Subsonic song, zero extra cost) — that alone restores era/genre-aware flow.

#### 2. **[Low] `_source` label is hidden from the picker**

`buildCandidates` tags every candidate with `_source` (`similar`, `recent`,
`frequent`, `starred`…) and then strips it before the LLM sees it. Passing it
through (e.g. as a `why` hint) would let the model balance "fresh add" vs
"similar to current" deliberately instead of guessing.

#### 3. **[Medium] Raw-JSON instructions — keep them, but trim the vestigial parts**

> **Corrected 2026-05-16 after live testing.** The original recommendation here
> was to remove the literal JSON instructions and "let `Output.object` own the
> format". Testing against the deployed model proved that wrong — see below.

`djObject` uses the AI SDK `Output.object({ schema })`, which on Ollama is
backed by the native `format` JSON-schema constraint. **The deployed model,
`nemotron-3-super:cloud`, ignores that constraint** — probed directly, it
returns prose even with `format` set. It only emits JSON when a literal
`{ ... }` example is present in the prompt.

So the literal JSON shape is **load-bearing for this model**, not redundant:

- `REQUEST_SYSTEM` keeps its worked examples (each shows a literal JSON object)
  → `matchRequest` works.
- `PICKER_SYSTEM` originally ended with a literal `{ "id": …, "reason": … }`.
  Removing it (the first pass of this review) caused **every auto-pick to fail**
  with `No object generated: could not parse the response` — the model returned
  prose. The JSON shape was restored.

What *was* safe to trim: the `"in this exact order"` clause in `REQUEST_SYSTEM`
(object key order is irrelevant to Zod) and the imperative "You MUST respond
with a JSON object" framing. The field documentation and the literal example
objects must stay. Lesson: with a local model that doesn't honour structured
output, the in-prompt example is the real format contract — don't strip it.

#### 4. **[Low] `AGENT_INSTRUCTIONS` duplicates `PICKER_SYSTEM`**

`picker.js` `AGENT_INSTRUCTIONS` and `dj.js` `PICKER_SYSTEM` carry two near-
identical copies of the 4-point selection criteria. They will drift. Extract one
shared constant (e.g. `PICKER_CRITERIA` in `dj.js`) and compose both from it.

#### 5. **[Low] `recentPlays` role is ambiguous to the picker**

`recentPlays` is passed into `pickNextTrack`, but since candidates are *already*
`notRecent`-filtered, it's there purely as flow context — not a blocklist. The
prompt never says so. One clarifying line ("recentPlays is for judging
transition flow; every candidate is already guaranteed unplayed") removes a
plausible misread.

#### 6. **[Low] `matchRequest` examples use placeholders**

The worked examples use `<artist>`/`<title>` placeholders — good for not biasing
toward a real name, but a couple of fully concrete examples help weaker local
models lock onto the shape. Optional.

### Logs / observability

- `llm/log.js` `recentCalls` is an **in-memory ring buffer of 30** entries,
  lost on restart. On an active station that's barely ~1 hour of history —
  too thin to diagnose "why does it keep picking X". Recommend bumping to
  100–200, and/or appending picker decisions (`pick id + reason + source`) to a
  file in `state/logs/` so repeated-pick patterns are reviewable after the fact.
- The `ai-pick` `djLog` entry already records `reason` + `source` — good. The
  picker `pool N (...)` line is the best in-product signal for finding D.
- `radio.log` is Liquidsoap-only; controller LLM activity goes to
  `docker compose logs controller` (stdout) and is not persisted. A persistent
  controller log would make this kind of review repeatable.

---

## Priority order — and what was done

| # | Severity | Change | Files | Status |
|---|----------|--------|-------|--------|
| 1 | High | `genre` field on request schema; genre hits routed to `getSongsByGenre` via a new `resolveGenre()` (fuzzy-matched against `getGenres()`) | `dj.js`, `request.js`, `subsonic.js` | ✅ done |
| 2 | High | `pickByArtistAndSort` now also used for bare artist requests; albums shuffled when no sort given so the whole catalogue is reachable | `request.js` | ✅ done |
| 3 | Medium | `recent`/`frequent` memo now caches a wide ~40-track pool; a per-pick `shuffle` draws a fresh sample (no more frozen 12) | `picker.js` | ✅ done |
| 4 | Medium | `album`+`year`+`genre` added to the picker candidate payload | `picker.js` | ✅ done |
| 5 | Medium | Per-artist cap (max 3) in the candidate pool | `picker.js` | ✅ done |
| 6 | Medium | Trimmed only the vestigial `"exact order"` framing; the literal JSON shape was **kept** in both prompts — the deployed model needs it (see finding #3, corrected) | `dj.js` | ✅ done (revised) |
| 7 | Low | Shared `PICKER_CRITERIA` constant, consumed by both `PICKER_SYSTEM` and `AGENT_INSTRUCTIONS` | `dj.js`, `picker.js` | ✅ done |
| 8 | Low | `source` tag passed through to the picker LLM, with a key in the system prompt | `picker.js`, `dj.js` | ✅ done |
| 9 | Low | `recentCalls` buffer 30→120; picker decisions appended to `state/logs/picks.log` via `recordPick()` | `log.js`, `picker.js` | ✅ done |
| — | Ops | Run `npm run tag` so mood routing (finding D) works | — | ⏭ skipped — library never tagged on this machine, dormant by design |

Also done as part of #2: a random `songOffset` (0/25/50) on the generic
`search3` path, with a first-page fallback if the offset overshoots — so
repeated requests for the same artist/title don't always cycle the same
top-25 hits.

None of these are correctness-critical for the stream staying on air; they
address variety and request accuracy. Items 1 and 2 are the ones a listener
would actually notice.
