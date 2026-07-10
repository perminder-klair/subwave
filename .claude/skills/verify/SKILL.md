---
name: verify
description: Drive a controller/admin-UI change end-to-end from a worktree without touching the live station — isolated controller on a spare port + temp STATE_DIR, worktree Next dev server, Playwright against /admin.
---

# Verifying controller + admin-UI changes in isolation

The operator's real station is usually running (docker `sub-wave-*` containers). Never restart or
point tests at it. Boot your own stack from the worktree instead:

## Isolated controller (API surface)

```bash
cd <worktree>/controller
STATE_DIR=$CLAUDE_JOB_DIR/tmp/state PORT=7791 ADMIN_USER=test ADMIN_PASS=test \
  NODE_ENV=development \
  NAVIDROME_URL=http://localhost:9999 NAVIDROME_USER=x NAVIDROME_PASS=x \
  npx tsx src/server.ts
```

- A fresh `STATE_DIR` boots clean (seeds sfx/jingles, writes `settings.json` on first save).
- The fake `NAVIDROME_*` env matters: without it `needsSetup` is true and the admin shell
  redirects every page to `/onboarding`, so UI tests never find their controls.
- Drive `/settings` etc. with `curl -u test:test http://localhost:7791/...`.
- To test load-time migrations: stop the server, hand-edit `settings.json`, restart, GET.
- Kill by port (`fuser -k 7791/tcp`) — a `pkill -f "tsx src/server.ts"` matches the Bash tool's
  own wrapper cmdline and kills your shell (exit 144).

## Worktree web dev server (UI surface)

```bash
cd <worktree>/web
NEXT_PUBLIC_API_URL=http://localhost:7791 npm run dev -- -p 7793
```

Then Playwright (headless chromium, sync API):

- Pre-seed auth before load: `ctx.add_init_script("localStorage.setItem('subwave_admin_auth', '<base64 user:pass>')")`.
- Assert state through the controller API after clicking Save, not through sonner toasts.
- Admin modals portal into `.admin-root`; scope input lookups with `[role="dialog"]`.
