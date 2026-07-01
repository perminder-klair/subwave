// News — fetch fresh headlines from the configured feed, burning each on read
// so a later tick doesn't re-offer it. `config.feed` / `config.feedMaxItems`
// come from the skill's frontmatter (the operator's state override, if any);
// undefined → services.fetchHeadlines falls back to the env-configured feed.
export const description = 'Fetch current news headlines from the configured feed. Returns only headlines not already read on air.';

export default async function getHeadlines(ctx, state, services, config) {
  if (!(state.seenHeadlines instanceof Set)) state.seenHeadlines = new Set();
  const maxItems = config?.feedMaxItems ? Number(config.feedMaxItems) : undefined;
  const items = await services.fetchHeadlines({ feedUrl: config?.feed || undefined, maxItems });
  const fresh = items.filter(it => !state.seenHeadlines.has(services.hashHeadline(it.title)));
  // Burn-on-read so a later tick doesn't re-offer the same headline.
  for (const it of fresh.slice(0, 6)) state.seenHeadlines.add(services.hashHeadline(it.title));
  if (state.seenHeadlines.size > 120) {
    state.seenHeadlines = new Set(Array.from(state.seenHeadlines).slice(-60));
  }
  if (!fresh.length) return { headlines: [] };
  return { headlines: fresh.slice(0, 6).map(it => ({ title: it.title, detail: it.description || null })) };
}
