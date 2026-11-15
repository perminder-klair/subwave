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
