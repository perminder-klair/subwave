// Station health assessment behind the admin Doctor panel. Pure data:
// runDoctor() returns a structured report, reviewReport() asks the LLM to read
// it back in plain English. No rendering here.
//
// This module owns the section roster; the checks live in ./doctor/ and are
// re-exported below. The Finding/DoctorReport shape mirrors cli/src/doctor.ts
// (same ok|warn|fail|skip vocabulary), extended with an optional `fix` the panel
// maps to an admin endpoint. Every check reuses a signal the controller already
// computes; nothing here adds probing infrastructure.

import * as settings from './settings.js';
import type { DoctorReport, DoctorSection, Finding, StationSettings } from './doctor/types.js';
import { safe } from './doctor/util.js';
import { rememberReport } from './doctor/cache.js';
import { checkBroadcast, checkLlm, checkNavidrome, checkTts } from './doctor/checks-services.js';
import { checkCapabilities, checkResources, checkTuning } from './doctor/checks-station.js';
import { checkContent, checkSetup, checkStorage } from './doctor/checks-content.js';

// Re-exported so `import * as doctor from './doctor.js'` reaches everything.
export * from './doctor/types.js';
export * from './doctor/cache.js';
export { clearNavidromeCache, navidromeConnectivity } from './doctor/checks-services.js';
export { reviewReport } from './doctor/review.js';

// The section roster, in display order. Each check degrades to a 'skip'/'fail'
// finding via `safe`, so one failing subsystem never blanks the report. Data so
// the batch runner and the streaming generator drive the same list.
const SECTION_CHECKS: Array<{ name: string; run: (s: StationSettings | null) => Promise<Finding[]> }> = [
  { name: 'LLM', run: (s) => checkLlm(s) },
  { name: 'Navidrome & library', run: () => checkNavidrome() },
  { name: 'Broadcast', run: () => checkBroadcast() },
  { name: 'Voice (TTS)', run: (s) => checkTts(s) },
  { name: 'Capabilities', run: (s) => checkCapabilities(s) },
  { name: 'Content', run: () => checkContent() },
  { name: 'Resources', run: () => checkResources() },
  { name: 'Tuning', run: (s) => checkTuning(s) },
  { name: 'Storage', run: () => checkStorage() },
  { name: 'Setup', run: () => checkSetup() },
];

function loadSettingsSafe(): StationSettings | null {
  try { return settings.get(); } catch { return null; }
}

// Yield each section as its check completes, so the streaming route can flush
// partial results instead of blocking on the whole assessment.
export async function* runDoctorSections(): AsyncGenerator<DoctorSection> {
  const s = loadSettingsSafe();
  for (const c of SECTION_CHECKS) {
    yield { name: c.name, findings: await safe(() => c.run(s)) };
  }
}

export function tallyCounts(sections: DoctorSection[]): DoctorReport['counts'] {
  const counts = { ok: 0, warn: 0, fail: 0, skip: 0 };
  for (const sec of sections) for (const f of sec.findings) counts[f.status]++;
  return counts;
}

// The single place a report is minted, so batch, stream and the nightly cron all
// cache the station's last-known health consistently.
export function finalizeReport(sections: DoctorSection[]): DoctorReport {
  const report: DoctorReport = { t: new Date().toISOString(), sections, counts: tallyCounts(sections) };
  rememberReport(report);
  return report;
}

export async function runDoctor(): Promise<DoctorReport> {
  const sections: DoctorSection[] = [];
  for await (const sec of runDoctorSections()) sections.push(sec);
  return finalizeReport(sections);
}


