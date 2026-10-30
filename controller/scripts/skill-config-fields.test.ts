// Unit tests for skills/config-fields.ts — the declaration a skill's tool.mjs
// makes about its own operator-editable knobs.
//
// The bug (issue #1300, bug 11): the News feed field was gated on a hardcoded
// `isNews: kind === 'news'` in routes/dj.ts, with the UI section gated on that
// flag. Export the News skill, rename it in the .md and the .zip, re-import: the
// skill loads, airs, and its tool still reads `config.feed` — but no form field
// exists to set one, so a second news source was impossible. Worse, saving the
// renamed skill from the admin form REWRITES its SKILL.md, which dropped any
// `feed:` line a hand-edit had put there.
//
// The fix moves the declaration into tool.mjs (which a duplicate copies
// verbatim), so the knobs travel with the skill rather than with its name.
//
// Run: `npm test -- skill-config-fields`.

import assert from 'node:assert/strict';
import {
  parseConfigFields,
  readConfigValues,
  coerceConfigValues,
  preservedFrontmatter,
  CONFIG_FIELDS_LIMIT,
} from '../src/skills/config-fields.js';

// The News built-in's actual declaration — the shape a duplicate inherits.
const NEWS_DECL = {
  feed: { type: 'url', label: 'News feed · RSS 2.0', placeholder: 'https://…/rss.xml' },
  feedMaxItems: { type: 'number', label: 'Max items', min: 1, max: 50, integer: true, placeholder: '10' },
};

// ── the reported bug: a renamed copy keeps its knobs ─────────────────────────

{
  const fields = parseConfigFields(NEWS_DECL);
  assert.equal(fields.length, 2, 'both news knobs are declared');
  assert.deepEqual(fields.map(f => f.key), ['feed', 'feedMaxItems'], 'declaration order is preserved');
  assert.equal(fields[0].type, 'url');
  assert.equal(fields[1].type, 'number');
  assert.equal(fields[1].min, 1);
  assert.equal(fields[1].max, 50);

  // The renamed duplicate: same tool.mjs, different slug. Nothing about the
  // parse depends on the skill's name.
  const values = readConfigValues(fields, {
    name: 'tech-news',
    label: 'Tech headlines',
    feed: 'https://example.com/tech.xml',
    feedMaxItems: '6',
  });
  assert.deepEqual(
    values,
    { feed: 'https://example.com/tech.xml', feedMaxItems: 6 },
    'a renamed skill reads its own feed back out of its own frontmatter',
  );
}

// A save round-trips the form values, so rewriting SKILL.md can't silently drop
// the feed line.
{
  const fields = parseConfigFields(NEWS_DECL);
  const out = coerceConfigValues(fields, { feed: 'https://example.com/rss.xml', feedMaxItems: '8' });
  assert.deepEqual(out, { feed: 'https://example.com/rss.xml', feedMaxItems: 8 });
}

// ── declaration sanitising: malformed narrows to nothing, never throws ───────

{
  assert.deepEqual(parseConfigFields(undefined), []);
  assert.deepEqual(parseConfigFields(null), []);
  assert.deepEqual(parseConfigFields('feed'), []);
  assert.deepEqual(parseConfigFields(['feed']), []);
  assert.deepEqual(parseConfigFields({ feed: 'https://…' }), [], 'a non-object declaration is dropped');
}

// Reserved frontmatter keys can't be redeclared — writeSkillFile emits those
// from its own typed fields, so a collision would write the line twice.
{
  const fields = parseConfigFields({
    label: { type: 'text' },
    cooldown: { type: 'text' },
    tags: { type: 'text' },
    feed: { type: 'url' },
  });
  assert.deepEqual(fields.map(f => f.key), ['feed'], 'only the non-reserved key survives');
}

// Bad keys are dropped; an unknown type degrades to text; a missing label is
// derived from the key.
{
  const fields = parseConfigFields({
    '2bad': { type: 'text' },
    'has-hyphen': { type: 'text' },
    apiBase: { type: 'wat' },
  });
  assert.deepEqual(fields.map(f => f.key), ['apiBase']);
  assert.equal(fields[0].type, 'text', 'unknown type degrades to text');
  assert.equal(fields[0].label, 'Api Base', 'label derived from the key');
}

// The per-skill cap holds.
{
  const decl: Record<string, unknown> = {};
  for (let i = 0; i < CONFIG_FIELDS_LIMIT + 5; i++) decl[`k${i}`] = { type: 'text' };
  assert.equal(parseConfigFields(decl).length, CONFIG_FIELDS_LIMIT);
}

// ── value validation is LOUD (the route turns a throw into a 400) ────────────

{
  const fields = parseConfigFields(NEWS_DECL);
  assert.throws(() => coerceConfigValues(fields, { feed: 'not-a-url' }), /http\(s\) URL/);
  assert.throws(() => coerceConfigValues(fields, { feed: 'file:///etc/passwd' }), /http\(s\) URL/);
  assert.throws(() => coerceConfigValues(fields, { feedMaxItems: 'ten' }), /must be a number/);
  assert.throws(() => coerceConfigValues(fields, { feedMaxItems: '0' }), /at least 1/);
  assert.throws(() => coerceConfigValues(fields, { feedMaxItems: '500' }), /at most 50/);
}

// An empty/cleared value omits the key entirely — that's how the operator
// deletes a frontmatter line.
{
  const fields = parseConfigFields(NEWS_DECL);
  assert.deepEqual(coerceConfigValues(fields, { feed: '', feedMaxItems: '  ' }), {});
}

// Undeclared keys in the body are ignored — a client can't write arbitrary
// frontmatter through this path.
{
  const fields = parseConfigFields(NEWS_DECL);
  const out = coerceConfigValues(fields, { feed: 'https://example.com/a.xml', requiresKey: 'EVIL', brief: 'x' });
  assert.deepEqual(out, { feed: 'https://example.com/a.xml' });
}

// A text value carrying newlines is folded, not written raw — a frontmatter
// line is one flat `key: value`.
{
  const fields = parseConfigFields({ note: { type: 'text' } });
  assert.deepEqual(coerceConfigValues(fields, { note: 'one\ntwo' }), { note: 'one two' });
}

// A skill with no declaration persists nothing, whatever the body says.
{
  assert.deepEqual(coerceConfigValues([], { feed: 'https://example.com/a.xml' }), {});
  assert.deepEqual(readConfigValues([], { feed: 'https://example.com/a.xml' }), {});
}

// readConfigValues: an unset knob is ABSENT rather than empty, so the UI can
// tell "never configured" from "configured blank".
{
  const fields = parseConfigFields(NEWS_DECL);
  assert.deepEqual(readConfigValues(fields, { name: 'news' }), {});
  assert.deepEqual(readConfigValues(fields, null), {});
  assert.deepEqual(readConfigValues(fields, { feed: '   ' }), {}, 'a blank line reads as unset');
  assert.deepEqual(
    readConfigValues(fields, { feedMaxItems: 'lots' }),
    {},
    'an unparseable number is dropped rather than surfaced as NaN',
  );
}

// ── the rewrite preserves what it doesn't own ────────────────────────────────
//
// writeSkillFile rebuilds SKILL.md from typed fields, so a line it doesn't emit
// is a line it deletes. preservedFrontmatter is what it carries through.

{
  const declared = ['feed', 'feedMaxItems'];

  // Keys the form owns are re-emitted from its own fields, never carried.
  assert.deepEqual(
    preservedFrontmatter(
      { name: 'news', label: 'News', cooldown: '90m', context: 'time', tags: 'factual', window: 'commute', requiresKey: 'X_KEY' },
      declared,
    ),
    [],
  );

  // A declared knob is the form's to write — including when the operator just
  // cleared it. Carrying it would resurrect a value they deleted.
  assert.deepEqual(preservedFrontmatter({ feed: 'https://example.com/a.xml' }, declared), []);

  // Anything else survives, in file order: a hand-authored knob the tool reads
  // straight off `config`, and `toolDescription`, which the loader owns but
  // writeSkillFile never emitted.
  assert.deepEqual(
    preservedFrontmatter({ label: 'News', apiBase: 'https://api.example.com', toolDescription: 'Fetch X.', feed: 'https://e.com/a.xml' }, declared),
    [['apiBase', 'https://api.example.com'], ['toolDescription', 'Fetch X.']],
  );

  // The load-bearing case: a tool.mjs that fails to import loads prompt-only, so
  // NOTHING is declared. Its saved values must still survive the save that
  // follows — otherwise fixing the syntax error can't bring them back.
  assert.deepEqual(
    preservedFrontmatter({ label: 'Tech news', feed: 'https://example.com/tech.xml', feedMaxItems: '6' }, []),
    [['feed', 'https://example.com/tech.xml'], ['feedMaxItems', '6']],
  );

  // Blank/absent lines aren't carried, and a value is folded to one flat line.
  assert.deepEqual(preservedFrontmatter({ apiBase: '   ' }, []), []);
  assert.deepEqual(preservedFrontmatter({ apiBase: 'a\nb' }, []), [['apiBase', 'a b']]);
  assert.deepEqual(preservedFrontmatter(null, []), []);
  assert.deepEqual(preservedFrontmatter({}, []), []);
}

// `brief` is reserved: the admin form always sends one, and the legacy
// top-level body shape would otherwise capture the whole brief into a
// frontmatter line.
{
  assert.deepEqual(parseConfigFields({ brief: { type: 'text' }, feed: { type: 'url' } }).map(f => f.key), ['feed']);
}

// ── number coercion is exact, not "leading digits" ───────────────────────────
{
  const fields = parseConfigFields(NEWS_DECL);
  // parseInt would have taken "12abc" as 12 and "2.7" as 2 — both silently not
  // what the operator typed.
  assert.throws(() => coerceConfigValues(fields, { feedMaxItems: '12abc' }), /must be a number/);
  assert.throws(() => coerceConfigValues(fields, { feedMaxItems: '2.7' }), /whole number/);
  assert.deepEqual(coerceConfigValues(fields, { feedMaxItems: '12' }), { feedMaxItems: 12 });

  // Without `integer`, a fractional value is legitimate.
  const loose = parseConfigFields({ ratio: { type: 'number', min: 0, max: 1 } });
  assert.deepEqual(coerceConfigValues(loose, { ratio: '0.25' }), { ratio: 0.25 });
  assert.throws(() => coerceConfigValues(loose, { ratio: '1.5' }), /at most 1/);

  // Reading back is exact too — a broken stored value is dropped rather than
  // truncated into a plausible-looking one.
  assert.deepEqual(readConfigValues(fields, { feedMaxItems: '12abc' }), {});
  assert.deepEqual(readConfigValues(loose, { ratio: '0.25' }), { ratio: 0.25 });
}

// A URL keeps exactly the value that passed validation. The URL parser drops
// CR/LF/TAB before parsing, so a pasted value with a stray newline validates —
// and would then be written folded to a space, i.e. a DIFFERENT url.
{
  const fields = parseConfigFields(NEWS_DECL);
  assert.deepEqual(
    coerceConfigValues(fields, { feed: 'https://example.com/a\n.xml' }),
    { feed: 'https://example.com/a.xml' },
  );
}

console.log('skill-config-fields.test.ts — all assertions passed');
