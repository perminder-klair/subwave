# Admin TanStack Query Migration Design

## Goal

Complete GitHub issue #1368 by making TanStack Query the owner of remote
server-cache state throughout the admin application, while preserving the
current operator-visible behaviour of every panel. Deliver the migration as one
pull request against `develop`, organized as reviewable, panel-scoped commits.

## Scope

The migration covers admin reads whose results are retained in React state,
admin polls, and mutations that currently trigger manual refetches or patch
cached state by hand. It also covers the shared model- and voice-discovery hooks
used by Settings and onboarding.

The following remain imperative because they are commands rather than cached
resources:

- downloads and exports;
- previews and one-off media actions;
- connectivity and credential tests;
- navigation and browser-only state;
- explicit operator commands whose response is consumed only by that action.

Non-admin users of `lib/poll.ts`, including the player feed, signal probe,
elapsed clock, and waveform, are outside this issue. This work does not change
controller endpoints, response schemas, page layout, or visual design.

## Provider and authentication lifetime

`AdminQueryProvider` moves from `LibraryPanel` into the authenticated branch of
`AdminShell`. Signing out therefore unmounts the provider and destroys all
credential-scoped cached data. `LibraryPanel` stops creating its own client and
continues using the same defaults through the shell-level client.

The onboarding wizard is not rendered under `AdminShell`, but it consumes
`useModelDiscovery`. Onboarding receives a separate, route-scoped instance of
the same provider. Public/player routes do not acquire a query client as a side
effect of the admin migration.

The client defaults remain:

- `refetchOnWindowFocus: false`;
- `retry: false`;
- `staleTime: 30_000`.

No global `QueryCache.onError` is introduced. A 401 continues to flow through
`adminFetch`, clear the stored credential, and surface the existing sign-in
state without retry traffic.

## Shared query infrastructure

Generic admin query and mutation helpers live outside the Library feature. They
accept the current `adminFetch` function rather than owning authentication, so
panels retain their existing single `useAdminAuth` boundary. Library-specific
cache-shape helpers remain in the Library feature.

The generic query helper:

- executes `adminFetch` in `queryFn`;
- passes TanStack's `AbortSignal` to the request;
- normalizes the response inside `queryFn`, never with `select`;
- adds `staleTime` and `refetchInterval` only when explicitly provided;
- exposes the existing opt-in query-error toast behaviour.

The generic mutation helper:

- executes commands through `adminFetch`;
- retains each call site's current error copy and silent-versus-toast posture;
- supports exact cache writes and prefix invalidation;
- does not invalidate unrelated feature families.

Every converted feature defines a key factory beside its query functions. Keys
identify the resource and every input that changes the response, but never the
identity of `adminFetch`. Prefixes are designed around actual invalidation
boundaries rather than page names alone.

## Read and polling migration

Each retained remote read moves from `useState` plus `useEffect` into a query.
Loading, error, and refresh controls derive from the query result. A manual
Refresh button calls `refetch` and keeps its current feedback.

Existing poll cadences are preserved exactly. Polls use `refetchInterval` and
remain paused in background tabs. Polls that currently freeze the last good
reading on failure continue to do so and do not emit a toast. Queries that
currently clear data or display an error retain that behaviour explicitly.

Parallel endpoint reads that form one indivisible UI model remain one query
whose `queryFn` uses `Promise.all`. Independently useful resources receive
separate keys so a mutation can refresh only the affected data.

## Mutation and cache consistency

Mutations move to `useMutation` when their pending, error, or completion state
is currently hand-written. After success, each mutation chooses the narrowest
correct cache operation:

1. write returned authoritative data directly when the response contains it;
2. apply an optimistic update with rollback only where the existing UI already
   promises immediate feedback;
3. invalidate the owning key prefix when the server is authoritative and the
   mutation response is incomplete.

Mutation-specific busy labels and concurrency guards remain intact. An explicit
operator action is never delayed by stale-time policy and never waits for an
automatic poll to show its result.

## Discovery-hook behaviour

`useModelDiscovery` and `useVoiceDiscovery` become query-backed with dedicated
key factories and debounced input keys. The conversion preserves all current
contracts:

- automatic requests wait 400 ms after the latest input change;
- a manual refresh fires immediately for the current raw inputs;
- obsolete requests are aborted and cannot replace the active key's result;
- disabling discovery clears its result and error;
- voice options clear immediately when provider inputs change;
- model options retain their existing transition behaviour;
- endpoint `{ ok: false, error }` responses remain ordinary discovery errors;
- discovery failures continue to fall back to free-text entry without a global
  toast.

The same hook implementation runs under both the authenticated admin provider
and the onboarding provider.

## Delivery structure

The single pull request is built as a sequence of independently reviewable
commits:

1. provider lifetime, generic helpers, key conventions, and regression harness;
2. model and voice discovery, including onboarding;
3. Dashboard and its child cards;
4. Settings and its sections;
5. Shows, schedule, and playlist programming;
6. Skills, personas, and imaging;
7. stats, stations, doctor, webhooks, archives, backup, and remaining panels;
8. final static audit, documentation update, and verification fixes.

The exact commit grouping may combine a small panel with its closest feature,
but each commit must leave lint and focused verification runnable.

## Verification strategy

`web/` has no unit-test runner, so behaviour is specified first in executable
Playwright verification scripts against the isolated verify stack. Tests are
added or extended before the production conversion they cover and are run once
to demonstrate the expected failure.

Coverage includes:

- provider survival across admin navigation and cache destruction on sign-out;
- cache reuse and request deduplication;
- no retry storm after a 401;
- exact polling cadences and background-tab suspension;
- silent versus visible query errors;
- manual refresh and post-mutation invalidation;
- discovery debounce, cancellation, immediate refresh, and provider switching
  in both Settings and onboarding;
- representative reads and mutations for every converted panel;
- the existing Library cache-shape and cross-list update guarantees.

A static audit records every remaining direct `adminFetch` call under
`components/admin`. Each remaining call must be classified as an allowed
one-shot command; no retained server-cache read or poll may remain hand-written.

Before the pull request is opened, run:

- the new admin-query verification;
- `web/scripts/verify-query-cache.py`;
- `web/scripts/verify-library.py`;
- any existing focused verification affected by converted forms or hooks;
- `npm run lint` in `web/`;
- `npm run build` in `web/`;
- `git diff --check`.

## Completion criteria

Issue #1368 is complete when every admin server-cache read and poll is owned by
TanStack Query, cache-affecting mutations update or invalidate defined keys, all
remaining imperative fetches are documented commands rather than hidden cache
state, onboarding discovery works under its scoped provider, focused browser
verification passes, web lint and build pass, and one PR against current
`develop` links and closes the issue.
