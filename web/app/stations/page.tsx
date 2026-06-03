import { AnimatedLink } from '@/components/ui/animated-link';
import StationCard from '@/components/stations/StationCard';
import StationMap from '@/components/stations/StationMap';
import { getAllStations, getStationStats } from '@/lib/stations';
import { pageMeta } from '@/lib/seo';

export const metadata = pageMeta({
  title: 'SUB/WAVE — Stations',
  description:
    'A directory of SUB/WAVE stations around the world. See who is on the air right now, and add your own with a pull request.',
  path: '/stations',
});

const REPO = 'https://github.com/perminder-klair/subwave';

// Pre-filled "new file" editor on GitHub — clicking opens a ready-to-edit
// station file, so a submission is fork → tweak → open PR. value= seeds the
// file body; filename= seeds the path (the contributor renames the slug).
const SUBMIT_TEMPLATE = `{
  "name": "Your Station",
  "url": "https://radio.example.com",
  "operator": "@yourhandle",
  "location": "City, Country",
  "country": "Country",
  "lat": 0,
  "lon": 0,
  "genre": "ambient / downtempo",
  "description": "One or two sentences about your station.",
  "featured": false,
  "submitted": "2026-06-04"
}
`;
const SUBMIT_URL =
  `${REPO}/new/main?filename=web/content/stations/your-station.json` +
  `&value=${encodeURIComponent(SUBMIT_TEMPLATE)}`;

export default function StationsIndex() {
  const stations = getAllStations();
  const { count, countries } = getStationStats();

  return (
    <article>
      <header className="bs-news-hero">
        <p className="bs-eyebrow">THE NETWORK</p>
        <h1>Stations.</h1>
        <p>
          SUB/WAVE is self-hosted &mdash; anyone can run their own. Here&rsquo;s who&rsquo;s on
          the air around the world. Tune in, or add your own station with a pull request.
        </p>
      </header>

      {count > 0 ? (
        <p className="bs-stat-strip">
          <span>
            <strong>{count}</strong> {count === 1 ? 'station' : 'stations'}
          </span>
          <span aria-hidden="true" className="bs-stat-sep">
            ·
          </span>
          <span>
            <strong>{countries}</strong> {countries === 1 ? 'country' : 'countries'}
          </span>
        </p>
      ) : null}

      <StationMap stations={stations} />

      <div className="bs-station-cta">
        <p className="bs-station-cta-copy">
          Running SUB/WAVE? Put your station on the map.
        </p>
        <AnimatedLink href={SUBMIT_URL} variant="arrow" className="bs-station-cta-link">
          Add your station
        </AnimatedLink>
        <AnimatedLink
          href={`${REPO}/blob/main/web/content/stations/README.md`}
          className="bs-station-cta-help"
        >
          How it works
        </AnimatedLink>
      </div>

      {stations.length > 0 ? (
        <ul className="bs-stations-grid">
          {stations.map((s) => (
            <StationCard key={s.slug} station={s} />
          ))}
        </ul>
      ) : (
        <p className="bs-news-empty">
          No stations on the directory yet. Be the first &mdash; add yours above.
        </p>
      )}
    </article>
  );
}
