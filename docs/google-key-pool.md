# Gemini key pool (free keys first, paid key last)

Google's Gemini API has a free tier with a daily quota per API key. A station
that leans on it — DJ scripts, banter, segment research — can burn a single
key's daily allowance in an afternoon and then sit there getting `429`s for the
rest of the day while the DJ goes quiet.

The key pool solves that: give the station **several keys, cheapest first**, and
it fails forward through them instead of stopping.

```
  key 1 (free)   → 429 quota  → held for however long Google asks
  key 2 (free)   → 429 quota  → held
  key 3 (free)   → 429 quota  → held
  key 4 (paid)   → keeps answering; the station never notices
```

The ordering is the whole feature. Put your free-tier keys first and the paid
one last, and the paid key absorbs only what the free keys can't cover — which
is the intended shape, and usually a small fraction of the day's calls. Keys
are used in the order shown, and **↑ ↓ reorder them**, so getting the order
right afterwards is a click rather than a re-add.

If **every** key is spent, nothing changes for the worse: the station falls
back to its configured backup model, exactly as it did before this existed.

## ⚠️ Check Google's terms before you set this up

Running multiple free-tier keys in rotation to get around a single key's quota
may conflict with the [Google APIs Terms of Service](https://developers.google.com/terms)
and the Gemini API's own free-tier terms. Google can change those terms, change
how quotas are enforced, or restrict a project without notice.

**Read the terms yourself and decide whether your use is permitted.** SUB/WAVE
does not, and cannot, tell you that a given arrangement complies — that call is
yours. Set this up only if you're satisfied it does. Everything here is a plain
list of keys the operator supplies; the station does not acquire, generate,
share or rotate keys on its own.

If your use doesn't fit comfortably inside a single key's free tier, the paid
key on its own — no pool — is the straightforward option, and this whole page
is irrelevant.

## Setting it up

**Admin → LLM → Google (Gemini) API key.** Below the existing single-key field
is the **Gemini key pool**. Paste a key, hit **Add key**, repeat. The pool is
used in the order you add it, and **↑ ↓** move a key up or down.

Each entry shows:

| State | Meaning |
|---|---|
| `in use` | This is the key currently being used |
| `standby` | Ready, waiting its turn |
| `held ~42m · daily quota` | Exhausted for the day; skipped until the timer lapses |
| `held ~5s · rate limit` | Briefly throttled; back in seconds |

Keys are identified by a short fingerprint (`••••bhzQ`) so you can tell them
apart, and you can give each one a **name** — "Free 1", "Free 2", "Paid" — so
the list reads the way you think about it. Names save when you click away from
the field.

**The station never sends a key value back to the browser** — not to the admin
UI, not to `/settings` — so you can't copy one out of the page, and a saved pool
can't leak through a screenshot of the API response. Names travel; keys don't.

Keys are stored in `state/secrets.env` as a comma-separated list and take effect
immediately, with no controller restart:

```bash
# key:name pairs — the name is optional, so a bare list is still valid
GOOGLE_GENERATIVE_AI_API_KEYS="AIza...free1:Free 1,AIza...free2:Free 2,AIza...paid:Paid"
```

The name lives **inside** the same variable as its key rather than in a separate
list, because a separate list of names indexed against a list of keys is the
shape that silently reattaches labels to the wrong credentials the first time a
key is moved or removed. A Google key can't contain a colon, so the first colon
is the split point and a name may contain colons of its own. Commas are stripped
from names when they save, since they separate entries.

The single `GOOGLE_GENERATIVE_AI_API_KEY` still works and is read as a one-key
pool, so a station that never touches this feature behaves identically to before.

## How the hold is decided

A `429` doesn't always mean the same thing, and treating them the same either
wastes a key or wastes time:

- **Daily exhaustion** — the response names a `…PerDay…` quota. Nothing clears
  until the quota resets, so the key is parked for **1–3 hours**, randomised.
  This matters because Google attaches a short `RetryInfo` to these responses
  too; honouring it means sleeping a few seconds, waking, and immediately
  hitting another `429`.
- **A per-minute rate limit** — Google says how long in seconds. That number is
  taken at its word and the key comes back that quickly.
- **No usable hint** — parked for 1–3 hours, randomised, so a pool of keys
  sharing one quota policy doesn't all wake on the same second.

Only a `429` parks a key. A `403` on a valid key is a permissions or model
problem that a different key won't fix, so the station reports it rather than
quietly hiding a misconfiguration behind a working key.

Holds live in memory. A controller restart re-probes keys that are still
exhausted and re-parks them from the same response within one call, so nothing
is lost and no key gets hammered — the station simply rediscovers the state it
already had.

## Shared with Gemini TTS

The pool is the single source of keys for both the **Gemini DJ** (the LLM leg)
and **Gemini TTS**. Keys set up in one place are used by both, so you don't
maintain two lists and they can't drift apart.

## Headless / multi-station

`GOOGLE_GENERATIVE_AI_API_KEYS` is an ordinary environment variable, so a
multi-station setup or a Docker compose override sets it without touching the
UI. Where an operator has supplied a pool, it is used in preference to a single
key.

## Removing a key

Use **Remove** next to its fingerprint. Removing the last key clears the pool
entirely, including the legacy single-key variable — otherwise the key you just
removed would quietly come back.

## When the terms note appears

The multi-key guidance and the terms-of-service warning show up only once the
pool actually holds more than one key (or the moment you start typing a second
one). A station with a single key never sees it: nobody should meet a compliance
warning for something they haven't done, and it is only actionable at the point
of adding a second key. This page and `README.md` carry it unconditionally,
because a doc can be read deliberately rather than stumbled into.
