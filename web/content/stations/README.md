# Add your station to the directory

This folder powers the public **[/stations](https://getsubwave.com/stations)**
directory — a map and listing of SUB/WAVE installations around the world. Each
station is **one JSON file** in this directory.

## How to submit (the easy way — no fork)

Hit **"Add your station"** on the [`/stations`](https://getsubwave.com/stations)
page (or open the [station form](https://github.com/perminder-klair/subwave/issues/new?template=add-station.yml)
directly). Fill in the fields and submit — that's it. A bot turns your issue into
a one-file pull request, and a maintainer reviews and merges it. **You don't need
to fork the repo or write any JSON.** Your station appears on the map on the next
deploy. Edit the issue later and the PR updates itself automatically.

## How to submit (by hand)

Prefer to open the pull request yourself?

1. **Fork** the repo.
2. Add a file at `web/content/stations/<your-slug>.json` — the filename (minus
   `.json`) becomes the station's slug, so keep it short and kebab-case, e.g.
   `night-owl-radio.json`.
3. Fill in the fields below and **open a pull request against `develop`**. A
   maintainer reviews and merges it; your station then shows up on the next
   deploy. (PRs to `main` are blocked by CI — `main` is the release branch and
   only takes `develop`.)

One file per station keeps pull requests from colliding and makes each entry
trivial to review or revert.

## The fields

| Field         | Required | Notes |
|---------------|:--------:|-------|
| `name`        | **yes**  | Display name of your station. |
| `url`         | **yes**  | Public origin, e.g. `https://radio.example.com`. The directory probes `‹url›/api/now-playing` in the listener's browser to show an **ON AIR** badge + the current track, so this must be reachable and CORS-open (the SUB/WAVE controller is by default). |
| `location`    | no       | Free-text "City, Country". |
| `country`     | no       | Used for the "N countries" tally. Falls back to `location` if omitted. |
| `operator`    | no       | Your name or `@handle`. |
| `genre`       | no       | A short vibe label, e.g. `ambient / downtempo`. |
| `description` | no       | One or two sentences. |
| `lat`, `lon`  | no       | Decimal degrees. Provide **both** to get a dot on the world map. Omit and your station still lists, just not plotted. |
| `featured`    | no       | `true` floats you to the top. Reserved for editorial picks — leave `false`. |
| `submitted`   | no       | ISO date `yyyy-mm-dd` you added it. |

## Template

Copy this, drop the comments, fill it in:

```json
{
  "name": "Night Owl Radio",
  "url": "https://radio.example.com",
  "operator": "@yourhandle",
  "location": "Berlin, Germany",
  "country": "Germany",
  "lat": 52.52,
  "lon": 13.405,
  "genre": "ambient / downtempo",
  "description": "Late-night ambient for people who keep odd hours.",
  "featured": false,
  "submitted": "2026-06-04"
}
```

Finding your coordinates: search your city on any maps site and copy the
latitude / longitude. Two or three decimal places is plenty.
