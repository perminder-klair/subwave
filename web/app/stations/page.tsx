import { AnimatedLink } from '@/components/ui/animated-link';
import StationCard from '@/components/stations/StationCard';
import StationMap from '@/components/stations/StationMap';
import { getAllStations, getStationStats } from '@/lib/stations';
import { stationSubmitUrl, reportStationUrl, COMMUNITY_REPO_URL } from '@/lib/repo';
import { pageMeta } from '@/lib/seo';

export const metadata = pageMeta({
  title: 'SUB/WAVE — Stations',
  description:
    'A directory of SUB/WAVE stations around the world. See who is on the air right now, and add your own with a pull request.',
  path: '/stations',
});

// Render per-request so the canonical/og:url pick up the runtime SITE_URL.
// The directory fetch keeps its own ISR revalidate window (explicit per-fetch
// options win over the force-dynamic no-store default).
export const dynamic = 'force-dynamic';

// Submission opens a GitHub Issue Form in the community catalog repo (no fork, no
// JSON). A workflow there turns the issue into a one-file PR. The old new-file
// editor link forced non-collaborators to fork the repo (discussion #296), so we
// route through an issue: anyone with a GitHub account can submit in one click.
const SUBMIT_URL = stationSubmitUrl();
// Report / takedown for a listed station — opens the report-station issue form.
const REPORT_URL = reportStationUrl();

export default async function StationsIndex() {
  const stations = await getAllStations();
  const { count, countries } = await getStationStats();

  return (
    <article>
      <header className="bs-news-hero">
        <p className="bs-eyebrow">THE NETWORK</p>
        <h1>Stations.</h1>
        <p>
          SUB/WAVE is self-hosted; anyone can run their own. Here&rsquo;s who&rsquo;s on
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
          href={`${COMMUNITY_REPO_URL}/blob/main/stations/README.md`}
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
          No stations on the directory yet. Be the first to add yours above.
        </p>
      )}

      <p className="bs-stations-report">
        Stations are run by their operators, not by SUB/WAVE.{' '}
        <AnimatedLink href={REPORT_URL} className="bs-link">
          Report a station or request a takedown
        </AnimatedLink>
        .
      </p>
    </article>
  );
}
