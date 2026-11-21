# Testing the Extended Sleeve Notes draft

This is an experimental source build for operators willing to test it on their own station. Extended Sleeve Notes is off by default. It uses the station's configured LLM; a paid service and Genius access are optional. Start with the [manual guide](../../web/components/manual/ExtendedSleeveNotes.tsx) and use the [integration review map](../internals/sleeve-notes-integration.md) for technical boundaries and test evidence.

## Choose the build and keep a recovery route

For a fresh test installation, the testing branch is:

```sh
git clone --branch feat/extended-sleeve-notes-testing https://github.com/Jaz666/subwave.git subwave-sleeve-notes-test
cd subwave-sleeve-notes-test
```

The upstream draft PR links to this same branch. Record the commit you actually test. Fetching or checking out the branch does not update running containers, and the ordinary published `latest` images do not represent this unmerged source.

For a fresh installation, complete the normal [source-install setup](../../README.md), including private environment/admin configuration, ports and volume paths, before starting services. A separate test installation needs separate state/IPC paths; do not run two controllers against one station state directory.

For an existing installation, save local source changes and record the current code revision and image versions before changing branches. Take a Subwave backup before enabling the feature or upgrading an existing research database. Keep the installation's private environment/compose files and music connection credentials separately if they are not included in the backup. Use the correct active station/profile; a sibling profile's backup is not a substitute.

Use Subwave's backup export for an online SQLite snapshot. Copying only a live `.db` file can miss pending WAL data. An offline full state-directory copy requires the services using that state to be stopped first. Do the initial trial during an acceptable maintenance window or on a separate installation.

Build from the checked-out source, keeping your installation's normal compose overrides/profiles. A fresh source checkout uses:

```sh
docker compose build controller web broadcast
docker compose up -d
curl -fsS http://localhost:7700/api/health
```

Existing installations must include their usual compose files in both commands. Rebuild controller and web for feature updates; the initial switch can also include upstream mixer changes, which require the broadcast image. A plain restart reuses old images. Health passing establishes service availability, not uninterrupted or correctly timed audio.

## What to check

1. **Before enabling:** ordinary picking, requests, DJ links and automatic/manual Banter still work. Feature UI and operations are disabled. Turning the feature off does not reverse shared timing/LLM changes in the draft branch.
2. **First enable:** save Settings → DJ Behaviour → Extended Sleeve Notes. Begin with the station's normal LLM and Genius capture off. Play a few artists and albums. A growing research queue is normal; saved material can appear on Dash after the current DJ link has already been written.
3. **Optional Genius:** try off with a saved key, on without a key, and on with a valid key. Wikipedia/library browsing should remain usable without it. Previously saved relationships stay visible when capture is off. Never include the actual key in a report.
4. **Repeats and content:** play an artist again, inspect a saved story and follow its source. Check dates and standalone wording. Flag a punctuation/time-context problem, inspect the proposed correction, and cancel before testing an approval. A flag alone must not withdraw or delete a fact.
5. **Library changes:** correct a track title/artist or recording MBID, and try a duplicate album copy or a live/remix version. Changed identities must rematch before reusing old facts. Unchanged recordings should reuse research. If testing a different music server/account, expect local matches and catalogue views to rebuild while saved facts and history remain. Password rotation alone should preserve matches.
6. **Research contention:** listen while the model or a source is slow/unavailable. Music and ordinary DJ work must retain priority. Check the queue's waiting explanation. Research uses the shared token allowance; a paid usage estimate is not a cap or a promise of cost per played track.
7. **Pause and disable:** collection pause keeps saved Sparks usable. Master disable stops new feature work. Try it during a lookup, generation and pending speech, then re-enable. A voice already committed to a mixer silence must finish safely; uncommitted feature speech must not appear later.
8. **Restart and restore:** restart the controller during research and confirm work resumes rather than duplicating speech or restarting every Series sweep. On a disposable installation, restore a real older backup and a backup taken after collecting material. Keep the source build and restored state compatible.
9. **Browser:** check Dash, Settings, Notes, Station Brain and the manual. In Overview → Research activity, expand Show queue: Send to top and Cancel job appear only there, even with a single job. Promote eligible work, confirm delayed work still waits, cancel a queued job and verify saved material remains. Running jobs disable both actions; a stale click must be refused. Cancelled automatic work can be queued again; cancelled reviews are dismissed. Use keyboard navigation and cancel each confirmation. Library connections and Credits in Saved knowledge open Station Brain; Stories opens saved stories. Library connection counts exclude outside recordings and fold inverse sample/cover descriptions. Connection matching batches updates with at least five minutes between full calculations; allow for that delay when checking new relationships. Busy periods or retries can delay them further.

A small library, a large library, non-English names and a slower local LLM are useful variations. Report which combinations were actually tried; mocked provider/model tests are not evidence of live service quality.

## Storage expectations

Facts, supporting evidence, operator corrections and airing/review history are retained. This draft also keeps research/provider diagnostic history; it does not promise a fixed database ceiling or silently expire that history.

Full Wikipedia article text is temporary. Successfully completed sources normally become eligible after 24 hours, but maintenance processes at most ten per hour and yields to broadcast activity, collection pause, pending work and reviews. A backlog can therefore take days to clear. Superseded revisions retain their own completion timestamp. Articles without proof of completed research remain untouched.

Space freed inside SQLite can be reused without reducing the file's apparent size. Compaction is a separate maintenance operation. Record database/backup growth over the trial, alongside counts of artists, facts and completed research; do not interpret file size alone as duplicate data.

## Accidental actions worth testing

On a disposable installation, remove a previously observed incorrect recording MBID without changing the other tags. Check that the next catalogue update or explicit Station Brain research clears the old match before rematching. Also check a tagless track that was matched automatically: ordinary rescans must keep its match. Removing artist tags should remove the track's old local bindings rather than quietly retain them.

Pause collection, disable the feature, or make broadcast work busy while a library request is pending. That late catalogue response should not be published. Start a Navidrome scan during an album fetch: the sweep should defer and restart. Then repeat bulk moves/deletions until a stable sweep finishes; check that library membership converges. An unknown scan status must not delete unseen cached tracks. An entirely empty library deliberately retains the old cache for now, because it cannot safely be distinguished from temporary loss of access by that response alone; do not interpret this as verified current membership.

Use two browser tabs to flag/review the same story, change it in one, then try the old decision in the other. The old decision must be refused. Legacy clients calling the retired direct story-edit/delete endpoints receive HTTP 410; use the review workflow instead. Withdrawal and restoration remain separate supported actions.

Disk-full, permission and clock-change experiments belong only on a separate installation. Record whether ordinary audio continues, whether the problem is visible, and whether research recovers when the environment is repaired. A passing mocked test is not a substitute for these checks. When restoring a pre-feature archive, expect current research to be retained if the archive contains no research database.

## Return to the previous station

Switching the feature off retains the research database and is not a complete rollback of the branch. To return to a pre-test state, use the recorded previous code/images and the matching pre-test backup. Restore through the supported backup workflow or perform an offline state restore with services stopped. Rebuild the prior source if necessary; restarting an image built from this branch does not restore old code. Confirm ordinary playback, requests, DJ links and health after recovery. Do not assume an older feature build can safely write a database upgraded by a newer one.

## Useful feedback

Include the tested commit, fresh-install/upgrade status, library size, enabled source switches, LLM provider/model, steps, expected/actual behaviour and approximate event time. For wrong music identity, include the library artist/title/version and the source's displayed identity. For wrong stories, include the saved wording, supporting passage and source URL. For timing problems, say what was actually audible and whether it was a link, Banter or Sleeve Notes segment.

Exclude credentials, full settings exports and your database from a public issue. Sanitised screenshots and the relevant short log excerpt are enough to start triage.


### Reset required for experimental databases

This draft now uses one initial public schema. Earlier experimental databases (including schema 61) are deliberately not upgraded or erased automatically. Only experimental databases require this reset. Public schema 1 is supported and upgrades without a reset. An old backup containing that experimental database cannot be imported into this build.

Before testing, export a station backup with the old build and retain the old source/images for rollback. With the controller stopped, move **only** `state/sleeve-notes.db` and its `-wal`/`-shm` companions to a backup directory outside the state directory. Keep all companion files together; do not remove a WAL while the controller is running. Leave settings, credentials, library databases, session history, media and other state untouched. Start the rebuilt controller to collect research again. Operator corrections, reviews, cooldowns and research history in the moved sidecar will no longer be present in the fresh collection.

To roll back, stop the controller, restore the previous source/images and the complete saved sidecar set, then start again. Do not open the new public-schema database with an older experimental build.


### Follow-up acceptance: identity, progress and storage

Public schema 1 upgrades to schema 2 by adding indexes only. Do not reset research
for this update. During quiet catalogue turns, duplicate provisional artist names
are checked in batches of five, at most once every five minutes. Confirm that a
previously repeated artist becomes one Browse Library entry, its recordings and
saved facts remain available, and unrelated same-name artists stay separate.
Artist-level research can deliberately prevent automatic reconciliation.

Overview now names the current pause reason, shows the latest successful source
collection/research completion and the next scheduled retry. Normal broadcast,
listener, budget and operator pauses should explain themselves. A long absence
of progress with ready work should show a diagnostic, not an automatic restart.

Inspect storage explicitly to read database, write-log, reusable-space and source
text sizes; repeat later to compare file growth in the same browser. There is no
automatic polling. Source text sizes omit other tables and indexes. Observe the
fresh collection over several days before changing retention policy.


### Show handover acceptance

A Sleeve Notes conversation belongs to the show that requested it, even when
started manually. Near a normal show change, request one while it is still being
written or rendered. Once the handover has claimed the boundary, unused outgoing
speech should stand down rather than follow the incoming greeting or hourly check.
The same rule applies when adjacent shows use the same presenter. Speech already
published to the mixer finishes normally. Check that ordinary playback and research
resume afterwards; manual Banter retains its existing operator override.


### Library relationship count correction

Public schemas 1 and 2 upgrade automatically to schema 3 without a research reset.
After a controller rebuild, allow a quiet background matching pass and an Overview
refresh. Library Connections should include unplayed tracks already present in the
cached catalogue, while still excluding external endpoints and ambiguous versions.
Inverse descriptions and compilation copies of the same recording count once.
Removing or retagging a local recording must clear its old source match. This
update does not fetch the same Genius sources again to repair the count.

## Research gaps and source corrections

Public schemas 1–3 upgrade additively to schema 4; no research reset is needed.
Back up the database before upgrading. Rolling back to a build that supports only
an earlier schema requires restoring its compatible backup, not opening schema 4
with that older build.

In Review > Research gaps, refresh the local coverage check and inspect a missing
or partial biography. Confirm ordinary unplayed artists and pending research are
not reported as broken sources. A library source scan checks known identities
quietly and can be cancelled; provider failures should appear separately from
missing articles. Saving a research identity or Wikipedia URL, rescanning, and
clearing an override should leave canonical recording matches unchanged. Test a
single-field edit, an artist with duplicate provider records, and a genuinely
ambiguous identity. Advanced details should explain the separate identities.

## Browsing under load

Use a populated research database. Open Stories > Browse Library in two browser
sessions and switch between it, Review, Overview and Station Brain while research
is running. Search, clear, change pages and open artist/album/track details. Search
should update after a short typing pause, starting at two characters; clearing
restores the list and a new search starts at the first page. Keep searches within
the current browse level.

Watch controller health, scheduled work and broadcast continuity during these
checks. Page latency and controller responsiveness are separate measurements:
a slow page must not prevent health requests or broadcast timers from running.
Report database/library size and whether fresh research was being saved. Avoid
stress-testing external provider APIs; replay stored results in an isolated cache
for heavier load tests.
