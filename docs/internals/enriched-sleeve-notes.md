# Enriched Sleeve Notes — future development note

## Status and scope

This is a future, opt-in enrichment feature. It is not part of the current
Verified Facts deployment and must not delay music selection, link generation,
TTS, queue draining, or show handoffs.

It is independent of the retired Producer Routing architecture. It uses native
controller jobs and a local knowledge cache; no Producer or local-LLM
fact-checking stage is proposed.

## Purpose

`Sleeve Notes` currently supplies a small deterministic set of trustworthy
library, station-history, and schedule facts to a DJ link. Enriched Sleeve
Notes would add optional, source-backed editorial context for music that the
station actually encounters. It is an enhancement, not a requirement for every
track or every station.

The intended station behaviour is:

```text
Track queued
    |
    +-- local knowledge exists --> optional eligible Sleeve Note
    |
    +-- knowledge absent ------> add low-priority enrichment candidate
                                      |
                                      +-- runs only when playback-critical work is idle
                                      +-- later tracks may use the result
```

A cache miss always falls back to the present link path. No network call is
allowed from `generateLink` or any other on-air critical path.

## Editorial classification

Keep the categories distinct in storage and prompt construction:

- **Verified Facts** are deterministic controller/library/station facts.
- **Sourced Sleeve Notes** are optional editorial material retrieved from a
  configured source. They are useful on-air context, not a guarantee that a
  source claim is indisputable.
- **Creative material** is persona and writing direction. It is never a source
  of factual assertions.

The DJ receives one compact, approved note, not a raw provider response. Prompt
rules must prevent it from strengthening or extending a source claim using
model memory.

## Opt-in station setting

Add a per-station master setting, provisionally named **Enriched Sleeve
Notes**, disabled by default.

When disabled, it must make no provider calls, schedule no enrichment jobs, and
leave current Verified Facts and Sleeve Notes behaviour unchanged. This keeps
fictional, fantasy, and deliberately non-real-world stations fully supported.

When enabled, the UI should distinguish:

1. disabled;
2. enabled but no source configured; and
3. enabled and gathering knowledge.

Provider credentials are supplied by the station operator, not bundled with
Subwave. Provider configuration sits below the master setting.

## Gained-knowledge backlog

Do not scan the whole library. Enrichment is gained knowledge: candidates enter
a small, persistent backlog only when their tracks are queued. Prefer common
station artists/releases, for example by admitting an entity after a second
queued appearance or by weighting it with recent play count.

Jobs are deduplicated by entity and run with strict low priority, bounded
concurrency, rate limiting, retry backoff, and negative-cache results for
unmatched entities. Playback, picking, link writing, TTS and handoffs always
win. The controller need not be literally idle; it must merely have no
higher-priority work waiting.

Suggested job lifecycle:

```text
unknown -> queued -> fetching -> ready
                    |             |
                    +-> no-match  +-> stale / refreshable
                    +-> retry-at
```

Start with artist and release context. Track-specific context should remain
sparse and be attempted only where the broader entities do not already offer a
suitable note.

## Local data contract

Use a sidecar database keyed through Subwave's existing library/Subsonic track
identity, rather than modifying Navidrome's own database. Represent artist,
release and track entities separately so many tracks can share one artist or
release lookup.

Each claim should retain at least:

- entity and constrained claim type;
- short approved on-air wording;
- provider, provider entity ID and canonical URL;
- supporting source excerpt;
- retrieval time and freshness state;
- source/editorial classification; and
- eligibility or operator-review state.

The runtime selection step reads only approved local claims and lets them
compete with existing Sleeve Notes, preserving sparse and varied speech.

## Provider model

Make sources pluggable behind a small native provider interface. Each provider
owns authentication, rate limiting, matching, retrieval, and its source policy;
the cache exposes one common claim format to the rest of Subwave.

Possible avenues, subject to API terms and an implementation spike:

- MusicBrainz for structured release identity, dates, credits and relationships;
- Discogs for edition, label and personnel context;
- Genius for song-specific, crowdsourced editorial hooks;
- Last.fm for broad artist biography and community tags; and
- Wikidata/Wikipedia for wider artist history and cultural context.

Prefer official APIs or explicitly permitted feeds. Do not make scraping a
foundational dependency.

## First implementation slice

1. Add the disabled-by-default station setting and provider configuration
   contract.
2. Add the persistent, deduplicated gained-knowledge backlog, with no runtime
   consumer initially.
3. Implement one source adapter and its provenance-preserving local records.
4. Add deterministic claim selection to Sleeve Notes, guarded by the master
   setting and the existing prompt-safety boundary.
5. Observe cache hit rate, work backlog, fetch failures, link latency, and
   on-air repetition before adding further providers or track-level material.
