import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  CONFIRM_BYTES, CONFIRM_TRACKS, LIBRARY_DOWNLOAD_LIST_MAX, browseFilterParams, browseNarrowed, confirmText,
  downloadLabel, fmtBytes, listBody, listOffer, listTitle, needsConfirm, selectionBody, selectionTitle, sizeText,
  type BrowseFilterState,
} from './download-policy';
import { DownloadControl, ListDownloadView } from './DownloadButton';
import { AddToPlaylistBar } from './AddToPlaylistBar';
import { historyPageTracks } from './history-selection';
import type { PlayEntry } from './types';

const HERE = dirname(fileURLToPath(import.meta.url));
const NONE: BrowseFilterState = {
  moods: [], energy: 'any', vocal: 'any', genre: '', yearFrom: '', yearTo: '', q: '', sort: 'artist',
};
const browse = (f: Partial<BrowseFilterState> = {}) => ({ kind: 'browse' as const, filter: { ...NONE, ...f } });

test('the label counts the tracks a press takes; pending relabels it', () => {
  assert.equal(downloadLabel(1, false), 'Download 1 track');
  assert.equal(downloadLabel(248, false), 'Download 248 tracks');
  assert.equal(downloadLabel(12345, false), 'Download 12,345 tracks');
  assert.equal(downloadLabel(null, false), 'Download');
  assert.equal(downloadLabel(0, false), 'Download');
  assert.equal(downloadLabel(248, true), 'Preparing…');
});

test('ticked rows go as ids; a list sends its own filter or the Liked sort, paging aside', () => {
  assert.deepEqual(selectionBody(['b', 'a']), { ids: ['b', 'a'] });
  const f: BrowseFilterState = {
    moods: ['calm', 'dreamy'], energy: 'low', vocal: 'instrumental', genre: 'Jazz',
    yearFrom: '1990', yearTo: '1999', q: ' artist:Ane ', sort: 'title',
  };
  assert.deepEqual(listBody({ kind: 'browse', filter: f }), {
    filter: {
      moods: 'calm,dreamy', energy: 'low', vocal: 'instrumental', genre: 'Jazz',
      yearFrom: '1990', yearTo: '1999', q: 'artist:Ane', sort: 'title',
    },
  });
  // The list's own request is built from the same parameters, in its old order.
  assert.equal(new URLSearchParams(browseFilterParams(f)).toString(),
    'moods=calm%2Cdreamy&energy=low&vocal=instrumental&genre=Jazz&yearFrom=1990&yearTo=1999&q=artist%3AAne&sort=title');
  assert.deepEqual(browseFilterParams(NONE), { sort: 'artist' });
  assert.deepEqual(listBody({ kind: 'liked', sort: 'count' }), { liked: { sort: 'count' } });
});

test('a Browse list is narrowed by any search or filter, never by its sort alone', () => {
  assert.equal(browseNarrowed(NONE), false);
  assert.equal(browseNarrowed({ ...NONE, sort: 'year' }), false);
  assert.equal(browseNarrowed({ ...NONE, q: '   ' }), false);
  for (const f of [{ moods: ['calm'] }, { energy: 'low' }, { vocal: 'vocal' }, { genre: 'Jazz' },
    { yearFrom: '1990' }, { yearTo: '1999' }, { q: 'artist:Ane' }] as Partial<BrowseFilterState>[]) {
    assert.equal(browseNarrowed({ ...NONE, ...f }), true, JSON.stringify(f));
  }
});

test('the list button: only for a narrowed Browse list or Liked, and only up to the server\'s cap', () => {
  // The controller's own number, through the schema mirror.
  assert.equal(LIBRARY_DOWNLOAD_LIST_MAX, 2_000);
  // Unfiltered Browse is the whole library: a hint, whatever its size.
  assert.deepEqual(listOffer(browse(), 75_000), { kind: 'hint', text: 'Filter the list or tick tracks to download' });
  assert.deepEqual(listOffer(browse({ sort: 'year' }), 12), { kind: 'hint', text: 'Filter the list or tick tracks to download' });
  assert.deepEqual(listOffer(browse({ moods: ['calm'] }), 120), { kind: 'button', count: 120 });
  assert.deepEqual(listOffer(browse({ q: 'x' }), 2_000), { kind: 'button', count: 2_000 });
  assert.deepEqual(listOffer(browse({ q: 'x' }), 2_001),
    { kind: 'hint', text: 'Narrow the list to 2,000 tracks or fewer to download it' });
  // Not answered yet, or empty: nothing to offer.
  assert.deepEqual(listOffer(browse({ q: 'x' }), null), { kind: 'none' });
  assert.deepEqual(listOffer(browse({ q: 'x' }), 0), { kind: 'none' });
  // Liked: always a list of its own, capped the same.
  assert.deepEqual(listOffer({ kind: 'liked', sort: 'recent' }, 57), { kind: 'button', count: 57 });
  assert.deepEqual(listOffer({ kind: 'liked', sort: 'recent' }, 2_001),
    { kind: 'hint', text: 'Over 2,000 liked tracks: tick tracks to download' });
  assert.deepEqual(listOffer({ kind: 'liked', sort: 'recent' }, 0), { kind: 'none' });
  assert.deepEqual(listOffer({ kind: 'liked', sort: 'recent' }, 10, 5), { kind: 'hint', text: 'Over 5 liked tracks: tick tracks to download' });
  assert.equal(listTitle('liked'), 'Download every liked track, all pages (several come as one zip)');
  assert.equal(listTitle('browse'), 'Download every track in this list, all pages (several come as one zip)');
  assert.equal(selectionTitle(1), 'Download the 1 ticked track (several come as one zip)');
});

test('a big download asks first: over 50 tracks or over 2 GB', () => {
  assert.equal(CONFIRM_TRACKS, 50);
  assert.equal(needsConfirm({ count: 50, bytes: 0 }), false);
  assert.equal(needsConfirm({ count: 51, bytes: 0 }), true);
  assert.equal(needsConfirm({ count: 2, bytes: CONFIRM_BYTES }), false);
  assert.equal(needsConfirm({ count: 2, bytes: CONFIRM_BYTES + 1 }), true);
});

test('the confirm states the count, the estimated size and the form', () => {
  assert.equal(fmtBytes(6.54 * 1024 ** 3), '6.5 GB');
  assert.equal(fmtBytes(40 * 1024 ** 2), '40 MB');
  assert.equal(sizeText({ count: 3, bytes: 0, unsized: 3 }), 'size unknown');
  assert.equal(sizeText({ count: 3, bytes: 3 * 1024 ** 3, unsized: 1 }), 'about 3.0 GB, plus 1 track of unknown size');
  assert.equal(
    confirmText({ path: '/x', count: 248, bytes: 6.1 * 1024 ** 3, unsized: 0, name: 'library-248-tracks-2026-11-23.zip', single: false }),
    '248 tracks, about 6.1 GB, as one zip (library-248-tracks-2026-11-23.zip). '
      + 'Your browser saves it as it arrives; the tracks come from the music server one at a time.',
  );
});

const control = (props: Parameters<typeof DownloadControl>[0]) => renderToStaticMarkup(createElement(DownloadControl, props));
const view = (props: Parameters<typeof ListDownloadView>[0]) => renderToStaticMarkup(createElement(ListDownloadView, props));
const btnClass = (html: string, label: string) => {
  const m = new RegExp(`<button[^>]*class="([^"]*)"[^>]*>(?:(?!</button>).)*${label}`).exec(html);
  assert.ok(m, `no button reading ${label} in ${html}`);
  return m[1];
};

test('one look everywhere: a small bordered button, never the accent; disabled and relabelled while pending', () => {
  const idle = control({ count: 248, pending: false, onClick: () => {}, title: 't' });
  assert.match(idle, /> Download 248 tracks<\/button>/);
  assert.match(idle, /border-ink/);
  assert.doesNotMatch(idle, /accent/);
  assert.doesNotMatch(idle, /disabled=""/);
  assert.match(idle, /title="t"/);
  const pending = control({ count: 248, pending: true, onClick: () => {}, title: 't' });
  assert.match(pending, /> Preparing…<\/button>/);
  assert.match(pending, /disabled=""/);
  assert.match(control({ count: null, pending: false, onClick: () => {}, title: 't' }), /disabled=""/);
});

test('a list header shows the button, or its muted hint, or nothing', () => {
  const btn = view({ offer: { kind: 'button', count: 57 }, kind: 'liked', pending: false, onClick: () => {} });
  assert.match(btn, /> Download 57 tracks<\/button>/);
  assert.match(btn, /title="Download every liked track, all pages/);
  // The same element as the selection bar's: one component, one class list.
  assert.equal(btnClass(btn, 'Download 57 tracks'),
    btnClass(control({ count: 57, pending: false, onClick: () => {}, title: 'x' }), 'Download 57 tracks'));
  const hint = view({ offer: { kind: 'hint', text: 'Filter the list or tick tracks to download' }, kind: 'browse', pending: false, onClick: () => {} });
  assert.doesNotMatch(hint, /<button/);
  assert.match(hint, /text-muted[^>]*>Filter the list or tick tracks to download</);
  assert.equal(view({ offer: { kind: 'none' }, kind: 'browse', pending: false, onClick: () => {} }), '');
});

test('the selection bar carries the download beside its own buttons, in their size and border', () => {
  const html = renderToStaticMarkup(createElement(AddToPlaylistBar, {
    count: 2, playlists: [], busy: false, onAdd: () => {}, onClear: () => {},
    download: createElement(DownloadControl, { count: 2, pending: false, onClick: () => {}, title: selectionTitle(2) }),
  }));
  assert.match(html, /2 tracks selected/);
  const order = ['Create playlist', 'Download 2 tracks', 'Clear selection'].map(l => html.indexOf(l));
  const [add, dl, clear] = order as [number, number, number];
  assert.ok(add > 0 && add < dl && dl < clear, String(order));
  // Exactly the secondary sibling's look (Clear selection); the accent stays the bar's primary action's.
  assert.equal(btnClass(html, 'Download 2 tracks'), btnClass(html, 'Clear selection'));
  // Without a download slot, the bar is as before.
  const bare = renderToStaticMarkup(createElement(AddToPlaylistBar, {
    count: 1, playlists: [], busy: false, onAdd: () => {}, onClear: () => {},
  }));
  assert.doesNotMatch(bare, /Download/);
});

test('both list headers use the one shared component; ticked rows download from the shared bar only', () => {
  const src = (p: string) => readFileSync(join(HERE, p), 'utf8');
  for (const tab of ['tabs/BrowseTab.tsx', 'tabs/TracksTab.tsx']) {
    const s = src(tab);
    assert.match(s, /import \{ ListDownload \} from '\.\.\/DownloadButton';/, tab);
    assert.match(s, /<ListDownload\b/, tab);
    assert.doesNotMatch(s, /SelectionDownload|selected\b/, tab);
  }
  assert.match(src('../LibraryPanel.tsx'), /download=\{<SelectionDownload ids=\{/);
  assert.doesNotMatch(src('BrowseFilters.tsx'), /actions/);
});

test('the selection bar sits directly above the list it acts on, on every tab that ticks rows', () => {
  const src = (p: string) => readFileSync(join(HERE, p), 'utf8');
  const panel = src('../LibraryPanel.tsx');
  // Built once in the panel, handed to each tab; never placed at a fixed spot in the shell.
  assert.equal((panel.match(/<AddToPlaylistBar\b/g) || []).length, 1);
  for (const tab of ['BrowseTab', 'SearchTab', 'HistoryTabContainer']) {
    assert.match(panel, new RegExp(`<${tab}[\\s\\S]*?selectionBar=\\{selectionBar\\}`), tab);
  }
  assert.match(panel, /\{tab === 'tracks' && selectionBar\}\s*\{tab === 'tracks' && \(/);
  // In each tab: after its filters or search box, right before its list card.
  for (const [file, card] of [['tabs/BrowseTab.tsx', 'title="Tracks"'], ['tabs/SearchTab.tsx', 'title="Search results"'], ['HistoryTab.tsx', 'title="Play history"']] as const) {
    const s = src(file);
    assert.match(s, new RegExp(`\\{selectionBar\\}\\s*<Card\\s+${card}`), file);
  }
});

test('History ticks plays by track: a track aired twice is one track, a play with no track id has none', () => {
  const play = (id: number, trackId: string | null, title: string): PlayEntry => ({
    id, trackId, title, artist: 'Artist', album: 'Album', playedAt: `2026-11-24T20:0${id}:00Z`,
    source: 'ai', requestedBy: null, showId: null, showName: null,
  });
  const rows = [play(1, 'a', 'Twice'), play(2, 'b', 'Once'), play(3, 'a', 'Twice'), play(4, null, 'Station ident')];
  assert.deepEqual(historyPageTracks(rows, p => `${p.trackId}:${p.id}`), ['a:1', 'b:2']);
  assert.deepEqual(historyPageTracks(null, p => p.id), []);
  // Each row's box is keyed by its track id, so both plays of a track tick
  // together; an id-less play gets a spacer instead of a box.
  const s = readFileSync(join(HERE, 'HistoryTab.tsx'), 'utf8');
  assert.match(s, /\{p\.trackId \? \([\s\S]*?checked=\{selected\.has\(p\.trackId\)\}[\s\S]*?\) : \([\s\S]*?aria-hidden/);
  assert.match(s, /onChange=\{\(\) => onToggleAll\(pageTracks\)\}/);
});
