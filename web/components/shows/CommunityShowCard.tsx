import CatalogBrief from '@/components/ui/catalog-brief';
import Credit from '@/components/community/Credit';
import type { CommunityShow, EraWindow } from '@/lib/communityShows';
import s from './shows.module.css';

// The /shows showcase, drawn as the Programme Guide: an FM tuner dial with every
// show as a station on it, then each show as a printed listing with a spec sheet
// (an era ruler, an energy meter, its mood and genre filters). Each show is
// handed a dial position, not a real frequency: it's a way in, not a setting.
// Browse-only: installation happens in a station's admin console. Server
// components, no client JS.

const DIAL_LO = 88;
const DIAL_HI = 108;

/** Evenly spaced dial positions, landing on odd tenths like real FM. */
export function dialFrequencies(n: number): number[] {
  if (n <= 0) return [];
  const span = DIAL_HI - DIAL_LO - 2;
  return Array.from({ length: n }, (_, i) => {
    const raw = DIAL_LO + 1 + (n === 1 ? span / 2 : (span * i) / (n - 1));
    const tenth = Math.round(raw * 10);
    return (tenth % 2 === 0 ? tenth + 1 : tenth) / 10;
  });
}

// Render an era window as a compact label: "1988–1996", a single year when the
// bounds match, or an open-ended "1988–" / "–1996" when one side is null.
function formatEra({ fromYear, toYear }: EraWindow): string | null {
  if (fromYear == null && toYear == null) return null;
  if (fromYear != null && toYear != null) {
    return fromYear === toYear ? String(fromYear) : `${fromYear}–${toYear}`;
  }
  if (fromYear != null) return `${fromYear}–`;
  return `–${toYear}`;
}

const ERA_LO = 1950;
const ERA_HI = 2030;
const pct = (y: number) => ((Math.max(ERA_LO, Math.min(ERA_HI, y)) - ERA_LO) / (ERA_HI - ERA_LO)) * 100;

function EraRuler({ eras }: { eras: EraWindow[] }) {
  const windows = eras.filter((e) => e.fromYear != null || e.toYear != null);
  const labels = windows.map(formatEra).filter(Boolean).join(', ');
  return (
    <div className={s.spec}>
      <span className={s.specKey}>Era</span>
      <div className={s.ruler} aria-hidden="true">
        {windows.length === 0 && <span className={s.rulerAny} />}
        {/* The windows are geometry on a 0–100 track, so the bar is an SVG. */}
        <svg viewBox="0 0 100 10" preserveAspectRatio="none" className={s.rulerSvg} focusable="false">
          {windows.map((e, i) => {
            const from = pct(e.fromYear ?? ERA_LO);
            const to = pct(e.toYear ?? ERA_HI);
            return <rect key={i} x={from} y="0" width={Math.max(1.5, to - from)} height="10" className={s.rulerWindow} />;
          })}
        </svg>
      </div>
      <div className={s.rulerScale} aria-hidden="true">
        <span>’50</span>
        <span>’70</span>
        <span>’90</span>
        <span>’10</span>
        <span>’30</span>
      </div>
      <span className={s.specVal}>{labels || 'Any era'}</span>
    </div>
  );
}

const ENERGY = ['low', 'medium', 'high'] as const;

function EnergyMeter({ energies }: { energies: string[] }) {
  const any = energies.length === 0;
  const on = new Set(energies.map((e) => e.toLowerCase()));
  return (
    <div className={s.spec}>
      <span className={s.specKey}>Energy</span>
      <div className={s.energy} aria-hidden="true">
        {ENERGY.map((e) => (
          <span
            key={e}
            className={s.energyBar}
            data-on={any || on.has(e) ? '' : undefined}
            data-any={any ? '' : undefined}
          />
        ))}
      </div>
      <span className={s.specVal}>{any ? 'Any energy' : energies.join(' · ')}</span>
    </div>
  );
}

function trackCap(sec: number | null): string | null {
  if (!sec || sec <= 0) return null;
  const m = Math.floor(sec / 60);
  const r = Math.round(sec % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
}

export default function CommunityShowCard({ show, freq }: { show: CommunityShow; freq: number }) {
  const cap = trackCap(show.maxTrackSeconds);
  const floor = trackCap(show.minTrackLengthSeconds);
  return (
    <li className={s.listing} id={`show-${show.slug}`}>
      <div className={s.freqCol}>
        <span className={s.freqBand}>FM</span>
        <span className={s.freqNum}>{freq.toFixed(1)}</span>
        <ul className={s.flags} aria-label="Format">
          {show.programme && <li className={s.flagSolid}>Produced</li>}
          {show.banter && <li className={s.flagSolid}>Banter</li>}
          {show.filtersStrict && <li className={s.flag}>Strict filters</li>}
          {!show.programme && !show.banter && <li className={s.flag}>Free-form</li>}
        </ul>
      </div>

      <div className={s.body}>
        <h3 className={s.title}>{show.name}</h3>
        {show.programme && (
          <p className={s.runOrder} aria-label="Episode run order">
            <span>Intro</span>
            <span aria-hidden="true">→</span>
            <span>Hourly feature</span>
            <span aria-hidden="true">→</span>
            <span>Sign-off</span>
          </p>
        )}
        <CatalogBrief text={show.topic} />
        {(show.moods.length > 0 || show.genres.length > 0) && (
          <div className={s.filters}>
            {show.moods.length > 0 && (
              <ul className={s.chips} aria-label="Moods">
                {show.moods.map((m) => (
                  <li key={m} className={s.mood}>
                    {m}
                  </li>
                ))}
              </ul>
            )}
            {show.genres.length > 0 && (
              <ul className={s.chips} aria-label="Genres">
                {show.genres.map((g) => (
                  <li key={g} className={s.genre}>
                    {g}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <Credit by={show.submittedBy} added={show.dateAdded} modified={show.dateModified} />
      </div>

      <div className={s.sheet}>
        <EraRuler eras={show.eras} />
        <EnergyMeter energies={show.energies} />
        {(cap || floor) && (
          <div className={s.spec}>
            <span className={s.specKey}>Track length</span>
            <span className={s.specVal}>
              {floor && `≥ ${floor}`}
              {floor && cap && ' · '}
              {cap && `≤ ${cap}`}
            </span>
          </div>
        )}
      </div>
    </li>
  );
}

/** The tuner: a dial strip with every show as a station marker. */
export function ShowDial({ shows, freqs }: { shows: CommunityShow[]; freqs: number[] }) {
  // Positions come from layout, not inline styles: the scale and the stations
  // are each a space-between row, and dialFrequencies() spaces the shows evenly
  // from 5% to 95% of the dial, which is where the station row runs.
  return (
    <nav className={s.tuner} aria-label="Tune to a show">
      <div className={s.tunerFace}>
        <div className={s.tunerScroll}>
          <div className={s.tunerInner}>
            <div className={s.scale} aria-hidden="true">
              {[88, 92, 96, 100, 104, 108].map((n) => (
                <span key={n}>
                  <span>{n}</span>
                </span>
              ))}
            </div>
            <div className={s.ticks} aria-hidden="true" />
            <span className={s.needle} aria-hidden="true" />
            <ul className={s.stations}>
              {shows.map((sh, i) => {
                const f = freqs[i] ?? 98;
                return (
                <li
                  key={sh.slug}
                  className={s.station}
                  data-row={i % 2 === 0 ? 'a' : 'b'}
                >
                  <a href={`#show-${sh.slug}`} className={s.stationLink}>
                    <span className={s.stationFreq}>{f.toFixed(1)}</span>
                    <span className={s.stationName}>{sh.name}</span>
                  </a>
                </li>
                );
              })}
            </ul>
          </div>
        </div>
      </div>
      <div className={s.tunerKnobs} aria-hidden="true">
        <span className={s.knob} />
        <span className={s.tunerBrand}>SUB/WAVE · Programme tuner</span>
        <span className={s.knob} />
      </div>
    </nav>
  );
}
