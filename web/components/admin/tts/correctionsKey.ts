/** A content-stable dependency value for a `corrections` array.
 *
 *  `VoicePreviewButton` keeps a rendered sample alive and invalidates it when the
 *  props that shape the audio change. `corrections` reaches that comparison as an
 *  ARRAY, and an array built fresh on every render cannot be a dependency: the
 *  effect would re-run each render and discard a sample the instant it finished
 *  rendering. So the dependency is a key derived from its CONTENTS.
 *
 *  The obvious `map(...).join('|')` is not injective, and both of its collisions
 *  mean a changed corrections payload silently reusing the previous render's audio:
 *
 *    [{from:'a', to:'b|c d'}]                 -> "a b|c d"
 *    [{from:'a', to:'b'}, {from:'c', to:'d'}]  -> "a b|c d"      identical
 *
 *    undefined -> ""    (use the station's saved corrections)
 *    []        -> ""    (use none)                          identical
 *
 *  The second pair matters because the server treats those two differently, so a
 *  key that merges them lets a preview claim to reflect "no corrections" while
 *  playing the saved ones.
 *
 *  `JSON.stringify` quotes and escapes, so separators inside a value cannot forge
 *  a boundary; `?? null` keeps `undefined` ("null") distinct from `[]` ("[]").
 *  It is not a canonical form — key order within an object follows insertion — and
 *  does not need to be: it only has to be stable for equal CONTENT, and distinct
 *  for content the server can tell apart.
 */
export interface CorrectionsPair { from: string; to: string }

export function correctionsKey(corrections: CorrectionsPair[] | undefined): string {
  return JSON.stringify(corrections ?? null);
}