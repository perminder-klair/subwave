export type AnalyzerHandoffMode = 'auto' | 'path' | 'url';

export function normalizeAnalyzerHandoff(value: unknown): AnalyzerHandoffMode {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return raw === 'auto' || raw === 'path' || raw === 'url' ? raw : 'auto';
}

export function shouldPrefetchAnalyzerAudio(mode: AnalyzerHandoffMode): boolean {
  return mode !== 'url';
}
