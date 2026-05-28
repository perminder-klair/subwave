// Pure math for translating "every N tracks" force-insert cadences into the
// integer weights Liquidsoap's `random(...)` operator expects.
//
// Layered design (see liquidsoap/radio.liq): the existing
// `rotate(weights=[1, jingle_ratio], [jingles, music])` is wrapped in a top-
// level `random(...)` whose first slot is the rotate output and whose
// remaining slots are the rule sources. Each rule's probability per tick is
// w_rule_i / total, so "every N tracks" → w_rule_i / total = 1/N.
//
// WEIGHT_SCALE must match liquidsoap/radio.liq so a slot file storing the
// cadence N maps to the same integer weight on both sides. 1000 was chosen
// because all practical N values (1..1000) round to non-zero integers and the
// base-radio remainder is always positive.

export const WEIGHT_SCALE = 1000;

export type TrackRule = {
  id: string;
  everyN: number;
};

export type RuleWeights = {
  radio: number;        // weight of the base (jingles + music) source
  slots: number[];      // length always equals the slot cap; 0 = inactive
};

export function computeRuleWeights(
  trackRules: TrackRule[],
  slotCap: number,
): RuleWeights {
  const slots = new Array(slotCap).fill(0);
  let ruleSum = 0;
  trackRules.slice(0, slotCap).forEach((r, i) => {
    if (!r || !Number.isFinite(r.everyN) || r.everyN < 1) return;
    const w = Math.max(1, Math.round(WEIGHT_SCALE / r.everyN));
    slots[i] = w;
    ruleSum += w;
  });
  // Radio always keeps at least weight 1 so the base stream is never starved.
  // Practically `ruleSum` is small (sum of 1/N reciprocals scaled to 1000),
  // so the clamp only matters if an operator stacks many extremely fast rules.
  const radio = Math.max(1, WEIGHT_SCALE - ruleSum);
  return { radio, slots };
}

// Reverse map: given the weights for a slot, what cadence does that imply at
// runtime? Used by the admin UI to show "actual ≈ every 7.2 tracks" next to
// the operator's requested value.
export function actualCadence(weights: RuleWeights, slotIndex: number): number {
  const w = weights.slots[slotIndex];
  if (!w) return 0;
  const total = weights.radio + weights.slots.reduce((a, b) => a + b, 0);
  return Math.round((total / w) * 10) / 10; // one decimal place
}
