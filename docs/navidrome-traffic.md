# Understanding Navidrome traffic

An AdGuard Home count is a DNS-query count. It does not measure HTTP requests
received by Navidrome. AdGuard's [query-log documentation](https://github.com/AdguardTeam/AdGuardHome/blob/master/AGHTechDoc.md#query-log)
describes recording DNS requests. Address lookups, cached answers, connection
reuse and retries prevent a one-to-one comparison with HTTP traffic. A domain's
count alone also does not identify which application made the lookups.

Issue [#1779](https://github.com/perminder-klair/subwave/issues/1779) reported
550,000 requests in a week through AdGuard Home. Without the DNS query details,
Navidrome access logs, station version and settings, that number cannot be
attributed to a SUB/WAVE request producer. It is not an established normal
HTTP request rate for the station.

## What sleep means

There are two independent empty-room settings, both off by default:

| Setting | Behaviour with no listeners |
| --- | --- |
| `llm.pauseWhenEmpty` | Stops autonomous DJ model calls. Liquidsoap continues broadcasting music from the fallback playlist and fetching tracks. |
| `stream.idleWhenEmpty` | After `stream.idleAfterMinutes`, freezes the programme mid-track. Icecast mounts stay connected and serve silence. A listener connection resumes the programme. |

The idle monitor polls **Icecast**, not Navidrome, every five seconds while
paused so it can detect a new listener. A sustained Icecast status failure
releases the pause to keep the station available. Check `streamIdle` on
`GET /state` and the booth log's pause/resume lines (admin → Debug) to establish whether the
programme actually stayed idle. A running broadcast is expected to fetch
tracks even if its DJ is asleep. For scale, four-minute tracks played
continuously would mean about 2,520 tracks a week, before crossfades,
prefetch, failed resolutions or other work. That estimate is not a total
request budget.

Explicit library maintenance is independent of programme sleep. An active
tagging/reconciliation job enumerates albums and songs; an acoustic-analysis
job downloads audio. The analysis **quiet-times** option permits an active
pass once the room is empty. It does not pause analysis because the programme
is asleep. Merely starting the analyzer service does not launch a library pass.
Entering idle also does not cancel downloads or maintenance already in flight.

## Where requests come from

| Producer | Navidrome work | Trigger / limits |
| --- | --- | --- |
| Liquidsoap `proto_subhttp` | Whole-track `stream` download through curl | Tracks resolved for playback, including prefetch; local music mounts avoid these HTTP downloads. |
| Fallback playlist builder | Random songs, playlists, genres, a sample of recent/frequent albums, starred songs and ReplayGain lookups | Boot, periodic refresh, show changes and explicit refreshes. Automatic builds defer while programme-idle; an explicit refresh still runs. The period defaults to 60 minutes. |
| DJ picker | Discovery API calls and optional ReplayGain lookups | Picks while autonomous DJ work is allowed; explicit requests/operator actions have their own rules. |
| Library count | Album pages and one `getAlbum` per album | Count-library command and the guarded start/end of a tagging run. Coverage GETs and library reset do not start a count, per #1570. |
| Tagger / reconcile | Catalogue walk, optional per-track enrichment, post-run recipe playlist sync | A maintenance run, including confirmed Navidrome ID-rotation recovery. No periodic full-catalogue scan. |
| Acoustic analysis | Capped audio prefetch and optional structured lyrics | An active analysis pass. A remote backend unable to see the shared file, or a failed prefetch, may download by URL itself. |
| Artwork proxy | `getCoverArt` on an in-process cache miss | Cover requests from players/admin pages; successful covers also receive a browser/edge cache header. |
| Connectivity / Doctor | `ping` | Connection tests, open admin banner polls with a 20-second cache, Doctor runs including the nightly run. |
| Navidrome scrobbling | Now-playing and eligible completed-play `scrobble` calls | Opt-in, disabled by default; continues for empty-room broadcasts to rotate smart playlists. |

The 1.5-second now-playing watcher reads a local marker file. Public
`/now-playing` metadata comes from that marker and the local library DB;
its regular five-second player polls do not each call Navidrome.

## Measure before changing settings

1. Compare the same time interval in AdGuard's DNS query log and the HTTP
   access log at Navidrome or its reverse proxy. In the DNS log, include the
   client, query type, response and timing. In the HTTP log, group by endpoint
   path, status and client identity. Exclude query strings when sharing logs;
   Subsonic stream URLs carry authentication tokens.
2. Check the actual programme-idle state, the tagger/analysis job status, and
   pause/resume lines during that interval. Close unused admin tabs when
   measuring a completely unattended station.
3. Inspect `GET /debug` as an admin. `subsonic.endpoints[].calls` counts logical
   API calls. `subsonic.httpAttempts` counts fetch dispatches by endpoint,
   purpose and active trace kind, including transport retries, failed connects,
   connection tests, cover misses and controller-side analysis downloads.
   `since` and `pid` identify the counter interval and process. Counters reset
   on restart or `POST /debug/subsonic/reset`; reading them sends no request
   to Navidrome.
4. For maintenance child processes and longer intervals, count
   `navidrome.http-attempt` events in the active station's
   `logs/events-YYYY-MM-DD.jsonl` files. Each event includes `pid`, entrypoint
   `process`, `purpose`, `endpoint`, `traceKind` and the existing `traceId`.
   These attempt events contain no URLs, query parameters or credentials.

For example, with `SUBWAVE_STATION_STATE` pointing at the active station's
state directory, group a day's attempt events without printing request data:

```bash
jq -r '
  select(.type == "navidrome.http-attempt")
  | [.process, .purpose, .endpoint, (.traceKind // "untraced")] | @tsv
' "$SUBWAVE_STATION_STATE/logs/events-2026-10-05.jsonl" \
  | sort | uniq -c | sort -nr
```

The debug counters cover only the process serving the API. Child workers have
separate counters but append to the same station event files. Neither records
Liquidsoap's curl downloads or Python/remote analyzer URL downloads, and a
fetch dispatch does not count redirect hops or prove Navidrome received it.
The durable events are best-effort and retained for 14 days. Use upstream
HTTP logs for a complete count, including those external downloads.

An internal Navidrome address can avoid the public proxy/DNS route, but it
does not reduce how much catalogue or audio work the station asks for.
Choose reductions from the measured producer: stop an unwanted maintenance
run, adjust its scope, or use the programme-idle control when playback should
freeze. Keep library coverage reads free of scans and preserve continuous
music when only the DJ is paused.
