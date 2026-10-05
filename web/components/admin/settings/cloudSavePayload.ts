import { TTS_CLOUD_PROVIDERS } from '../../../lib/schemas.generated';

// The provider/model/voice/key-clearing decisions for one TTS save, kept out of
// the component because they are ONE decision and were being taken three times.
//
// WHY IT IS NOT INLINE ANY MORE
// -----------------------------
// `save()` sends `tts.cloud` as a rebuild, and three separate expressions each
// re-derived "which provider is this?" from the raw form value:
//
//   the payload's `provider`   — normalised against the enum, falling back to 'openai'
//   `clearInlineCloudKey`      — compared the raw form value against the saved one
//   the model/voice emptiness  — sent raw, whatever the provider
//
// They agree on a well-formed form and disagree on a STALE one, which is exactly
// when the consequences are real. A form hydrated by an older build can carry a
// provider id the enum no longer accepts. That produced two separate bugs:
//
//  - The key comparison read the stale id as a genuine provider TRANSITION, so
//    the save sent `apiKey: ''` and ERASED the operator's stored inline key. The
//    provider had not changed at all; only the form was out of date.
//
//  - The model and voice went out raw while the provider was normalised. The
//    controller rejects a blank `tts.cloud.model` for EVERY provider
//    ("must be 1-100 chars"), so a blank model 400'd the whole save — including
//    the unrelated LLM and provider settings the operator opened the page to
//    change. Blank voice is narrower: only `openai-compatible` may legitimately
//    carry one, because its voices are server-specific and the server picks its
//    own default.
//
// So the rules below are transcribed from the controller's own validation in
// `settings.ts` — the `tts.cloud.provider` enum check, the model length check,
// and the `allowEmpty` voice branch. Where the controller accepts a blank, the
// web sends it; where it rejects one, the web OMITS the key so the controller
// keeps what it already has, rather than inventing a default the operator never
// chose.

export type CloudProviderId = (typeof TTS_CLOUD_PROVIDERS)[number];

const VALID = TTS_CLOUD_PROVIDERS as readonly string[];

/** The provider this save actually speaks for.
 *
 *  The raw form value wins when the enum accepts it. When it does not, the
 *  SAVED provider is preferred over a hardcoded fallback: a stale form should
 *  restore what the station already had, not silently repoint it at the enum's
 *  first member. `TTS_CLOUD_PROVIDERS[0]` is only the last resort, for a station
 *  whose saved value is itself invalid. */
export function normalizeCloudProvider(
  raw: unknown,
  saved?: unknown,
): CloudProviderId {
  const r = String(raw ?? '').trim();
  if (VALID.includes(r)) return r as CloudProviderId;
  const s = String(saved ?? '').trim();
  if (VALID.includes(s)) return s as CloudProviderId;
  return TTS_CLOUD_PROVIDERS[0];
}

/** The one provider the controller accepts a blank voice from. Mirrors the
 *  `allowEmpty` branch in `settings.ts`; a blank voice anywhere else is
 *  omitted instead of sent. */
export function allowsBlankVoice(provider: string): boolean {
  return provider === 'openai-compatible';
}

export interface CloudSaveInput {
  /** The raw form value — NOT pre-normalised. Normalising it before it gets
   *  here is the bug: it is what let the three expressions disagree. */
  provider?: string;
  model?: string;
  voice?: string;
  /** The provider currently persisted, or '' when none is. */
  savedProvider?: string;
  /** Fish owns a scoped credential slot, so its legacy shared key is always
   *  cleared on save — that is a credential-placement decision, not a
   *  provider transition. */
  isFish?: boolean;
}

// WHY BLANK FIELDS ARE OMITTED — AND ONLY SOMETIMES
// ---------------------------------------------------
// `settings.ts` merges the cloud block field by field (`if (c.model !== undefined)`,
// `if (c.voice !== undefined)`, …). Omitting a key therefore means KEEP the stored
// value, which is the whole basis of the two rules below:
//
//   the controller rejects a blank `tts.cloud.model` unconditionally
//     ("must be 1-100 chars"), so a blank model used to 400 the ENTIRE save,
//     taking the unrelated LLM and provider settings with it.
//
//   a blank voice is accepted only by `openai-compatible`
//     (`allowEmpty`), whose voices are server-specific and default server-side.
//
// But preserving is only correct when the field the controller would keep belongs
// to the provider now being saved. On a real TRANSITION it is the previous
// provider's value: switching OpenAI -> Fish with a blank voice would otherwise
// send `provider: 'fish-audio'` and inherit voice `alloy`, producing a saved
// configuration that is silently wrong and that the controller has no reason to
// reject. A 400 on an incomplete transition is loud and correct; a Fish account
// silently voicing every segment with an OpenAI id is neither.
//
// So blanks are omitted only when nothing moved — the same-provider edit and the
// stale-form recovery both land on the provider the server already holds. On a
// genuine transition they are sent verbatim, which restores the rejection.

export interface CloudSaveDecision {
  provider: CloudProviderId;
  /** Omitted when blank AND nothing moved. Sent verbatim on a transition. */
  model?: string;
  /** Sent as '' only for the provider that accepts it, or on a transition. */
  voice?: string;
  /** Whether to send `apiKey: ''`. Compared against the NORMALIZED provider. */
  clearInlineKey: boolean;
  /** True when the provider actually changed, so a caller can explain a 400. */
  isTransition: boolean;
}

export function decideCloudSave(input: CloudSaveInput): CloudSaveDecision {
  const provider = normalizeCloudProvider(input.provider, input.savedProvider);
  const saved = String(input.savedProvider ?? '').trim();
  const model = String(input.model ?? '').trim();
  const voice = String(input.voice ?? '').trim();

  // Nothing moved when the normalised provider IS the stored one. That covers
  // both the ordinary same-provider edit and the stale-form case, because a stale
  // form normalises to the SAVED provider — so the server's stored model and
  // voice are already the right ones to keep.
  const isTransition = !!saved && saved !== provider;
  const mayOmitBlanks = !isTransition;

  return {
    provider,
    ...(model || !mayOmitBlanks ? { model } : {}),
    ...(voice || !mayOmitBlanks || allowsBlankVoice(provider) ? { voice } : {}),
    clearInlineKey: !!input.isFish || isTransition,
    isTransition,
  };
}