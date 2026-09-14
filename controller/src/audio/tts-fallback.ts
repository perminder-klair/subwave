// Expressive engines render square-bracket directions; fallback engines speak
// them literally. Keep the primary text untouched and sanitize only its rescue.
export function fallbackTextFor(requested: string, cloudCueFamily: string | null, text: string): string {
  const expressiveRequest = requested === 'chatterbox'
    || cloudCueFamily === 'fish-s21'
    || cloudCueFamily === 'elevenlabs-v3';
  if (!expressiveRequest || !text) return text;
  return text.replace(/\s*\[[^\]\r\n]{1,80}\]\s*/g, ' ').replace(/\s+/g, ' ').trim();
}

// A voice slot the dispatcher can speak with: an engine plus an optional
// persona-shaped override carrying the voice (and cloud provider).
// `personaTts: null` on the hardcoded rungs is load-bearing: a cloud persona
// rerouted off an unconfigured provider and rescued onto `cloud` would
// otherwise re-apply the dead provider instead of the credentials the
// availability probe just validated. Only the operator's own configured slot
// carries an override, where it is an explicit instruction.
export interface RescueSlot {
  engine: string;
  personaTts: { engine: string; voice: string; cloudProvider: string } | null;
}

export interface TtsTarget {
  engine: string;
  cloudProvider?: string | null;
}

function slotTarget(slot: RescueSlot): TtsTarget {
  return {
    engine: slot.engine,
    cloudProvider: slot.personaTts?.cloudProvider ?? null,
  };
}

// Cloud is the one engine that does not identify a render target on its own:
// its providers share a dispatcher but are independent failure domains, so a
// failed provider must not blacklist a healthy one used as the rescue.
export function sameTtsTarget(
  left: TtsTarget,
  right: TtsTarget,
  defaultCloudProvider: string | null | undefined = null,
): boolean {
  if (left.engine !== right.engine) return false;
  if (left.engine !== 'cloud') return true;
  const provider = (target: TtsTarget) => target.cloudProvider || defaultCloudProvider || null;
  return provider(left) === provider(right);
}

export interface TtsFallbackConfig {
  enabled?: boolean;
  engine?: string;
  voice?: string;
  cloudProvider?: string;
}

// The operator's configured fallback (settings.tts.fallback) as a slot, or null
// when absent, disabled, or naming an engine this build doesn't know. One
// answer shared by the pre-flight reroute and the mid-render rescue.
export function configuredSlot(
  fallback: TtsFallbackConfig | null | undefined,
  engines: readonly string[],
): RescueSlot | null {
  if (!fallback?.enabled) return null;
  const engine = fallback.engine || '';
  if (!engines.includes(engine)) return null;
  return {
    engine,
    personaTts: {
      engine,
      voice: fallback.voice || '',
      cloudProvider: fallback.cloudProvider || 'openai',
    },
  };
}

// Pure ordering for speak()'s runtime rescue chain, kept out of tts.ts so
// scripts/tts-fallback.test.ts can pin it without the engine modules.
//
// Order: operator's configured fallback (engine AND voice), the configured
// default engine, Piper (universal local floor), Kokoro (for when Piper was the
// failed primary). The primary, duplicates and anything `usable` rejects are
// dropped. A disabled fallback reproduces the pre-fallback order exactly.
//
// Dedup is by ENGINE, first-wins, so the configured slot's voice survives when
// it and the default name the same engine. Dedup stays engine-keyed even though
// EXCLUSION is provider-keyed for cloud (sameTtsTarget): one cloud attempt per
// rescue, since a second buys another round-trip while the local floor waits.
//
// `usable` gets the slot's own cloud provider for the configured rung and null
// for the hardcoded ones, so the probe agrees with the call.
export function orderedFallbacks(
  primary: string | TtsTarget,
  configured: RescueSlot | null,
  defaultEngine: string | null | undefined,
  usable: (engine: string, cloudProvider?: string | null) => boolean,
  defaultCloudProvider: string | null | undefined = null,
): RescueSlot[] {
  const primaryTarget: TtsTarget = typeof primary === 'string'
    ? { engine: primary }
    : primary;
  const candidates: RescueSlot[] = [
    ...(configured ? [configured] : []),
    ...[defaultEngine, 'piper', 'kokoro'].map((engine) => ({
      engine: engine || '',
      personaTts: null,
    })),
  ];
  const out: RescueSlot[] = [];
  for (const slot of candidates) {
    const { engine } = slot;
    const target = slotTarget(slot);
    if (
      !engine
      || sameTtsTarget(target, primaryTarget, defaultCloudProvider)
      || out.some((s) => s.engine === engine)
    ) continue;
    if (!usable(engine, slot.personaTts?.cloudProvider ?? null)) continue;
    out.push(slot);
  }
  return out;
}
