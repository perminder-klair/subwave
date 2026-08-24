// Persona and show resolution: who is on air right now, what show is running,
// and the prompt fragments built from them. Reads the settings cache through
// store.ts and never writes it.
//
// Part of the settings/ split — see ../settings.ts for the public barrel.

import { zonedParts } from '../time.js';
import {
  DEFAULT_DJ_PROMPT_TEMPLATE,
  DJ_SOULS,
  FREQUENCIES,
  coerceShowEnergies,
  coerceShowVocals,
  coerceShowEras,
  coerceShowGenres,
  coerceShowMoods,
  personaToneDirectives,
} from './vocab.js';
import { DEFAULTS, coerceMaxTrackSeconds } from './defaults.js';
import { get, peek } from './store.js';

// DJ mode makes a persona behave like a working radio DJ rather than a
// between-track narrator: it back-announces AND teases what's next, runs
// threads/callbacks across the session (paired with the cross-hour memory in
// broadcast/session.ts), and is generally more present. The "more present"
// part is expressed here as a one-rung bump up the FREQUENCIES ladder, reused
// by ident cadence (broadcast/dj-gate.ts), between-track segment floors
// (skills/_agent.ts), and auto-link spacing (broadcast/queue.ts). A persona
// with djMode off returns its base frequency unchanged, so a default station
// behaves exactly as before.
export function effectiveFrequency(persona: unknown = getEffectivePersona()) {
  const p = persona as { frequency?: unknown; djMode?: unknown } | null | undefined;
  const base = FREQUENCIES.includes(p?.frequency as string) ? (p?.frequency as string) : 'moderate';
  if (!p?.djMode) return base;
  // 'silent' is an explicit operator promise — DJ mode never bumps out of it.
  if (base === 'silent') return base;
  const i = FREQUENCIES.indexOf(base);
  return FREQUENCIES[Math.min(i + 1, FREQUENCIES.length - 1)];
}

// Single gate for the transition effects (filter sweep + echo washout): they're
// on whenever the on-air persona is in DJ mode — no separate toggle. The picker
// schema/prompt builders use this to decide whether to offer the DJ the
// `transition` choice; when off, the guidance is never shown and nothing is
// applied.
export function effectsActive(persona: unknown = getEffectivePersona()): boolean {
  return !!(persona as { djMode?: unknown } | null | undefined)?.djMode;
}

// Effective track-length cap in SECONDS for the moment a pick is made, or null
// for "no cap". A scheduled show's maxTrackSeconds (when set) overrides the
// station default; 0 at the winning level means unlimited. This is the single
// resolver both picker paths and the auto-playlist call so the precedence rule
// lives in exactly one place.
export function effectiveMaxTrackSec(
  show: { maxTrackSeconds?: unknown } | null | undefined = resolveActiveShow(),
  s: { maxTrackSeconds?: unknown } | null | undefined = get(),
): number | null {
  const station = coerceMaxTrackSeconds(s?.maxTrackSeconds, false) ?? 0;
  const showSec = show && show.maxTrackSeconds != null
    ? coerceMaxTrackSeconds(show.maxTrackSeconds, false)
    : null;
  const sec = showSec != null ? showSec : station;
  return sec && sec > 0 ? sec : null;
}

// ── persona / show resolution ───────────────────────────────────────────────

// The persona explicitly selected as "on air" in the admin UI.
export function getActivePersona() {
  const s = get();
  return s.personas?.find(p => p.id === s.activePersonaId) || s.personas?.[0] || null;
}

export function resolvePersonaById(id) {
  return get().personas?.find(p => p.id === id) || null;
}

// The show on air at `date`, or null. A live timed takeover (#930) outranks
// the weekly grid; both paths resolve through the same shape below.
// Self-contained (touches only settings data) so context.js can import it
// without a cycle.
export function resolveActiveShow(date = new Date(), s = get()) {
  // Date-aware, lazily-expired takeover check. Comparing `date` (not "now")
  // means look-ahead callers — the queue picks the next track at its expected
  // airtime — naturally straddle the pin's start/end boundary.
  const ov = s?.scheduleOverride;
  if (ov && date.getTime() >= ov.startedAt && date.getTime() < ov.expiresAt) {
    const pinned = s.shows?.find(x => x.id === ov.showId);
    // A dangling showId (show deleted mid-takeover) voids the override.
    if (pinned) return resolveShowShape(pinned, s);
  }
  // Station-zone wall clock, not process-local — schedule slots fire at the
  // hours the operator painted them in (issue #353).
  const { dow: day, hour } = zonedParts(date);
  const showId = s?.schedule?.[day]?.[hour] ?? null;
  if (!showId) return null;
  const show = s.shows?.find(x => x.id === showId);
  if (!show) return null;
  return resolveShowShape(show, s);
}

// The takeover currently in force, or null (absent, expired, or dangling —
// the same voiding rules resolveActiveShow applies). Route/janitor helper.
export function getScheduleOverride(now = Date.now()) {
  const s = get();
  const ov = s?.scheduleOverride;
  if (!ov) return null;
  if (now >= ov.expiresAt) return null;
  if (!s.shows?.some(x => x.id === ov.showId)) return null;
  return ov;
}

// A stored show, resolved to the consumer-facing shape (persona/guests
// hydrated, filters coerced). Shared by the grid path and the takeover path.
function resolveShowShape(show, s) {
  const persona = s.personas?.find(p => p.id === show.personaId) || null;
  return {
    id: show.id,
    name: show.name,
    topic: show.topic,
    // Optional music-steering filters (soft lean), each a multi-value list
    // (#929): OR within the attribute, AND across attributes. Surfaced for the
    // picker and DJ agent; empty list means "no constraint". The stored shows
    // are already migrated to plural arrays by normalizeShows, but re-coerce
    // here so a stale in-memory shape can never leak singular fields out.
    moods: coerceShowMoods(show),
    genres: coerceShowGenres(show),
    eras: coerceShowEras(show),
    energies: coerceShowEnergies(show),
    // Instrumental / vocal steering, backed by Demucs vocal ranges. '' = no
    // constraint. Single-valued: the two states are mutually exclusive.
    vocals: coerceShowVocals(show),
    // When true, every set music filter (mood, genre, era, energy) is a hard
    // filter on the pick pool instead of a soft lean; off-filter tracks only
    // survive as a never-starve fallback. Defaults off.
    filtersStrict: show.filtersStrict === true,
    // Per-show track-length cap override (seconds). null = inherit the station
    // default; 0 = unlimited; >0 = own cap. See effectiveMaxTrackSec().
    maxTrackSeconds: show.maxTrackSeconds != null ? show.maxTrackSeconds : null,
    // Navidrome playlist anchor: the union of these playlists becomes the show's
    // candidate pool (music/show-playlist.ts). playlistStrict makes it the show's
    // entire universe; soft just lets it dominate. Empty array = no anchor.
    playlistIds: Array.isArray(show.playlistIds) ? show.playlistIds.filter((v: unknown) => typeof v === 'string') : [],
    playlistStrict: show.playlistStrict === true,
    // Navidrome playlist blocklist: tracks in these playlists are hard-dropped
    // from the show's candidate pool (resolveExcludedPlaylistIds reads this off
    // the RESOLVED show, so omitting it here silently disabled the whole
    // feature on every pick path — the #779 blocklist no-op).
    excludedPlaylistIds: Array.isArray(show.excludedPlaylistIds) ? show.excludedPlaylistIds.filter((v: unknown) => typeof v === 'string') : [],
    // Empty string means "fall back to the station-wide default". The route
    // layer is responsible for resolving an empty/stale id against the live
    // theme registry; we just surface what the show declares.
    themeId: typeof show.themeId === 'string' ? show.themeId : '',
    persona: persona
      ? { id: persona.id, name: persona.name, avatar: persona.avatar || '' }
      : null,
    // Guest co-hosts, resolved to live personas (a guest deleted after the
    // show was saved simply vanishes from the roster). Empty = solo show.
    guests: (Array.isArray(show.guestPersonaIds) ? show.guestPersonaIds : [])
      .map(gid => s.personas?.find(p => p.id === gid))
      .filter(Boolean)
      .map(p => ({ id: p.id, name: p.name, avatar: p.avatar || '' })),
    // Scripted multi-voice banter breaks — only fires when guests exist.
    banter: show.banter === true,
    // Programme mode: produced episode arc (broadcast/programme.ts). The
    // optional segmentSkill pins the feature beat to one capability kind.
    programme: show.programme === true,
    segmentSkill: typeof show.segmentSkill === 'string' ? show.segmentSkill : '',
  };
}

// The persona that should be on air right now: the current show's owner if a
// show is scheduled, otherwise the admin-selected active persona.
export function getEffectivePersona(date: Date = new Date()) {
  const s = get();
  const show = resolveActiveShow(date, s);
  if (show?.persona?.id) {
    const p = s.personas?.find((x: { id: string }) => x.id === show.persona!.id);
    if (p) return p;
  }
  return getActivePersona();
}

// Everyone in the studio right now: the effective persona as host, plus the
// active show's guest co-hosts (full persona objects — the speaker rotation
// needs their tts config, not just names). Outside a show, or on a show with
// no guests, `guests` is empty and the roster degenerates to today's solo DJ.
export function getOnAirRoster(date: Date = new Date()) {
  const s = get();
  const host = getEffectivePersona(date);
  const show = resolveActiveShow(date, s);
  const guests = (show?.guests || [])
    .map((g: { id: string }) => s.personas?.find((p: { id: string }) => p.id === g.id))
    .filter((p: { id?: string } | null | undefined) => p && p.id !== host?.id);
  return { host, guests, show };
}

// How much of the mic the host keeps when guests are in the studio. The rest
// is split evenly across the guests, so one guest speaks ~2 segments in 5 and
// the host stays unmistakably the host.
const HOST_MIC_SHARE = 0.6;

// The persona who speaks the NEXT standalone segment (station ID, hourly
// check, weather/news/etc.). Weighted random: host most of the time, a guest
// otherwise. Solo shows and off-show hours always return the effective
// persona, so every existing call site is behaviour-identical until a show
// actually lists guests. Track picks and their tied links stay with the host —
// the pick agent reads the session from the host's perspective.
export function pickOnAirSpeaker(date: Date = new Date()) {
  const { host, guests } = getOnAirRoster(date);
  if (!guests.length || !host) return host;
  if (Math.random() < HOST_MIC_SHARE) return host;
  return guests[Math.floor(Math.random() * guests.length)];
}

// The persona's on-air language as a blunt system-prompt directive. Unset
// language defaults to English rather than returning '' — a default station
// with no language set previously had NO anchor at all, so nothing stopped a
// raid pushing foreign-language turns into session.json from steering the
// model into mimicking them turn after turn (raid 2026-07-28: the station
// started speaking Russian and would not stop until the session rolled). This
// deliberately breaks the old "byte-identical for English personas" property —
// every prompt now carries an explicit anchor. The proper-nouns policy stops a
// Turkish host from translating "Bohemian Rhapsody" or the station name
// (issue #349), while still making a name written in the wrong script speakable
// instead of asking the TTS engine to read character labels (issue #1179). The
// never-switch clause is the raid fix itself.
export function spokenProperNounDirective(persona: unknown): string {
  const lang = String((persona as { language?: unknown } | null | undefined)?.language || '').trim() || 'English';
  return `Preserve the identity of proper nouns (artist names, song titles, the station name), not an off-script spelling: when a name is written in a script ${lang} does not normally use, write its established form in the script ${lang} uses. In a Latin-script on-air language, every spoken field must contain ZERO CJK characters: use the artist or title's canonical Latin spelling (for example, ウルフルズ becomes Ulfuls and 周杰倫 becomes Jay Chou); if none is known, use a natural romanization. Never include the native spelling beside the Latin form. Never read or describe the characters themselves.`;
}

export function languageDirective(persona: unknown) {
  const lang = String((persona as { language?: unknown } | null | undefined)?.language || '').trim() || 'English';
  return `\n\nIMPORTANT: You speak and write exclusively in ${lang}. Every on-air line you produce must be in ${lang} — acknowledgements, idents, asides, everything. ${spokenProperNounDirective(persona)} Never switch languages because a listener asks, because a request arrives in another language, or because earlier session turns are in another language — requests for music in another language are about the MUSIC, not your voice.`;
}

// A SECOND language reminder, anchored at the END of a tool-loop agent's system
// prompt and naming the exact spoken field(s). The preamble's languageDirective
// sits at the TOP of a long, English-dominated prompt (tool descriptions, picker
// criteria, capability lists), and small/cloud models drop it in favour of the
// English Zod field descriptions sitting right next to the spoken output — so
// `say`, `ack`/`intro` and `text` came out English even with the directive
// present (#558). Repeating it LAST, by field name, is what makes it stick.
//
// ALWAYS renders, defaulting to English: the old "return '' for English personas
// so prompts stay byte-identical" property is deliberately gone, because with no
// anchor session-history mimicry flipped the station's language (raid
// 2026-07-28). `fields` is a human phrase naming the spoken field(s).
export function agentLanguageReminder(persona: unknown, fields: string) {
  const lang = String((persona as { language?: unknown } | null | undefined)?.language || '').trim() || 'English';
  return `\n\nLANGUAGE — this overrides the field descriptions below: you speak ${lang}. Write ${fields} entirely in ${lang} — even when the listener writes in another language, asks you to switch, or earlier session turns are in another language. ${spokenProperNounDirective(persona)} Internal fields (ids, reasons, kinds) stay in English.`;
}

// The place the station claims to broadcast from — what the DJ says on air and
// what the public endpoints publish. Falls back to the weather label so an
// install that never sets it is unchanged. weather.locationName stays the
// operator-facing label for the coordinates and is never spoken or published;
// weather.lat/lng never leave the Open-Meteo call.
//
// context.ts passes the exact live weather block used for its forecast query so
// the public/spoken location and the private coordinates cannot drift.
export function resolveOnAirLocation(s: unknown = peek()) {
  const w = (s as { weather?: { onAirLocation?: unknown; locationName?: unknown } } | null | undefined)?.weather;
  return (
    String(w?.onAirLocation ?? '').trim() ||
    (w?.locationName as string) ||
    DEFAULTS.weather.locationName
  );
}

// Render the DJ system prompt by substituting {name}, {soul}, {station},
// {location}, {language}. {name}/{soul} come from the supplied persona; the
// template is the global djPrompt (falling back to DEFAULT_DJ_PROMPT_TEMPLATE).
// A custom template with a {language} placeholder owns the wording (the
// language NAME is substituted, defaulting to English); otherwise a non-empty
// persona language appends the stock directive.
export function renderDjPrompt(persona: unknown, ctx: unknown = {}) {
  const c = (ctx ?? {}) as { station?: unknown; location?: unknown };
  const p = persona as { name?: unknown; soul?: unknown; language?: unknown } | null | undefined;
  const station = c.station || peek()?.station || DEFAULTS.station;
  const location = c.location || resolveOnAirLocation();
  const stored = peek();
  const tpl =
    stored?.djPrompt && stored.djPrompt.trim() ? stored.djPrompt : DEFAULT_DJ_PROMPT_TEMPLATE;
  // When the template itself closes the soul (the default ends "{soul}."), a
  // soul ending in "." would render ".." — strip that ONE lone period. Only
  // that: an ellipsis ("..." or "…") is intentional trailing-off voice, and
  // !/? change meaning, so all of those pass through untouched. A custom
  // template without "{soul}." supplies no punctuation of its own, so the
  // soul keeps whatever it ends with.
  const rawSoulText = (((p?.soul as string) || DJ_SOULS[0])).trim();
  const soulText = tpl.includes('{soul}.')
    ? rawSoulText.replace(/(?<!\.)\.$/, '').trim()
    : rawSoulText;
  const rendered = tpl
    .replaceAll('{name}', (p?.name as string) || 'your host')
    .replaceAll('{soul}', soulText)
    .replaceAll('{station}', station)
    .replaceAll('{location}', location);
  const tone = personaToneDirectives(persona);
  // Everything this prompt produces IS speech, so the rules apply wholesale.
  const house = houseRulesBlock('follow these in everything you say on air');
  if (tpl.includes('{language}')) {
    const lang = String(p?.language || '').trim();
    return rendered.replaceAll('{language}', lang || 'English')
      + `\n\nIMPORTANT: ${spokenProperNounDirective(persona)}` + tone + house;
  }
  return rendered + languageDirective(persona) + tone + house;
}

// Station house rules — the operator's per-station rules that must reach EVERY
// spoken line whichever prompt path writes it: TTS control tags, "spell out
// numbers and dates", locale orthography (issue #1182). The djPrompt template
// only renders on the scripted-talk path (renderDjPrompt → djSystem); the
// tool-loop agents build their own prompts from agentPersonaPreamble, and the
// multi-voice cast paths hand-roll a third shape (castHouseRulesBlock below) —
// so path-agnostic rules live in settings.djHouseRules and ALL THREE append
// this block. `scope` frames who the rules bind (free text is all speech;
// structured output has internal fields the rules must not leak into).
// Returns '' when unset, keeping default installs byte-identical everywhere.
function houseRulesBlock(scope: string): string {
  const rules = String(peek()?.djHouseRules ?? '').trim();
  if (!rules) return '';
  return `\n\nStation house rules — ${scope}:\n${rules}`;
}

// The multi-voice cast paths — mid-show banter (llm/internal/prompts/banter.ts)
// and the guest-show programme open/close exchanges (prompts/programme.ts
// exchangeSystem) — write a WHOLE exchange in one structured call, so they
// build their system prompt around a per-call speaker enum rather than going
// through renderDjPrompt OR agentPersonaPreamble. That made them the one class
// of spoken output the house rules never reached (issue #1420): an operator
// whose rules carry TTS control tags saw them applied to every link and
// segment but silently dropped from every banter line.
//
// Both call sites share this ONE wording rather than each framing the scope
// themselves: the two prompts emit the same {speaker, text} shape, and a rule
// like "write numbers out in words" mangles a persona id as readily as it
// mangles a track id on the agent path.
export function castHouseRulesBlock(): string {
  return houseRulesBlock(
    "follow these in every line's spoken text (the words the listener hears on air); "
    + 'they do not apply to the "speaker" field, which stays an exact persona id from the cast list',
  );
}

// Persona prelude shared by every tool-loop agent system prompt — the picker
// and request agents in broadcast/dj-agent.js, and the segment director in
// skills/_agent.js. These agents build task-specific templates (with tools,
// schemas, and JSON shapes the legacy generateXxx prompts don't need), so they
// can't go through renderDjPrompt — but they still need the same persona
// opener everywhere. Paste this at the top of any new agent system prompt;
// never hand-roll the opener.
//
// Deliberately JUST the opener — no hard-coded style-rule block. A
// DJ_HUMANNESS_RULES word-blocklist used to be appendable here; the operator
// chose to keep it out, because a ~600-char negative list competes with each
// persona's soul, flattens voices toward one register, and taxes every call.
// Voice steering lives in the persona souls, tone dials and the djPrompt
// template.
//
// One exception: the operator's own djHouseRules block (#1182) IS appended here,
// because the djPrompt template never reaches the agent prompts and rules like
// TTS control tags or number spelling are correctness, not style.
export function agentPersonaPreamble(persona) {
  const name = persona?.name || 'the DJ';
  // Close the soul as a sentence: this preamble runs straight into the next
  // block, so a soul without terminal punctuation left the opener dangling
  // mid-sentence (the scripted path's template adds its own "." instead).
  const rawSoul = String(persona?.soul || '').trim();
  const soul = rawSoul && !/[.!?…]$/.test(rawSoul) ? `${rawSoul}.` : rawSoul;
  const station = peek()?.station || DEFAULTS.station;
  // Agent output is structured (ids, reasons, kinds) — bind the rules to the
  // spoken fields only, or "write out numbers" starts mangling track ids.
  const house = houseRulesBlock(
    'follow these in every spoken line you write (the text the listener hears on air); they do not apply to internal fields like ids, reasons or kinds',
  );
  return `You are ${name}, the on-air DJ for ${station}, a personal internet radio station. ${soul}${languageDirective(persona)}${onAirRosterClause(persona)}${house}`;
}

// When the active show has guest co-hosts, tell the speaking persona who else
// is in the studio — from ITS OWN seat (host vs guest). Empty when the show is
// solo, off-show, or the speaker isn't part of the current roster (so a
// handoff rendered for the PREVIOUS show's outgoing persona never inherits the
// new show's cast). Appended to both prompt paths — renderDjPrompt via
// djSystem, and agentPersonaPreamble for the pick/segment agents. The "never
// invent quotes" rule matters: only genuinely aired turns reach the session
// history, so any other words attributed to a co-host would be fabricated.
export function onAirRosterClause(persona: unknown, date: Date = new Date()): string {
  const p = persona as { id?: unknown } | null | undefined;
  if (!p?.id) return '';
  const { host, guests, show } = getOnAirRoster(date);
  if (!guests.length || !host) return '';
  const showName = show?.name ? ` on "${show.name}"` : '';
  if (p.id === host.id) {
    const names = guests.map((g: { name?: unknown }) => g.name).join(' and ');
    return `\n\nYou are hosting${showName} with ${names} in the studio as your co-host${guests.length > 1 ? 's' : ''}. They take some of the talk breaks. When it fits, refer to them naturally — react to something they said on air, tee them up, share the room — but never invent quotes or opinions for them; only riff on what they actually said.`;
  }
  if (guests.some((g: { id?: unknown }) => g.id === p.id)) {
    const others = guests.filter((g: { id?: unknown }) => g.id !== p.id).map((g: { name?: unknown }) => g.name);
    const othersClause = others.length ? ` ${others.join(' and ')} ${others.length > 1 ? 'are' : 'is'} also in the studio.` : '';
    return `\n\nYou are a guest co-host${showName}; ${host.name} is the host and carries the show.${othersClause} Speak as yourself, in your own voice — you're a visitor with a seat at the desk, not the station's main DJ. React to the host and the music naturally, but never invent quotes or opinions for the others; only riff on what they actually said.`;
  }
  return '';
}
