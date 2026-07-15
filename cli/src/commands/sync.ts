// `subwave sync` — re-materialise the embedded compose files + .env.example
// into the install dir, so a stack scaffolded before a service was added picks
// it up (the #1043 fix). `init` writes these files once and nothing else
// rewrites them; this is the explicit "refresh them now" action that the drift
// warnings in `update` / `doctor` point at. It backs up anything it changes.
//
// `--check` is a dry-run: report drift, write nothing, exit non-zero if the
// files are behind — usable from a script / CI probe.

import { requireSubwaveHome, isCloneMode } from '../home.ts';
import {
  resolveInstallMode,
  detectDrift,
  hasDrift,
  syncFiles,
  type DriftEntry,
} from '../compose-sync.ts';
import { banner, header, ok, warn, info, muted, pc, pauseForEnter } from '../ui.ts';

export interface SyncOptions {
  check?: boolean; // dry-run: report drift, write nothing, non-zero exit if drifted
}

export async function runSyncCommand(opts: SyncOptions = {}): Promise<void> {
  banner('sync');

  const { home } = requireSubwaveHome();

  // Clone installs get their compose from the repo — nothing for the CLI to
  // materialise. Point at git and stop.
  if (isCloneMode(home)) {
    header('Clone install');
    info('This is a git clone — its compose files come from the repo, not the CLI.');
    muted('→ `git pull` to refresh them.');
    await pauseForEnter();
    return;
  }

  const mode = resolveInstallMode(home);
  if (!mode) {
    warn(`couldn't determine the deployment shape at ${home}.`);
    muted('→ fresh install? run `subwave init`. Otherwise pick a shape with `subwave start prod|prod-byo`.');
    await pauseForEnter();
    return;
  }

  const drift = detectDrift(home, mode);
  info(`install: ${home}   shape: ${mode}`);
  console.log();

  if (!hasDrift(drift)) {
    ok('compose files are up to date — nothing to sync.');
    if (opts.check) return;
    await pauseForEnter();
    return;
  }

  const behind = drift.filter((e) => e.status !== 'fresh');
  header(opts.check ? 'Drift detected (check only)' : 'Refreshing compose files');
  for (const e of behind) reportDrift(e);
  console.log();

  // Dry-run: report + non-zero exit for scripting, no writes, no pause.
  if (opts.check) {
    muted('→ run `subwave sync` to refresh them (backs up any changed file first).');
    process.exit(1);
  }

  const results = syncFiles(home, mode);
  for (const r of results) {
    if (r.action === 'unchanged') continue;
    const b = r.backup ? pc.dim(` (backup: ${r.backup})`) : '';
    ok(`${r.action} ${r.name}${b}`);
  }
  console.log();
  muted('→ apply the changes: `subwave restart`  (or `subwave update` to also pull new images).');
  await pauseForEnter();
}

function reportDrift(e: DriftEntry): void {
  warn(`${e.name} — ${e.status === 'missing' ? 'missing (will be created)' : 'behind this CLI'}`);
}
