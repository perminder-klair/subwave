// The genre fold: normGenre and the word-aligned refinement test genreMatches
// and the query language's SQL share. A leaf (no imports), so library-db can
// register its SQL twin without pulling in show-filter and library.

// Normalised genre token — mirrors subsonic.resolveGenreName so the show's
// resolved tag and a track's tag compare the same way.
export function normGenre(s: unknown): string {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Normalised genre tag plus, per normalised character, whether it opens /
// closes a word in the ORIGINAL string (a word = a maximal alphanumeric run).
// Lets containment respect word boundaries after normGenre dropped separators.
function genreBoundaries(s: unknown): { norm: string; opens: boolean[]; closes: boolean[] } {
  const src = String(s ?? '').toLowerCase();
  const chars: string[] = [];
  const opens: boolean[] = [];
  let prevAlnum = false;
  for (const ch of src) {
    const alnum = (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9');
    if (!alnum) { prevAlnum = false; continue; }
    chars.push(ch);
    opens.push(!prevAlnum);
    prevAlnum = true;
  }
  // A char closes its word when it is last overall, or the next char opens one.
  const closes = chars.map((_, i) => i === chars.length - 1 || opens[i + 1]!);
  return { norm: chars.join(''), opens, closes };
}

// True when the target genre appears inside a track's raw genre tag, aligned
// to word boundaries. One-directional by design — see genreMatches.
export function tagCoversGenre(tag: string, target: string): boolean {
  const { norm, opens, closes } = genreBoundaries(tag);
  if (!norm || !target) return false;
  if (norm === target) return true;
  for (let i = norm.indexOf(target); i !== -1; i = norm.indexOf(target, i + 1)) {
    if (opens[i] && closes[i + target.length - 1]) return true;
  }
  return false;
}

// tagCoversGenre as data: every contiguous run of whole words in the tag,
// folded ("Punk Rock" → punk, punkrock, rock). A target covers the tag exactly
// when it is one of these, so a stored list answers it without this code.
export function genreRuns(tag: string): string[] {
  const { norm, opens, closes } = genreBoundaries(tag);
  const runs = new Set<string>();
  for (let i = 0; i < norm.length; i++) {
    if (!opens[i]) continue;
    for (let j = i; j < norm.length; j++) if (closes[j]) runs.add(norm.slice(i, j + 1));
  }
  return [...runs].sort();
}
