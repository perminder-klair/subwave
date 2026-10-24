# Extended Sleeve Notes

Extended Sleeve Notes is opt-in and off by default. It uses the station's configured LLM to turn source-backed music research into optional Story Sparks for ordinary links and longer segments. It does not require a paid model or Genius account. The [tester guide](../testing/extended-sleeve-notes.md) covers installation and acceptance checks; the [integration map](sleeve-notes-integration.md) identifies shared Subwave code that needs review.

## Collection and ownership

The feature owns `state/sleeve-notes.db`, a SQLite sidecar separate from the music library database. Navidrome remains the playable catalogue; provider discoveries do not add playable recordings.

Confirmed playback records an encounter and queues bounded identity/source work. Workers collect MusicBrainz identity and release information, Wikipedia artist/album articles, optional Genius metadata, and MusicBrainz Series membership. LLM extraction starts only when its playback/admission rules allow it. A first encounter may finish researching after that track's DJ link was written. Operators can see newly saved material before the DJ has another opportunity to use it.

Collection yields to broadcast work, respects source pacing/backoff and the station's hard token allowance, and resumes from durable checkpoints. Empty-station research requires the operator's separate setting and confirmed zero listeners. Collection pause stops research while saved Sparks remain available; the master switch also stops feature use. Requested reviews and ordinary research share available LLM slots. Promotion changes eligible ordering without bypassing retry, playback, pacing or budget gates; cancellation retains facts and completed progress.

## Main modules

All paths below are relative to `controller/src/sleeve-notes/`.

| Concern | Main modules |
| --- | --- |
| SQLite schema, snapshots and restore coordination | `db.ts` |
| Encounter, identity and research persistence | `repository.ts`, `research-repository.ts`, `local-identity.ts` |
| Source workers and LLM extraction | `musicbrainz-worker.ts`, `wikipedia-worker.ts`, `genius-worker.ts`, `research-worker.ts`, `llm-researcher.ts` |
| Optional Genius catalogue seeding and traversal | `genius-seeding.ts`, `genius-traversal.ts` |
| Series selection and library sweep | `series-catalog-store.ts`, `musicbrainz-series-worker.ts`, `musicbrainz-series-library-worker.ts` |
| Claim validation, moderation and article retention | `researcher.ts`, `moderation.ts`, `wikipedia-retention.ts` |
| Spark selection, history and speech detection | `link-selection.ts`, `claim-signal.ts`, `heard-on-air.ts` |
| Longer segments | `segment.ts` |
| Operator review and queue actions | `airing-review.ts`, `queue-actions.ts` |
| Library matching and Station Brain | `library-connections.ts`, `connection-library-worker.ts`, `brain-library.ts`, `connections-overview.ts` |
| Read-only calculations outside the controller event loop | `connection-compute.ts`, `connection-compute-worker.ts`, `dashboard-reads.ts` |

HTTP endpoints are in `controller/src/routes/sleeve-notes.ts`. Admin views live under `web/components/admin/`, with the manual in `web/components/manual/ExtendedSleeveNotes.tsx`. Settings validate through the normal controller schema/patch registry and generated web schema mirror.

## Source and identity rules

MusicBrainz is the canonical identity/release source. Wikipedia supplies background stories with an exact supporting excerpt. Extraction checks complete standalone wording, subject, dates and factual support. Relative dates need their source anchor; an announcement date must not become an invented performance date.

Genius contributes structured credits, samples and covers, never lyrics. Turning capture off, including with a saved token, stops new Genius collection while retaining existing facts and library browsing. Names, recording versions and ambiguous identities are checked before binding provider data to a local track. Optional leading “The” artist variants are supported without relaxing recording-title checks.

Station Brain distinguishes local library entities from outside discoveries. The saved-knowledge connection count folds inverse/duplicate sample and cover descriptions into unique connections within the playable library; credits remain a separate category. External discoveries are research leads rather than playable additions.

Local track metadata and music-server identity changes invalidate bindings and queued work before old responses can publish. Connection matching runs initially in quiet time, then batches changed inputs with at least five minutes between full attempts. Unchanged inputs do not trigger a rebuild. Rejected stale snapshots keep the same interval; failures keep a ten-minute retry delay. Collection continues between passes, so new connection counts, graph matches and connection Sparks can lag behind research (longer while busy or retrying). The deadline is in memory, so a controller restart permits one initial attempt again. The lightweight catalogue timer remains separate from the expensive matching interval.

A completed catalogue sweep can remove stale local matches; an unconfirmed empty response cannot clear the catalogue. Series library sweeps checkpoint their progress and settle after completion. Unchanged Series refreshes do not recreate facts or restart a completed sweep.

## Offering and airing a Spark

Selection respects track/album/artist relevance, editorial categories, ranking, reservations and claim/topic/entity cooldowns. The DJ can pass. A supplied fact is trusted context, while the generated delivery follows system instructions and Station House Rules. Explicit historical dates and past-tense framing should survive into the link.

An offer, use detected in generated wording, successful TTS rendering, and confirmed airing are separate events. Mentioning an artist alone is not evidence that its Spark was used. Detection can miss paraphrases; the full aired ledger remains available.

Native Sleeve Notes segments use existing speech slots and configured DJs/co-hosts. Eligible automatic Banter can try a Sleeve Notes segment and fall back to Banter. Manual Banter keeps its own path. Manual Run Segment bypasses automatic eligibility/cooldowns but still requires usable material and safe broadcast publication. Speech budgets and final timing/identity checks apply before committing a rendered exchange.

## Corrections and operator intent

Flagging a saved fact or an aired exchange queues advisory review. It does not withdraw the fact. Withdrawal, restoration and deletion are explicit operator decisions, preserved through refresh and automatic maintenance.

Reviews freeze the relevant wording, evidence and airing context. The operator can apply/edit an AI proposal or open a manual correction when no replacement was supplied. Applying validates the supporting excerpt and current fact version; an unrelated target or later edit cannot be silently overwritten. Saved-fact reviews have no invented airing or speech guidance. Approved generation guidance is separate from Station House Rules and can be revoked.

Settings use pending drafts with Save/Discard. MusicBrainz list choices have their own save operation; previews and maintenance remain explicit actions. A failed save retains pending edits. Tokens are never returned to the browser; blank input preserves the existing secret and clearing requires an explicit save.

## Storage, recovery and responsiveness

The first public schema is created in one transaction. Experimental pre-release schemas are refused without modification and require a deliberate sidecar reset before enabling this build. Current public-schema databases reopen without rewriting facts, evidence, decisions or history. Station backups include a WAL-safe snapshot of the research database and coordinate with active research during restore. Disabled cached browsing must not create or migrate a file. Legacy schemas and retired research records remain readable where supported.

Raw completed Wikipedia articles can be compacted after the retention delay, keeping source identity and supporting passages/context. Incomplete research, pending moderation/reviews and refresh intent protect the article. Compaction is bounded to ten eligible articles per maintenance pass; finding those articles can still be expensive. SQLite may reuse internal space without shrinking the file on disk. There is no automatic history deletion or live VACUUM policy.

Station Brain calculations, Overview readout/queue details, live-summary candidate counts and Heard on Air database reads use a read-only child process. Display reads share in-flight work and a bounded short-lived cache; broadcast selection and action validation use current state. Same-connection writes invalidate the display cache immediately; other changes expire with its three-second lifetime. Restore clears display caches. Worker reads over two seconds and controller housekeeping over one second log timings. Write-side maintenance and legacy session JSON processing still need observation under large collections and host contention.

Use the normal isolated test runners. Never execute a controller test directly against station state. See the [integration map](sleeve-notes-integration.md) for focused checks and the [tester guide](../testing/extended-sleeve-notes.md) for real-station acceptance and reporting limits.

The initial public schema is version 1 with application id `SWN1`, so it cannot be
mistaken for the earlier experimental version 1. Initialisation is transactional;
unknown, future and experimental files are rejected without erasing their data.
See the tester guide for the deliberate research-only reset and rollback procedure.

Intro-render quiet-time accounting follows outstanding TTS promises, including
renders detached by invalidation or moved between queue items. Settlement releases
the busy state independently of those item identities. Manual Banter retains its
operator override; automatic Banter budgets log a scheduler skip and return no
spoken text. Disabling Sleeve Notes before/during speech generation releases its
reservation before rejection. Cached admin views have an explicit GET allowlist;
provider previews, research and all writes remain gated while disabled.


Public schema 2 adds indexes to the existing public schema 1 in a transaction; no
research reset is needed. Provisional Genius recordings share an unambiguous
library artist. The quiet-time catalogue worker checks at most five duplicate names
every five minutes, relocating only provisional Genius children with no direct
artist research. Recording ids, source evidence and operator artist-level work are
retained. Distinct canonical artist identities and ambiguous library names are
never folded together. Empty historical artist rows are retained for references.

Overview explains the same pause reason used by the worker gate and displays
indexed source/research progress and the next scheduled retry. A six-hour absence
of progress with ready work is a visible diagnostic, not an automatic restart or
operator alarm. Storage inspection is an explicit action in the read-only child
process, without polling or source API requests. It reports file/WAL/reusable space,
retained text by source and derived connection space where SQLite supports it.
The previous inspection is remembered locally in the browser for comparison.
