// Pure show helpers: hydration and the payload / table-row projections.
// Validation lives in ShowsPanel/ShowEditor via the shared schema; what stays
// here is what the schema does not express — tolerance for a half-finished show
// and showPayload's "only means something with" conditionals.

import type { ShowFacet, ShowRow } from './ShowsTable';
import { SHOW_COLORS } from '../schedule/lib';
import { eraLabelOf } from './types';
import type { Persona, Schedule, Show } from './types';
import {
  migrateLegacyShowFields,
  type ShowSchemaContext,
} from '@/lib/schemas.generated';


export function clientMintId() {
  const b = crypto.getRandomValues(new Uint8Array(3));
  return 's_' + [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}

// Fill in a show the editor can hold. Not a schema parse: a fresh show has no
// name or host and would be rejected. The legacy singular → plural coercion
// (#929) still comes from the schema so browser and controller agree.
export function hydrateShow(s: Partial<Show>): Show {
  const m = migrateLegacyShowFields(s) as Partial<Show>;
  return {
    id: m.id ?? clientMintId(),
    name: m.name ?? '',
    topic: m.topic ?? '',
    personaId: m.personaId ?? '',
    guestPersonaIds: Array.isArray(m.guestPersonaIds) ? m.guestPersonaIds : [],
    banter: m.banter ?? false,
    moods: Array.isArray(m.moods) ? m.moods : [],
    themeId: m.themeId ?? '',
    genres: Array.isArray(m.genres) ? m.genres.map(g => String(g).trim()).filter(Boolean) : [],
    eras: Array.isArray(m.eras) ? m.eras : [],
    energies: Array.isArray(m.energies) ? m.energies : [],
    // Unrecognised reads as no constraint, matching the schema's vocals field.
    vocals: m.vocals === 'instrumental' || m.vocals === 'vocal' ? m.vocals : '',
    filtersStrict: m.filtersStrict ?? false,
    maxTrackSeconds: m.maxTrackSeconds ?? null,
    minTrackLengthSeconds: m.minTrackLengthSeconds ?? null,
    // Tri-state: only an explicit boolean is an opinion; anything else inherits.
    fadeAtShowEnd: typeof m.fadeAtShowEnd === 'boolean' ? m.fadeAtShowEnd : null,
    playlistIds: Array.isArray(m.playlistIds) ? m.playlistIds : [],
    playlistStrict: m.playlistStrict ?? false,
    playlistExhaust: m.playlistExhaust ?? false,
    excludedPlaylistIds: Array.isArray(m.excludedPlaylistIds) ? m.excludedPlaylistIds : [],
    programme: m.programme ?? false,
    segmentSkill: m.segmentSkill ?? '',
    tags: Array.isArray(m.tags) ? m.tags.map(t => String(t).trim().toLowerCase()).filter(Boolean) : [],
  };
}

export function emptyWeek(): Schedule {
  const w: Schedule = {};
  for (let d = 0; d < 7; d++) w[d] = Array(24).fill(null);
  return w;
}

export function abbrev(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return words.slice(0, 2).map(w => w[0]).join('').toUpperCase();
  return name.trim().slice(0, 2).toUpperCase();
}

/**
 * The show schema's context. Unlike the controller's load path the panel holds
 * the live roster, moods and themes, so every field is a real check.
 */
export function showContext(opts: {
  personas: Persona[];
  moods: string[];
  themeIds: string[];
  minTrackSeconds: number | null;
}): ShowSchemaContext {
  return {
    personaIds: opts.personas.map(p => p.id),
    moodNames: opts.moods,
    themeIds: opts.themeIds,
    minTrackSeconds: opts.minTrackSeconds,
  };
}

// The Strict toggle only means something with a filter for it to harden.
export function hasAnyMusicFilter(s: Show): boolean {
  return !!(s.moods.length || s.genres.length || s.energies.length || s.eras.length || s.vocals);
}

// Trimmed, with the "only-means-something-with" conditionals the server also
// enforces. Shared by Save show (POST /shows) and the community install path.
export function showPayload(s: Show) {
  return {
    id: s.id,
    name: s.name.trim(),
    topic: s.topic.trim(),
    personaId: s.personaId,
    // Host can be switched after guests were picked; the server rejects a
    // guest duplicating the host, so filter it here too.
    guestPersonaIds: (s.guestPersonaIds || []).filter(id => id !== s.personaId),
    // Banter only means something with guests in the studio.
    banter: (s.guestPersonaIds?.length ?? 0) > 0 && s.banter,
    moods: s.moods,
    themeId: s.themeId || '',
    genres: s.genres.map(g => g.trim()).filter(Boolean),
    eras: s.eras,
    energies: s.energies,
    vocals: s.vocals || '',
    // Strict only means something with at least one music filter set.
    filtersStrict: hasAnyMusicFilter(s) && s.filtersStrict,
    maxTrackSeconds: s.maxTrackSeconds,
    minTrackLengthSeconds: s.minTrackLengthSeconds,
    // null rides through as null: "inherit", not "off".
    fadeAtShowEnd: typeof s.fadeAtShowEnd === 'boolean' ? s.fadeAtShowEnd : null,
    playlistIds: s.playlistIds || [],
    // Strict only means something with at least one playlist pinned.
    playlistStrict: (s.playlistIds?.length ?? 0) > 0 && s.playlistStrict,
    // Full rotation only means something behind strict: a soft anchor may leave
    // the playlist, so "every track once" has no set to be true of.
    playlistExhaust: (s.playlistIds?.length ?? 0) > 0 && s.playlistStrict && s.playlistExhaust,
    excludedPlaylistIds: s.excludedPlaylistIds || [],
    programme: s.programme ?? false,
    // A skill pin only means something in programme mode.
    segmentSkill: s.programme ? (s.segmentSkill || '') : '',
    // No conditional: a tag is filing, so it survives every other field clearing.
    tags: s.tags || [],
  };
}


// Visual counterpart to showFilterSummary(). Shared by the slate card and table row.
export function showFacets(s: Show): ShowFacet[] {
  const facets: ShowFacet[] = [];
  // Tags lead: they are the operator's filing and must be findable at a glance.
  (s.tags || []).forEach(t => facets.push({ key: `tag-${t}`, label: `#${t}`, accent: true }));
  if (s.moods.length) s.moods.forEach(m => facets.push({ key: `mood-${m}`, label: m }));
  else facets.push({ key: 'mood-any', label: 'any mood' });
  s.genres.forEach(g => facets.push({ key: `genre-${g}`, label: g }));
  s.eras.forEach((e, idx) => facets.push({ key: `era-${idx}`, label: eraLabelOf(e) }));
  s.energies.forEach(en => facets.push({ key: `energy-${en}`, label: en }));
  if (s.vocals) facets.push({ key: 'vocals', label: s.vocals === 'instrumental' ? 'instrumental' : 'vocals' });
  if (s.filtersStrict && hasAnyMusicFilter(s)) facets.push({ key: 'strict', label: 'strict', accent: true });
  const nPl = s.playlistIds?.length ?? 0;
  if (nPl) facets.push({ key: 'playlists', label: `${nPl} playlist${nPl > 1 ? 's' : ''}${s.playlistStrict ? ' · strict' : ''}${s.playlistStrict && s.playlistExhaust ? ' · full rotation' : ''}` });
  const nEx = s.excludedPlaylistIds?.length ?? 0;
  if (nEx) facets.push({ key: 'excluded', label: `${nEx} excluded` });
  if (s.maxTrackSeconds != null) {
    facets.push({ key: 'length', label: s.maxTrackSeconds === 0 ? 'any length' : `≤${s.maxTrackSeconds}s` });
  }
  // Its own facet: cap and floor are independent overrides a show may set alone.
  if (s.minTrackLengthSeconds) {
    facets.push({ key: 'min-length', label: `≥${s.minTrackLengthSeconds}s` });
  }
  if (typeof s.fadeAtShowEnd === 'boolean') {
    facets.push({ key: 'boundary-fade', label: s.fadeAtShowEnd ? 'fades at end' : 'runs over' });
  }
  return facets;
}

// Grammatical name join: "Kai", "Kai & Rae", "Kai, Rae & Sol".
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
}

// `index` is carried on the row: the panel keys colour and editing off the
// show's position in the form array.
function faceOf(p: Persona, apiBase: string) {
  return {
    key: p.id,
    initials: abbrev(p.name?.trim() || ''),
    src: p.avatar ? `${apiBase}/persona-avatar/${encodeURIComponent(p.id)}` : null,
  };
}

// Everything the row needs is derived here, so ShowsTable never sees `Show`.
// `ok` comes from the caller's RHF `formState.errors.shows`, never a local check.
export function showRow(
  s: Show,
  index: number,
  personas: Persona[],
  apiBase: string,
  hrs: number,
  ok: boolean,
): ShowRow {
  const host = personas.find(p => p.id === s.personaId) ?? null;
  const guests = (s.guestPersonaIds || [])
    .map(id => personas.find(p => p.id === id))
    .filter((p): p is Persona => Boolean(p));
  return {
    id: s.id,
    index,
    name: s.name.trim(),
    colour: SHOW_COLORS[index % SHOW_COLORS.length] ?? '#000',
    programme: !!s.programme,
    skillPin: s.programme && s.segmentSkill ? s.segmentSkill : '',
    banter: !!s.banter,
    host: host ? faceOf(host, apiBase) : null,
    hostName: host ? (host.name?.trim() || 'Unnamed') : (s.personaId ? 'Unnamed' : ''),
    guests: guests.map(g => faceOf(g, apiBase)),
    guestNames: joinNames(guests.map(g => g.name?.trim() || 'Unnamed')),
    facets: showFacets(s),
    hrs,
    ok,
  };
}


