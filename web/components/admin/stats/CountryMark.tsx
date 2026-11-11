// The country cell of Who's listening's Top countries: the flag, as the Dash's
// connections table shows it, sized to fill the column the code box used to.
// The name sits in the next column, so the whole cell is hidden from screen
// readers (they hear each country once, from the name) and the code moves to
// the hover, which sits on the hidden element so it is never read out either.
// A code with no flag (no ISO alpha-2 letters, e.g. Tor's T1) keeps the boxed
// code, so the row never shows an empty cell.
// Windows ships no flag glyphs and draws the two letters instead, as the Dash does.

import { countryFlag, countryName } from '../dash/types';

export default function CountryMark({ code }: { code: string }) {
  const flag = countryFlag(code);
  const title = code ? `${countryName(code)} (${code})` : undefined;
  if (!flag) {
    return (
      <span
        aria-hidden="true"
        className="border border-ink py-px text-center font-mono text-[10px] font-bold"
        title={title}
      >
        {code}
      </span>
    );
  }
  return (
    <span aria-hidden="true" className="text-center text-[18px] leading-none" title={title}>
      {flag}
    </span>
  );
}
