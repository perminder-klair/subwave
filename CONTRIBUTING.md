# Contributing to SUB/WAVE

Thanks for your interest in SUB/WAVE. It's a small project — contributions,
bug reports, and ideas are all welcome.

## Community content — skills, personas, shows, stations

Community-contributed **DJ skills, personas, shows, and the public station
directory** don't live in this repo. They live in a separate content repo,
**[`getsubwave/subwave-community`](https://github.com/getsubwave/subwave-community)**,
which every running station fetches **live** — so a merged entry reaches every
station without a software release. To share a skill, persona, or show, or to add
your station to the map, open the matching no-fork issue form there. See
[`docs/community.md`](docs/community.md) for the artifact schemas and the install
flow.

The rest of this guide is for contributing **code** to this (the main) repo.

## Getting set up

See [`README.md`](README.md) for the architecture and [`DEPLOY.md`](DEPLOY.md)
for deployment. For local development:

```bash
cd docker && docker compose up -d        # Icecast + Liquidsoap + Controller
cd controller && npm install && npm run dev
cd web && npm install && npm run dev     # web UI on :7700
```

There is no test runner, linter, or formatter configured. Match the style of
the surrounding code.

## Reporting bugs

Open an issue with:

- what you expected vs. what happened,
- steps to reproduce,
- relevant logs (`docker compose logs -f controller` / `liquidsoap`).

## Pull requests

- Branch off `develop` (the integration branch) and target it in your PR — keep PRs focused on one change.
- Explain the *why*, not just the *what*, in the description.
- If you touch the queue/playback path, `radio.liq`, the crossfade, ducking, or
  the LLM layer, read the relevant note in `CLAUDE.md` first — those areas have
  non-obvious constraints that are easy to regress.
- Don't commit secrets. `.env` files are gitignored; update the `.env.example`
  files instead when you add config.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/) so
[`release-please`](https://github.com/googleapis/release-please) can maintain
the version and `CHANGELOG.md` automatically. The prefix decides the version
bump and the changelog section:

```
feat: add llama.cpp model switching       # → minor bump, "Features"
fix(ui): handle empty model list          # → patch bump, "Bug Fixes"
docs: update README install steps         # → no bump, "Documentation"
chore: bump deps                          # → no bump, hidden
feat!: rename /request payload field      # → major bump (breaking)
```

A scope in parens (`fix(ui): …`, `feat(controller): …`) is optional but helps
when skimming the changelog. Use `!` after the type, or a `BREAKING CHANGE:`
footer, for anything that breaks compatibility.

PR titles follow the same convention — squash-merging keeps history clean, and
the commit carries through `develop` → `main`, where release-please reads it.

## Releases

You don't cut releases by hand. Maintainers merge `develop` into `main` to ship;
on every push to `main`, the **Release Please**
workflow opens (or updates) a release PR that bumps `package.json` +
`CHANGELOG.md` based on the Conventional Commits since the last tag. Merging
that PR creates a `vX.Y.Z` tag and a GitHub Release, which triggers
`publish-images.yml` to build and push the Docker images to GHCR.

## Code of conduct

Be respectful and constructive. Harassment or abuse of any kind isn't welcome
here. Maintainers may remove comments, commits, or contributors that don't
follow this.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE) that covers this project.
