// Number formatting shared by the Stats page's sections.

export const fmtInt = (n: number | null | undefined): string =>
  n == null ? '—' : Number(n).toLocaleString('en-GB');

// Latencies read in seconds on this page: the default model is a slow homelab
// Ollama, so milliseconds would be four digits of noise.
export const fmtSec = (ms: number | null | undefined): string => {
  if (ms == null) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
};

export const fmtPct = (n: number | null | undefined): string =>
  n == null ? '—' : `${Math.round(n * 100)}%`;

export const fmtTokens = (n: number | null | undefined): string => {
  if (n == null) return '—';
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
};

// One-decimal mean; listener counts are small integers.
export const fmtAvg = (n: number | null | undefined): string =>
  n == null ? '—' : (Math.round(n * 10) / 10).toLocaleString('en-GB');

export const fmtBytes = (n: number | null | undefined): string => {
  if (n == null) return '—';
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
};

export const fmtUsd = (n: number): string => (n >= 10 ? `$${n.toFixed(1)}` : `$${n.toFixed(2)}`);

// A share of a whole, as a whole percent; empty when there is no whole.
export const fmtShare = (part: number, whole: number | null | undefined): string =>
  whole ? `${Math.round((part / whole) * 100)}%` : '';

// "sdk.djAgentPick" → "djAgentPick": the SDK prefix is plumbing, the rest is
// the name the logs use.
export const kindName = (kind: string): string => kind.replace(/^sdk\./, '');
