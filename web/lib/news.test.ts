import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { formatNewsDate, getAllNews, getNewsArticle } from './news';

test('every committed dispatch parses and renders with the updated YAML and Markdown engines', () => {
  const articles = getAllNews();
  assert.ok(articles.length > 0);
  for (const meta of articles) {
    const article = getNewsArticle(meta.slug);
    assert.ok(article, meta.slug);
    assert.match(article.date, /^\d{4}-\d{2}-\d{2}$/, meta.slug);
    assert.equal(typeof article.html, 'string');
    assert.ok(article.html.length > 0, meta.slug);
  }
});

test('unquoted YAML dates and GFM tables survive the parser migration', () => {
  const slug = `parser-check-${process.pid}`;
  const file = path.join(process.cwd(), 'content', 'news', `${slug}.md`);
  writeFileSync(file, '---\ntitle: Parser check\ndate: 2026-10-07\ncategory: Fix\n---\n\n| Name | Value |\n| --- | --- |\n| **Station** | Ready |\n');
  try {
    const article = getNewsArticle(slug);
    assert.ok(article);
    assert.equal(article.date, '2026-10-07');
    assert.equal(formatNewsDate(article.date), 'October 7, 2026');
    assert.match(article.html, /<table>/);
    assert.match(article.html, /<strong>Station<\/strong>/);
  } finally {
    unlinkSync(file);
  }
});
