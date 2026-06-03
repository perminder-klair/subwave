import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AnimatedLink } from '@/components/ui/animated-link';
import {
  getAllNews,
  getNewsArticle,
  getNewsSlugs,
  formatNewsDate,
} from '@/lib/news';
import JsonLd from '@/components/JsonLd';
import { absoluteUrl } from '@/lib/seo';

export function generateStaticParams() {
  return getNewsSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const article = getNewsArticle(slug);
  if (!article) return { title: 'SUB/WAVE — Dispatches' };
  const url = absoluteUrl(`/news/${article.slug}`);
  return {
    title: `${article.title} — SUB/WAVE`,
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
    mainEntityOfPage: absoluteUrl(`/news/${article.slug}`),
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

      {/*
        Trusted, first-party content: article.html is rendered from
        web/content/news/*.md — committed repo source, same trust level as this
        component. It is never user-submitted, so marked's raw-HTML passthrough
        is not an XSS vector here. If news ever accepts external input, sanitise
        (e.g. DOMPurify) before this point.
      */}
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
