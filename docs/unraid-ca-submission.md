# Submitting SUB/WAVE to Unraid Community Applications

Maintainer runbook. The CA submission files live at the **root of this repo** —
`ca_profile.xml` + `templates/subwave.xml` — so the app and its store listing
stay versioned together. The runnable artifact is the `subwave-aio` image
(`docker/Dockerfile.aio`), published from this same repo.

## What the scanner reads

```
subwave/
├── ca_profile.xml          # maintainer profile (overview, icon, web page)
├── LICENSE                 # MIT (already here)
├── README.md               # used as the listing's "readme first"
└── templates/subwave.xml   # the single Container v2 template (one image)
```

Icon + screenshots are referenced by raw URL from existing in-repo assets
(`app/assets/icon.png`, `web/public/screenshots/*.webp`) — nothing duplicated.

## 1. Publish the `subwave-aio` image

Built by `.github/workflows/publish-images.yml` (matrix entry `subwave-aio`,
amd64-only — that's x86-64, every Unraid box; arm64 is skipped because the
bundled Next.js webbuild fails its arm64 cross-build under QEMU on
lightningcss). It publishes on a `v*` tag push:

```bash
git tag v<next-version> && git push origin v<next-version>
```

Then confirm `ghcr.io/perminder-klair/subwave-aio:latest` exists and is
**public** (GHCR → package → Package settings → Change visibility → Public). CA
pulls it anonymously, so a private package fails install.

> Ad-hoc rebuild without a release: run the **Publish images** workflow via
> *workflow_dispatch* — it rebuilds every image (including `subwave-aio`) from
> the chosen ref.

## 2. Smoke-test the image (before submitting)

CA moderation expects a working app. Locally:

```bash
docker run -d --name subwave-aio-test -p 7790:80 \
  -e ADMIN_USER=admin -e ADMIN_PASS=test123 -e SITE_URL=http://localhost:7790 \
  -v /tmp/subwave-aio-state:/var/sub-wave \
  ghcr.io/perminder-klair/subwave-aio:latest

curl -fsS http://localhost:7790/api/health                                   # {"status":"on-air"}
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:7790/onboarding    # 200
curl -s --max-time 4 -w 'type=%{content_type}\n' http://localhost:7790/stream.mp3  # audio/mpeg
docker rm -f subwave-aio-test
```

Better still: install it on a real Unraid box first via **Add Container →
Template URL** →
`https://raw.githubusercontent.com/perminder-klair/subwave/main/templates/subwave.xml`,
then finish `/onboarding` against a real Navidrome.

## 3. Submit at ca.unraid.net

1. Go to <https://ca.unraid.net/submit> and sign in with GitHub.
2. Point it at `perminder-klair/subwave`.
3. Run **Validate** and **Scan** — fix anything flagged, push, re-scan.
4. **Preview** the listing, then **Submit**. A moderator reviews before it
   appears in the Apps tab.

> The scanner crawls the whole repo. If it ever mis-detects unrelated XML (it
> keys off `<Container>` files under `templates/`, so it shouldn't), the
> fallback is to split these files into a small dedicated `subwave-unraid` repo
> and submit that instead — same files, different home.

## Updating later

- **App behaviour / image:** change the repo, cut a new `v*` tag → CA's normal
  "Check for Updates" picks up the new `:latest` digest.
- **Listing metadata** (description, screenshots, port defaults): edit
  `ca_profile.xml` / `templates/subwave.xml`, push, re-run Validate/Scan. Bump
  `<Date>` and add a `<Changes>` note in the template.
