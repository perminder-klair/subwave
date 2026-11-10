import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AnimatedLink } from '@/components/ui/animated-link';
import { getAllNews, getNewsArticle, formatNewsDate } from '@/lib/news';
import JsonLd from '@/components/JsonLd';
import { absoluteUrl, canonicalUrl } from '@/lib/seo';

// Per-request like the rest of the news segment. Do NOT add
// generateStaticParams: it wins over the layout's force-dynamic and prerenders
// each article with the build-time (localhost) SITE_URL in its canonical.
export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const article = getNewsArticle(slug);
  if (!article) return { title: { absolute: 'SUB/WAVE — Dispatches' } };
  // Dispatches are shared product content — on a non-official install the
  // canonical/og:url point at getsubwave.com (see PageScope in lib/seo.ts).
  const url = canonicalUrl(`/news/${article.slug}`);
  return {
    // `absolute` opts out of the root layout's `%s · SUB/WAVE` template; the
    // brand is already appended here.
    title: { absolute: `${article.title} — SUB/WAVE` },
    description: article.excerpt,
    alternates: { canonical: url },
    openGraph: {
      title: article.title,
      description: article.excerpt,
      type: 'article',
      url,
      siteName: 'SUB/WAVE',
      publishedTime: article.date || undefined,
      modifiedTime: article.date || undefined,
      authors: article.author ? [article.author] : undefined,
    },
    // Restated so X shows the article title/excerpt instead of the sitewide card
    // inherited from the root layout (twitter:* wins over og:* there).
    twitter: {
      card: 'summary_large_image',
      title: article.title,
      description: article.excerpt,
    },
  };
}

export default async function NewsArticlePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const article = getNewsArticle(slug);
  if (!article) notFound();

  // getAllNews() is newest-first, so the entry before this one is newer and the
  // entry after is older.
  const all = getAllNews();
  const idx = all.findIndex((a) => a.slug === slug);
  const newer = idx > 0 ? all[idx - 1] : null;
  const older = idx >= 0 && idx < all.length - 1 ? all[idx + 1] : null;

  const articleJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'NewsArticle',
    headline: article.title,
    description: article.excerpt,
    datePublished: article.date || undefined,
    dateModified: article.date || undefined,
    author: { '@type': article.author ? 'Person' : 'Organization', name: article.author || 'SUB/WAVE' },
    publisher: {
      '@type': 'Organization',
      name: 'SUB/WAVE',
      logo: { '@type': 'ImageObject', url: absoluteUrl('/icons/512') },
    },
    image: absoluteUrl('/og'),
    // Matches the <link rel="canonical"> above; the icon/og image URLs stay
    // on this host because they are served from it.
    mainEntityOfPage: canonicalUrl(`/news/${article.slug}`),
  };

  return (
    <article className="bs-article">
      <JsonLd data={articleJsonLd} />
      <AnimatedLink href="/news" className="bs-news-back">
        &larr; All dispatches
      </AnimatedLink>

      <header className="bs-article-head">
        <p className="bs-eyebrow">{article.category}</p>
        <h1>{article.title}</h1>
        <p className="bs-article-deck">{article.excerpt}</p>
        <p className="bs-article-byline">
          <time dateTime={article.date}>{formatNewsDate(article.date)}</time>
          {article.author ? <span>{article.author}</span> : null}
          {article.version ? <span className="bs-news-ver">{article.version}</span> : null}
          <span className="bs-news-read">{article.readingMins} min read</span>
        </p>
      </header>

      <div className="bs-rule" />

      {/* HTML comes from committed web/content/news/*.md. Sanitise it if external input is added. */}
      <div
        className="bs-prose"
        dangerouslySetInnerHTML={{ __html: article.html }}
      />

      <nav className="bs-manual-pagelinks" aria-label="Dispatch pagination">
        {newer ? (
          <Link href={`/news/${newer.slug}`} className="bs-manual-pagelink" data-dir="prev">
            <span>&larr; Newer</span>
            {newer.title}
          </Link>
        ) : (
          <span />
        )}
        {older ? (
          <Link href={`/news/${older.slug}`} className="bs-manual-pagelink" data-dir="next">
            <span>Older &rarr;</span>
            {older.title}
          </Link>
        ) : null}
      </nav>
    </article>
  );
}
