import type { Metadata } from 'next';
import Link from 'next/link';
import { getAllNews, formatNewsDate, type NewsMeta } from '@/lib/news';

export const metadata: Metadata = {
  title: 'SUB/WAVE — Dispatches',
  description:
    'News and updates from the SUB/WAVE desk — new features, fixes, and short how-tos for running your own AI radio station.',
};

function Dateline({ a }: { a: NewsMeta }) {
  return (
    <p className="bs-news-dateline">
      <span className="bs-news-tag">{a.category}</span>
      <time dateTime={a.date}>{formatNewsDate(a.date)}</time>
      {a.version ? <span className="bs-news-ver">{a.version}</span> : null}
      <span className="bs-news-read">{a.readingMins} min read</span>
    </p>
  );
}

export default function NewsIndex() {
  const all = getAllNews();
  const lead = all[0];
  const rest = all.slice(1);

  return (
    <article>
      <header className="bs-news-hero">
        <p className="bs-eyebrow">THE WIRE</p>
        <h1>Dispatches.</h1>
        <p>
          News, fixes, and short how-tos from the SUB/WAVE desk. What changed,
          how to use it, and why it&rsquo;s worth your time.
        </p>
      </header>

      {lead ? (
        <Link href={`/news/${lead.slug}`} className="bs-news-lead">
          <Dateline a={lead} />
          <h2 className="bs-news-lead-headline">{lead.title}</h2>
          <p className="bs-news-lead-deck">{lead.excerpt}</p>
          <span className="bs-news-more">Read the full dispatch &rarr;</span>
        </Link>
      ) : null}

      {rest.length > 0 ? (
        <>
          <div className="bs-rule" />
          <ul className="bs-news-grid">
            {rest.map((a) => (
              <li key={a.slug} className="bs-news-item">
                <Dateline a={a} />
                <h3 className="bs-news-headline">
                  <Link href={`/news/${a.slug}`}>{a.title}</Link>
                </h3>
                <p className="bs-news-excerpt">{a.excerpt}</p>
                <Link href={`/news/${a.slug}`} className="bs-news-more">
                  Read &rarr;
                </Link>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {all.length === 0 ? (
        <p className="bs-news-empty">
          Nothing on the wire yet. New dispatches land here as the station grows.
        </p>
      ) : null}
    </article>
  );
}
