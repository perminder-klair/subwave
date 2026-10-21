// The host a community skill's feed reads from, shown before install. The full
// URL is mostly path; the host is what an operator judges a source by. A URL
// that won't parse shows nothing rather than a raw string.
export function feedHost(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}
