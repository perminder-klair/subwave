// The reasoning level under each leg's Reasoning switch (#2296):
// llm.reasoningEffort / llm.fallback.reasoningEffort. Which legs show the
// control is the controller's own predicate (schemas/reasoning.ts, through the
// generated mirror), so the picker appears exactly where a level is sent. A
// saved level is kept when the control is hidden: the controller ignores it
// there, and it comes back when the operator switches provider back.
//
// Pure: the section, its hints and the tests all go through here.

import {
  OPENAI_COMPATIBLE_GATEWAYS,
  MANUAL_THINKING_BUDGETS,
  claudeModelId,
  manualThinkingDefaultBudget,
  normalizeReasoningEffort,
  reasoningEffortOffered,
  type ReasoningEffort,
} from '../../../lib/schemas.generated';
import type { FormState } from './shared';

export type { ReasoningEffort };
export { normalizeReasoningEffort };

export const REASONING_EFFORT_OPTIONS: ReadonlyArray<{ id: ReasoningEffort; label: string }> = [
  { id: 'default', label: 'Default' },
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
];

/** A leg as the form sees it, with `auto` already resolved to the detected mode. */
export interface ReasoningLegView {
  provider: string;
  model: string;
  compatibleMode: 'local' | 'hosted';
}

/** The picker shows for this leg: the controller would send its level. */
export function reasoningEffortShown(leg: ReasoningLegView): boolean {
  const rule = OPENAI_COMPATIBLE_GATEWAYS.find(g => g.id === leg.provider)?.openaiCompatible.reasoning;
  return reasoningEffortOffered(leg, rule);
}

const kTokens = (n: number) => `${Math.round(n / 1000)}k`;

/** What the levels mean on this leg, shown under the picker. */
export function reasoningEffortHint(leg: ReasoningLegView): string {
  const defaultBudget = leg.provider === 'anthropic' ? manualThinkingDefaultBudget(leg.model) : null;
  if (defaultBudget != null) {
    const { low, medium, high } = MANUAL_THINKING_BUDGETS;
    // Read both numbers off the constants, so the copy can't claim Default
    // equals Low after one of them moves.
    const lead = defaultBudget === low
      ? `Default and Low up to ~${kTokens(low)}`
      : `Default up to ~${kTokens(defaultBudget)}, Low ${kTokens(low)}`;
    return `Thinking tokens per reply on this model: ${lead}, `
      + `Medium ${kTokens(medium)}, High ${kTokens(high)}. A DJ line is about 150 tokens, `
      + 'so the default is usually plenty.';
  }
  const base = 'Default keeps what On has always sent. Low, Medium and High set the model’s reasoning effort.';
  if (leg.provider === 'deepseek') return `${base} DeepSeek treats Medium as High.`;
  return base;
}

/**
 * Where the picker is hidden: a pointer to Request parameters on a leg that
 * has them (OpenAI-compatible, locca), else '' (nothing to point at).
 */
export function reasoningEffortHiddenHint(leg: ReasoningLegView): string {
  if (leg.provider !== 'openai-compatible' && leg.provider !== 'locca') return '';
  return 'This server has no standard reasoning level. To set its thinking budget or switch thinking off, '
    + 'add the server’s own fields under Request parameters above.';
}

/** The hosted-compatible Reasoning hint: a Claude proxy honours the switch, other servers ignore it. */
export function hostedReasoningHint(model: string, backup: boolean): string {
  const which = backup ? 'this backup' : 'this connection';
  if (claudeModelId(model)) {
    return `A Claude model behind a proxy honours this switch (sent as reasoning_effort) on ${which}.`;
  }
  return `Hosted compatible services control their own reasoning; this switch is ignored for ${which}. `
    + 'To turn a hosted model’s thinking off, use Request parameters above.';
}

/** The form updater the picker hands setForm. */
export function setReasoningEffort(leg: 'primary' | 'fallback', effort: ReasoningEffort) {
  return (f: FormState): FormState => (leg === 'primary'
    ? { ...f, llm: { ...f.llm, reasoningEffort: effort } }
    : { ...f, llm: { ...f.llm, fallback: { ...f.llm.fallback, reasoningEffort: effort } } });
}
