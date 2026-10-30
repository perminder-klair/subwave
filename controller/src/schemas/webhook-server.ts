// Server-only webhook rules. These are the three things a schema cannot express
// because they are not pure functions of a single value:
//
//   1. the authHeader 'set' redaction sentinel  — needs the EXISTING list
//   2. id minting                                — a side effect
//   3. cross-item id de-duplication              — needs sibling awareness
//
// Keeping them out of schemas/webhook.ts is load-bearing: it is what lets that
// file be copied byte-for-byte into the browser bundle.
import { mintId } from '../settings/vocab.js';
import { stripSecretControlChars } from './settings.js';
import type { Webhook, WebhookParsed } from './webhook.js';

/**
 * Rules 2 and 3 on their own: give every row an id, and make those ids unique.
 *
 * Separate from mergeWebhookSecrets because BOTH webhook paths need it — the
 * strict update() validator and the lenient load-time normaliser in
 * settings/normalize.ts — while only the save path has an `existing` list to
 * resolve the redaction sentinel against. Two hand-rolled copies of "mint if
 * absent, re-mint on collision" is how load and save start disagreeing about
 * which row owns which id, and the id is what carries a stored secret forward.
 */
export function resolveWebhookIds<T extends { id?: string }>(items: T[]): (T & { id: string })[] {
  const seen = new Set<string>();
  return items.map((item) => {
    let id = item.id ?? mintId('wh_');
    if (seen.has(id)) id = mintId('wh_');
    seen.add(id);
    return { ...item, id };
  });
}

export function mergeWebhookSecrets(
  parsed: WebhookParsed[],
  existing: Webhook[] = [],
): Webhook[] {
  const byId = new Map(existing.map((h) => [h.id, h] as const));

  // Ids first: the sentinel is resolved against the id a row ENDS UP with, so a
  // row whose id was re-minted on collision correctly finds no prior secret.
  return resolveWebhookIds(parsed).map((item) => {
    // 'set' from getRedacted() means "keep the stored value" — the UI never
    // re-sends the real header. Anything else replaces it, control characters
    // stripped as every secret's save path does (schemas/settings.ts).
    if (item.authHeader !== 'set') return { ...item, authHeader: stripSecretControlChars(item.authHeader) };
    return { ...item, authHeader: byId.get(item.id)?.authHeader ?? '' };
  });
}
