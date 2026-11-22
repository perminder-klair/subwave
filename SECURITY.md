# Security Policy

## Reporting a vulnerability

If you find a security issue, please **do not open a public issue**. Instead,
report it privately:

- Email: hello@getsubwave.com
- Or use GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
  on this repository.

Please include steps to reproduce and the potential impact. You can expect an
acknowledgement within a few days.

## Scope and expectations

SUB/WAVE is a self-hosted personal radio station, typically run on a private
network (Tailscale / a homelab). A few things worth knowing:

- The admin surface (`/admin`, settings, debug) is gated by HTTP Basic auth
  (`ADMIN_USER` / `ADMIN_PASS`). In production (`NODE_ENV=production`) the
  controller **refuses to start** without these set.
- The public listener API (`/health`, `/now-playing`, `/state`, `/request`)
  is intentionally unauthenticated and CORS is open (`*`).
- Never commit credentials. Provider API keys, the Navidrome password, and
  admin credentials all belong in gitignored `.env` files — see the
  `controller/.env.example` and `web/.env.example` templates.
- If you expose the stack to the public internet, put it behind TLS (the prod
  deploy expects Cloudflare to terminate TLS in front of Caddy).
