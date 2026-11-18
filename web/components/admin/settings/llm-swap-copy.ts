/** What GET /settings/llm/swap/fit previews of the embedding leg: the
 *  Library-tagger fields the swap will pin (they inherit the primary's today),
 *  and whether an inherited key is too long to pin
 *  (controller settings/llm-swap.ts planLlmSwap). */
export interface SwapEmbeddingPreview {
  pinned: string[];
  keyNotPinned: boolean;
}

const PIN_NAMES: Record<string, string> = {
  provider: 'provider',
  providerBaseUrls: 'base URL',
  ollamaUrl: 'Ollama URL',
  headers: 'custom headers',
  apiKey: 'API key',
};

/** The pinned fields in the Library tagger's own words: "provider, Ollama URL
 *  and API key". Empty when nothing is pinned. */
export function pinnedFieldNames(pinned: readonly string[]): string {
  const names = pinned.map(p => PIN_NAMES[p] ?? p);
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
