// The squeeze behind useSvgTextFit (sharedHooks.ts), kept free of React so
// its promises can be pinned by tests.

/** The DOM calls a fit makes on an SVG `<text>`. */
export interface FitText {
  readonly dataset: { readonly fit?: string };
  hasAttribute(name: string): boolean;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  getComputedTextLength(): number;
}

/** Squeeze each text that runs past its `data-fit` room. A row measures its
 *  natural length only with its old squeeze off, and taking each off just
 *  before measuring it forced a layout per row; so every squeeze comes off
 *  first, then every row is measured, then the overrunning ones are
 *  squeezed. Only rows that carry a squeeze lose it, and only rows that run
 *  over get one. A hidden row measures zero and is left unsqueezed. */
export function fitSvgTexts(texts: readonly FitText[]): void {
  for (const el of texts) {
    if (!el.hasAttribute('textLength')) continue;
    el.removeAttribute('textLength');
    el.removeAttribute('lengthAdjust');
  }
  const rooms = texts.map(el => Number(el.dataset.fit));
  const over = texts.map((el, i) => el.getComputedTextLength() > rooms[i]!);
  texts.forEach((el, i) => {
    if (!over[i]) return;
    el.setAttribute('textLength', String(rooms[i]));
    el.setAttribute('lengthAdjust', 'spacingAndGlyphs');
  });
}
