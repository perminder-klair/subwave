// The search result contract every provider returns, and the snippet cleanup
// they share. Its own module so a provider adapter outside web-search.ts (the
// Parallel MCP client) can use both without importing the dispatcher that
// imports it.

export type SearchResult = { title: string; content: string };
export type SearchResponse = { answer: string; results: SearchResult[] };

// Strips residual markup from a search snippet. Brave and Firecrawl both pass
// through page descriptions, which can carry entities (&#x27; etc.) and the
// occasional stray tag depending on the source page, even with Brave's
// text_decorations=0 removing the highlighting.
export function cleanSnippet(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/<[^>]+>/g, '')
    .replace(/&#(x?)([0-9a-fA-F]+);/g, (whole, x: string, digits: string) => {
      const code = parseInt(digits, x ? 16 : 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    })
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .trim();
}
