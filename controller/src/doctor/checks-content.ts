// Checks over what's actually on disk: the jingle/playlist M3Us, the state
// directory's size, and whether first-run setup ever completed.
//
// Part of the doctor/ split - see ../doctor.ts for the section runner.

import { readFile } from 'node:fs/promises';
import { STATE_DIR } from '../config.js';
import * as settings from '../settings.js';
import { getSetupStatus } from '../setup/firstRun.js';
import type { Finding, FixAction } from './types.js';
import { dirSize, fmtBytes } from './util.js';

export async function checkContent(): Promise<Finding[]> {
  const out: Finding[] = [];

  // auto.m3u — the fallback playlist Liquidsoap plays when the queue is empty.
  const autoPath = `${STATE_DIR}/auto.m3u`;
  out.push(await m3uFinding(autoPath, {
    label: 'fallback playlist',
    emptyHint: 'The autonomous fallback has nothing to play. Refresh it for the current mood.',
    fix: { id: 'refresh-playlist', label: 'Refresh playlist' },
  }));

  // jingles.m3u — station idents.
  out.push(await m3uFinding(`${STATE_DIR}/jingles.m3u`, {
    label: 'jingles',
    emptyHint: 'No station idents yet. Generate the defaults to get jingles between tracks.',
    fix: { id: 'generate-jingles', label: 'Generate jingles' },
  }));

  return out;
}

// Shared helper: report an M3U as ok (N entries) / warn (empty or missing).
async function m3uFinding(
  path: string,
  opts: { label: string; emptyHint: string; fix: FixAction },
): Promise<Finding> {
  try {
    const body = await readFile(path, 'utf8');
    const lines = body.split('\n').filter((l) => l.trim() && !l.startsWith('#'));
    if (lines.length === 0) {
      return { label: opts.label, status: 'warn', detail: 'empty', hint: opts.emptyHint, fix: opts.fix };
    }
    return { label: opts.label, status: 'ok', detail: `${lines.length} entries` };
  } catch {
    return { label: opts.label, status: 'warn', detail: 'missing', hint: opts.emptyHint, fix: opts.fix };
  }
}

export async function checkStorage(): Promise<Finding[]> {
  const out: Finding[] = [];

  const archive = await dirSize(`${STATE_DIR}/archive`);
  const GB = 1024 * 1024 * 1024;
  out.push({
    label: 'hourly archive',
    status: archive.bytes > 20 * GB ? 'warn' : 'ok',
    detail: `${fmtBytes(archive.bytes)} across ${archive.files} files`,
    hint:
      archive.bytes > 20 * GB
        ? 'The hourly archive is large. Prune old day folders under state/archive if disk is tight.'
        : undefined,
  });

  const logs = await dirSize(`${STATE_DIR}/logs`);
  out.push({
    label: 'logs',
    status: 'ok',
    detail: `${fmtBytes(logs.bytes)} across ${logs.files} files`,
  });

  return out;
}

export async function checkSetup(): Promise<Finding[]> {
  const out: Finding[] = [];

  try {
    const st = await getSetupStatus();
    out.push({
      label: 'configuration',
      status: st.needsSetup ? 'fail' : 'ok',
      detail: st.needsSetup ? 'incomplete — no music source configured' : `complete (${st.musicMode === 'router' ? 'music router' : st.navidromeSource})`,
      hint: st.needsSetup ? 'Finish the wizard at /onboarding (or run `subwave setup`).' : undefined,
    });
  } catch (err) {
    out.push({ label: 'configuration', status: 'skip', detail: err?.message || 'unknown' });
  }

  // settings.get() throws if settings never loaded — surface that explicitly.
  try {
    settings.get();
    out.push({ label: 'settings', status: 'ok', detail: 'loaded' });
  } catch (err) {
    out.push({ label: 'settings', status: 'fail', detail: err?.message || 'not loaded' });
  }

  // Gentle backup reminder — there's no signal to fail on, just good hygiene.
  out.push({
    label: 'backups',
    status: 'skip',
    detail: 'on demand',
    hint: 'Export a backup from Admin → Backup so settings, personas, custom skills and library tags can be restored — especially before re-tagging or switching providers.',
  });

  return out;
}


