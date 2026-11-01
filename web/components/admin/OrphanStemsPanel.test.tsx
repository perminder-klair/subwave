import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ORPHAN_CARD_SUB,
  OrphanReportView,
  PassResult,
  pendingWork,
  runDialog,
  runLabel,
  type OrphanReport,
} from './OrphanStemsPanel';

const dry = (over: Partial<OrphanReport> = {}): OrphanReport => ({
  dryRun: true, keptCount: 10, quarantined: 0, quarantinedNames: [], released: [], deletedCount: 0,
  deletedNames: [], agingCount: 0, supersededCount: 0, inFlight: 0, failed: 0, freedBytes: 0, ...over,
});
const pass = (over: Partial<OrphanReport> = {}) => dry({ dryRun: false, ...over });

function view(report: OrphanReport, over: Partial<Parameters<typeof OrphanReportView>[0]> = {}) {
  const noop = () => {};
  return renderToStaticMarkup(createElement(OrphanReportView, {
    report, enabled: false, lastPass: null, busy: false, scanning: false, showTracks: false,
    onToggleTracks: noop, onRun: noop, onRescan: noop, onToggleDaily: noop, ...over,
  }));
}

// The attribute, not the word: the button's classes carry `disabled:` variants.
const DISABLED = /\sdisabled=""/;

/** The run button's markup: the one whose label names the pass. */
function runButton(html: string, label: string): string {
  const at = html.indexOf(`>${label}<`);
  assert.notEqual(at, -1, `no button labelled "${label}" in ${html}`);
  return html.slice(html.lastIndexOf('<button', at), at);
}

test('with only aged quarantines the run button stays live: the daily pass may be off', () => {
  const report = dry({ deletedCount: 2 });
  assert.equal(pendingWork(report), 2);
  assert.doesNotMatch(runButton(view(report), 'Delete 2'), DISABLED);
});

test('with only a returned track the run button stays live', () => {
  assert.doesNotMatch(runButton(view(dry({ released: ['a'] })), 'Release 1'), DISABLED);
});

test('with nothing due the run button is off, and says so', () => {
  assert.match(runButton(view(dry()), 'Nothing to do'), DISABLED);
});

test('a mixed pass names everything it will do', () => {
  assert.equal(runLabel(dry({ quarantined: 3, released: ['a'], deletedCount: 2 })), 'Move 3, release 1, delete 2');
  assert.equal(runLabel(dry({ quarantined: 3 })), 'Move 3 to quarantine');
});

test('a dry run never reports a delete or a release as done', () => {
  const html = view(dry({ deletedCount: 2, released: ['a'], freedBytes: 0 }));
  assert.doesNotMatch(html, /Deleted/);
  assert.doesNotMatch(html, /Released/);
  assert.doesNotMatch(html, /freed/);
  assert.match(html, /past the week, ready to delete/);
  assert.match(html, /back in the library, ready to release/);
});

test('the footer says what happens with the daily pass off', () => {
  assert.match(view(dry()), /With the daily pass off, nothing ages out or comes back on its own/);
});

test('the dialog promises the next pass, not a date', () => {
  const { description, title, confirmLabel } = runDialog(dry({ quarantined: 3 }));
  assert.match(description, /gets its folder back on the next pass/);
  assert.match(description, /the next pass is this button/);
  assert.equal(title, 'Move orphan stems to the quarantine');
  assert.equal(confirmLabel, 'move to quarantine');
});

test('the dialog names deletes and releases when the pass has them', () => {
  const { description, title } = runDialog(dry({ released: ['a'], deletedCount: 2 }));
  assert.match(description, /1 quarantined folder whose track is back return to the cache/);
  assert.match(description, /2 quarantined folders past the week are deleted for good/);
  assert.equal(title, 'Run the orphan stems cleanup');
});

test('the card does not promise a release saves the separation', () => {
  assert.doesNotMatch(ORPHAN_CARD_SUB, /not re-separated/);
  assert.match(ORPHAN_CARD_SUB, /first analysis as a new track still runs Demucs/);
});

test('a confirmed pass shows what it really did', () => {
  const html = renderToStaticMarkup(createElement(PassResult, {
    report: pass({ quarantined: 3, released: ['a'], deletedCount: 2, freedBytes: 5 * 1024 * 1024 }),
  }));
  assert.match(html, /moved 3 to quarantine, released 1, deleted 2 \(5 MB freed\)/);
});

test('failures from a confirmed pass reach the card', () => {
  const html = view(dry({ quarantined: 4 }), { lastPass: pass({ failed: 4 }) });
  assert.match(html, />4<\/strong> failed — check ownership/);
  assert.match(html, /nothing moved/);
});

test('a pass refused by another pass says so', () => {
  const html = view(dry({ quarantined: 4 }), {
    lastPass: pass({ refused: true, reason: 'another purge pass is running' }),
  });
  assert.match(html, /Another purge pass is running/);
});

test('the ceiling the daily pass stops at shows on the page, while the operator can still confirm', () => {
  const report = dry({ quarantined: 500, autoRefusal: 'would quarantine 500 of 600 stem dirs, more than an automatic pass moves on its own' });
  const html = view(report, { enabled: true });
  assert.match(html, /Would quarantine 500 of 600 stem dirs/);
  assert.doesNotMatch(runButton(html, 'Move 500 to quarantine'), DISABLED);
});

test('with the daily pass off there is no daily pass to hold', () => {
  assert.doesNotMatch(view(dry({ autoRefusal: 'would quarantine 500 of 600 stem dirs' })), /Would quarantine/);
});

test('a refused report keeps the toggle and Re-scan: the pass must stay reachable', () => {
  const html = view(dry({ refused: true, reason: 'offline', offline: 'the share is not mounted' }), { enabled: true });
  assert.match(html, /the share is not mounted/);
  assert.match(html, /Daily pass on/);
  assert.match(html, />Re-scan</);
});

// The audit needs each read written inside its useAdminQuery, so a read cannot
// be called alone here, and adminJson's own tests pin that a 500 is an error.
// This pins the other half: both reads use it, not a bare r.json(), which cached
// the controller's { error } as if it were the report.
test('both orphan reads go through adminJson', () => {
  const source = readFileSync(new URL('./OrphanStemsPanel.tsx', import.meta.url), 'utf8');
  assert.match(source, /adminJson<OrphanState>\(fetcher, '\/stems\/orphans', undefined, signal\)/);
  assert.match(source, /adminJson<OrphanTracks>\(fetcher, '\/stems\/orphans\/tracks', undefined, signal\)/);
  assert.doesNotMatch(source, /\.json\(\)/);
});
