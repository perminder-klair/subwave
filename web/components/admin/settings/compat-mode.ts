// The openai-compatible connection mode as the admin form shows it. `auto`
// resolves to what the controller last detected for that leg, and to 'local'
// until it has detected anything: the same rule the controller applies
// (controller/src/llm/internal/provider/compat-detect.ts), so a field shown
// only for one mode appears exactly when that mode is in force.
import type { CompatDetectionView } from './shared';

export type CompatMode = 'local' | 'hosted' | 'auto';

export const COMPAT_MODE_OPTIONS: Array<{ id: CompatMode; label: string }> = [
  { id: 'auto', label: 'Auto-detect' },
  { id: 'local', label: 'Local model' },
  { id: 'hosted', label: 'Hosted service' },
];

export function effectiveCompatMode(mode: CompatMode, detected: CompatDetectionView | null | undefined): 'local' | 'hosted' {
  if (mode === 'auto') return detected?.mode ?? 'local';
  return mode;
}

// One sentence naming what Auto-detect found, or '' for an explicit choice.
export function compatDetectedNote(mode: CompatMode, detected: CompatDetectionView | null | undefined): string {
  if (mode !== 'auto') return '';
  if (!detected) return ' Detecting on save.';
  if (!detected.mode) return ` Detected: nothing conclusive (${detected.evidence}), so running as a local model.`;
  return ` Detected: ${detected.mode === 'hosted' ? 'hosted service' : 'local model'} (${detected.server ?? detected.mode}: ${detected.evidence}).`;
}
