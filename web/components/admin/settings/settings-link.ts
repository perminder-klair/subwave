// Links into /admin/settings that land on one card, not just the top of a tab.
//
// `?section=<id>` picks the tab, as it always has. `&card=<anchor>` then jumps to
// the card whose `data-card` slug is <anchor>, through the same jumpTo the
// settings search uses, so a card behind the section's Advanced disclosure opens
// it first (#2316: the Last.fm card links to Library tagger → Enrichment, which
// sits under Advanced).
import { isAdvancedCard, type SectionId } from './registry';
import type { SettingsJump } from './SettingsSearch';

// A card slug as cardAnchor writes it. The anchor goes into a CSS attribute
// selector, so anything else from the URL is ignored rather than allowed to
// break (or reach past) the selector.
const CARD_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function settingsHref(section: SectionId, card?: string): string {
  const q = new URLSearchParams({ section });
  if (card) q.set('card', card);
  return `/admin/settings?${q.toString()}`;
}

/** The jump a settings URL asks for, or null when it names no usable card. */
export function settingsJumpFromQuery(section: string | null, card: string | null): SettingsJump | null {
  if (!section || !card || !CARD_SLUG.test(card)) return null;
  const id = section as SectionId;
  return { section: id, anchor: card, advanced: isAdvancedCard(id, card) };
}

/** The part of useSearchParams' result the deep link reads. */
export interface SettingsQuery {
  get(name: string): string | null;
  toString(): string;
}

/** A jump to run, and the URL search to replace the address with once it has. */
export interface DeepLinkStep {
  jump: SettingsJump;
  /** The query without `card` (`?section=library`), or '' when nothing is left. */
  search: string;
}

/**
 * The deep-link jump SettingsPanel should run now, or null.
 *
 * Only once the cards can exist: the panel renders no card before the first
 * settings read lands, and jumpTo gives up after about a second, so a jump
 * fired on mount is lost on a cold load whose read is slower than that (a
 * refresh, a new tab, a slow controller).
 *
 * Once it has jumped, the panel replaces the address with `search`, the same
 * query minus `card`. In a production build useSearchParams' object is
 * memoised on the URL string, so a second click on a link to the URL already
 * in the address bar returns the same object and nothing re-runs: stripping
 * the card makes the next click a different URL. It also leaves nothing for a
 * refetch, a router refresh or a dev-mode tree change (which mints a new object
 * for the same URL) to jump on, so the operator is never scrolled mid-edit.
 * `lastJumped` covers the moment before the replace lands (Strict Mode's
 * second effect run).
 */
export function deepLinkJump(
  query: SettingsQuery,
  cardsReady: boolean,
  hasSection: (id: string) => boolean,
  lastJumped: SettingsQuery | null,
): DeepLinkStep | null {
  if (!cardsReady || query === lastJumped) return null;
  const jump = settingsJumpFromQuery(query.get('section'), query.get('card'));
  if (!jump || !hasSection(jump.section)) return null;
  const rest = new URLSearchParams(query.toString());
  rest.delete('card');
  const search = rest.toString();
  return { jump, search: search ? `?${search}` : '' };
}
