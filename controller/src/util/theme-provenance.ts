// Which theme level decided the theme on screen, published on the wire (#1300
// bug 12). The on-air show's themeId outranks settings.theme.active; a browser's
// own localStorage override is resolved client-side and not modelled here.
//
// The public contract: `active` keeps its old value in every case, a show wins
// ONLY if its themeId still resolves to a known theme, and `activeShow` is null
// rather than absent when the station default wins.

/** The subset of a resolved show this read touches. */
interface ActiveShowLike {
  id?: unknown;
  name?: unknown;
  themeId?: unknown;
}

/** The show that outranked the station default, as published. */
interface ProvenanceShow {
  id: string;
  name: string;
  themeId: string;
}

interface ThemeProvenance {
  /** The effective theme — what a client should actually paint. Unchanged. */
  active: string;
  /** Which level decided `active`. */
  activeSource: 'show' | 'station';
  /** settings.theme.active, i.e. what admin's station picker sets. */
  stationDefault: string;
  /** Null — never absent — when the station default won. */
  activeShow: ProvenanceShow | null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** `themeIds` is every theme the controller knows (built-ins + state/themes);
 * a show's pin is honoured only if it is in that set. */
export function resolveThemeProvenance(args: {
  stationDefault: string;
  activeShow?: ActiveShowLike | null;
  themeIds: Iterable<string>;
}): ThemeProvenance {
  const { stationDefault } = args;
  const known = new Set(args.themeIds);
  const show = args.activeShow ?? null;
  const showThemeId = str(show?.themeId);
  // A stale pin (theme deleted) falls back to the station default, as getTheme()
  // does. Narrowing to the show OBJECT keeps the rest free of `!` assertions.
  const winner = show && showThemeId && known.has(showThemeId) ? show : null;

  return {
    active: winner ? showThemeId : stationDefault,
    activeSource: winner ? 'show' : 'station',
    stationDefault,
    activeShow: winner
      ? { id: str(winner.id), name: str(winner.name), themeId: showThemeId }
      : null,
  };
}
