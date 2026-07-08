import ManualPage from './ManualPage';
import CodeBlock from "@/components/CodeBlock";

export default function CustomSkills() {
  return (
    <ManualPage
      eyebrow="MANUAL · 06"
      title="Custom skills."
      intro="The things the DJ does between tracks (a weather check, a headline, a dig on the song playing) are skills. Seven ship built in, and you can edit any of them or add your own — from the admin Skills page or by dropping a folder into state/skills — with no code changes to the station."
      current="/manual/skills"
    >
      <section className="bs-section">
        <p className="bs-eyebrow">WHAT A SKILL IS</p>
        <h2>One thing: a between-track line.</h2>
        <p>
          A SUB/WAVE skill is a single between-track <em>spoken segment</em> — the DJ
          glances at something, then either says one short line over the music or stays
          quiet. The format borrows from{' '}
          <a href="https://github.com/anthropics/skills" target="_blank" rel="noreferrer">
            Anthropic&rsquo;s skills
          </a>{' '}
          (a <code className="bs-code-inline">SKILL.md</code> with YAML frontmatter and a
          markdown body, plus optional code), but the meaning is narrower. These don&rsquo;t
          process documents or run tasks; they decide what the DJ says next.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">THE LAYOUT</p>
        <h2>A folder under state/skills.</h2>
        <p>
          Drop a folder into <code className="bs-code-inline">state/skills/</code>. It needs a{' '}
          <code className="bs-code-inline">SKILL.md</code>; an optional{' '}
          <code className="bs-code-inline">tool.mjs</code> lets the segment look at live data
          before the DJ speaks.
        </p>
        <CodeBlock>{`state/skills/
  moon-phase/
    SKILL.md      # frontmatter (→ settings) + body (→ the DJ's brief)
    tool.mjs      # OPTIONAL: a data fetcher the DJ can call`}</CodeBlock>
        <p>
          A ready-to-copy example ships in the repo at{' '}
          <code className="bs-code-inline">docs/examples/skills/moon-phase</code>. Copy it
          into <code className="bs-code-inline">state/skills/</code> and hit{' '}
          <strong>Rescan</strong> on the admin Skills page.
        </p>
        <p>
          Prefer not to touch disk? The admin <strong>Skills</strong> page has a{' '}
          <strong>New skill</strong> button that writes the{' '}
          <code className="bs-code-inline">SKILL.md</code> for you, and lets you edit or
          delete custom skills in place. It&rsquo;s prompt-only — frontmatter plus the brief;
          a <code className="bs-code-inline">tool.mjs</code> data fetcher is still added on
          disk + Rescan.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">SKILL.md</p>
        <h2>Frontmatter, then the brief.</h2>
        <p>
          The frontmatter sets the skill&rsquo;s metadata; the markdown body <em>is</em> the
          brief the DJ follows: what to say, in what tone, and when to stay silent. Only a
          non-empty body is required; every key has a sensible default.
        </p>
        <CodeBlock>{`---
name: moon-phase          # the slug (defaults to the folder name)
label: Moon phase         # label shown in admin (defaults to a title-cased name)
cooldown: 6h              # min gap between auto firings — "90m" | "6h" | "2d" | "45" (minutes)
window: any               # "any" (default) | "commute" — commute hours only
context: time, festival   # OPTIONAL: "right now" fields it may mention (see below)
requiresKey: SOME_API_KEY # OPTIONAL: env var the skill needs; unset → stays inert
---
If tonight's moon is at a notable phase, work it into one short, in-character
line, the way a late-night presenter might glance out the window. Skip it when
the phase is unremarkable.`}</CodeBlock>
        <p className="text-muted">
          For a <em>new</em> skill the <code className="bs-code-inline">name</code> must be a
          lowercase slug that isn&rsquo;t a built-in kind; naming a folder after a built-in
          <em>edits</em> that one instead (see below). Bad frontmatter is logged and
          skipped, and never crashes the station.
        </p>
        <p className="text-muted">
          <code className="bs-code-inline">context:</code> is an allow-list of the &ldquo;right
          now&rdquo; fields the DJ may weave in — <code className="bs-code-inline">date</code>,{' '}
          <code className="bs-code-inline">clock</code>, <code className="bs-code-inline">time</code>,{' '}
          <code className="bs-code-inline">weather</code>, <code className="bs-code-inline">festival</code>,{' '}
          <code className="bs-code-inline">show</code>, <code className="bs-code-inline">listeners</code>.
          Leave it off and the skill gets everything <em>except</em> weather, which stays with
          the dedicated weather skill so the DJ doesn&rsquo;t staple the forecast to every break.
          Tick it back on (in the frontmatter, or per-field on the admin Edit sheet) where
          it&rsquo;s genuinely topical.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">EDITING THE BUILT-INS</p>
        <h2>The shipped skills are files too.</h2>
        <p>
          The seven built-ins — weather, news, now-playing digs, curiosity, album anniversaries,
          library deep-cuts, and web search — ship as read-only templates (under{' '}
          <code className="bs-code-inline">controller/src/skills/builtins/&lt;kind&gt;/</code>) and
          are seeded into <code className="bs-code-inline">state/skills/&lt;kind&gt;/</code> —
          both <code className="bs-code-inline">SKILL.md</code> <em>and</em>{' '}
          <code className="bs-code-inline">tool.mjs</code> — the first time the station boots.
          From then on they&rsquo;re ordinary editable skills: change the brief, cooldown,
          context, or label on the admin <strong>Skills</strong> page, and edit the{' '}
          <code className="bs-code-inline">tool.mjs</code> on disk + Rescan, exactly as you
          would for a skill you wrote. The seeder never overwrites a file that already exists,
          so your edits survive restarts and upgrades.
        </p>
        <p>
          A built-in still differs from a skill you add in three ways: it&rsquo;s enabled by
          default, it can be disabled but not deleted (delete its folder and the seeder
          restores it on the next boot), and its edit sheet has a{' '}
          <strong>↺ Reset to default</strong> that overwrites both files from the shipped
          template — the way back from a broken edit, and the way to pull in a newer
          image&rsquo;s <code className="bs-code-inline">tool.mjs</code>.
        </p>
        <p>
          The big one: <strong>News reads the BBC by default</strong>. Hit{' '}
          <strong>Edit</strong> on the News skill, paste your own RSS feed (any RSS 2.0 feed,
          though not Atom yet) and rewrite the brief in your station&rsquo;s
          voice, then Save. It&rsquo;s live on the next break, no restart.
        </p>
        <CodeBlock>{`---
name: news
label: News headlines
cooldown: 45m
feed: https://feeds.npr.org/1001/rss.xml   # any RSS 2.0 feed
feedMaxItems: 10
---
One fresh headline in a single sentence — in the station's voice,
not a newsreader's. Skip anything dull or stale; silence is fine.`}</CodeBlock>
        <p className="text-muted">
          The <code className="bs-code-inline">NEWS_FEED_URL</code> environment variable only
          seeds this file on the very first boot — after that the file (or the admin form)
          wins.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">tool.mjs — OPTIONAL</p>
        <h2>Let the DJ look before it speaks.</h2>
        <p>
          With a <code className="bs-code-inline">tool.mjs</code>, the DJ can fetch live data
          before deciding whether to air the line — the exact same mechanism the built-ins use
          (they&rsquo;re directories with a <code className="bs-code-inline">tool.mjs</code> too).
          Export a default function; return any JSON, and use{' '}
          <code className="bs-code-inline">{`{ available: false }`}</code> to tell the DJ
          there&rsquo;s nothing worth airing. The 3rd arg, <code className="bs-code-inline">services</code>,
          is the station facade — <code className="bs-code-inline">searchWeb</code>,{' '}
          <code className="bs-code-inline">library</code>, <code className="bs-code-inline">nowPlaying</code>,{' '}
          <code className="bs-code-inline">recentPlays</code>, <code className="bs-code-inline">onThisDay</code>,{' '}
          <code className="bs-code-inline">fetchHeadlines</code>, durable{' '}
          <code className="bs-code-inline">recall</code> — so a custom skill can reach as far as a built-in.
        </p>
        <CodeBlock>{`export default async function (ctx, state, services, config, input) {
  // ctx      — the moment: { time, weather, festival, dominantMood, clock }
  // state    — cross-tick memory (persists between firings)
  // services — the station facade (searchWeb, library, nowPlaying, onThisDay…)
  // config   — this skill's own SKILL.md frontmatter
  // input    — the agent's values for your declared inputs ({} if none)
  const artist = services.nowPlaying()?.artist;
  if (!artist) return { available: false };
  return { available: true, artist };
}

// OPTIONAL: gate the skill on a runtime condition (e.g. a search provider).
export const ready = (services) => services.searchReady();

// OPTIONAL: agent-steerable string params — the agent may pass a value or
// null for each; without this the tool is zero-arg (best for small models).
export const inputs = { query: 'what to search for; null for the default dig' };`}</CodeBlock>
        <p>
          The call is timeout-guarded and any error degrades cleanly to &ldquo;no
          data&rdquo;; a slow or broken skill can never hang the station. With no{' '}
          <code className="bs-code-inline">tool.mjs</code>, the skill writes from its brief
          alone — no live data to look at.
        </p>
        <div className="bs-callout">
          <div className="bs-eyebrow">IT RUNS YOUR CODE</div>
          <p>
            <code className="bs-code-inline">tool.mjs</code> executes inside the controller,
            the same trust model as installing a local tool. Only drop in code you&rsquo;ve
            read and trust.
          </p>
        </div>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">SHARING</p>
        <h2>Send one out, pull one in.</h2>
        <p>
          Wrote a skill worth passing on? On the admin <strong>Skills</strong> page, any
          prompt-only skill (no <code className="bs-code-inline">tool.mjs</code>) grows a{' '}
          <strong>Share to community</strong> button. It opens a prefilled GitHub issue; a
          workflow checks the slug and frontmatter and opens a one-file PR. Once that&rsquo;s
          merged the skill ships in the next controller image, so any station can pick it up —
          with your GitHub handle and the dates stamped on it (the Community list shows
          &ldquo;by @who · added · updated&rdquo; under each entry).
        </p>
        <p>
          The other direction is the <strong>Community</strong> button next to{' '}
          <strong>New skill</strong>. It lists the shipped catalog; <strong>Install</strong>{' '}
          drops a copy into <code className="bs-code-inline">state/skills/</code> — toggled
          off, for you to read before it airs. The catalog is prompt-only by design, so
          installing from it never runs anyone else&rsquo;s code.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">ZIP EXPORT / IMPORT</p>
        <h2>Hand a skill straight to another operator.</h2>
        <p>
          To pass a skill directly instead, the edit sheet has an{' '}
          <strong>↓ Export</strong> that streams a <code className="bs-code-inline">.zip</code>{' '}
          (the <code className="bs-code-inline">SKILL.md</code>, plus{' '}
          <code className="bs-code-inline">tool.mjs</code> if it has one). The Community modal
          has the matching <strong>Import .zip</strong>. Like everything else, an import lands
          disabled.
        </p>
        <div className="bs-callout">
          <div className="bs-eyebrow">A ZIP CAN CARRY CODE</div>
          <p>
            Unlike the reviewed catalog, an imported{' '}
            <code className="bs-code-inline">.zip</code> may include a{' '}
            <code className="bs-code-inline">tool.mjs</code> — the same trust as dropping a
            folder in by hand. When it does, the UI flags it on arrival; read the code before
            you enable it.
          </p>
        </div>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">GOING LIVE</p>
        <h2>Discovered, then enabled by you.</h2>
        <p>
          A freshly dropped skill appears on the admin <strong>Skills</strong> page toggled{' '}
          <strong>off</strong>. It can&rsquo;t air (by itself or via the DJ) until you
          enable it there. Dropping a folder never puts unreviewed content (or code) on air.
        </p>
        <p>
          Skills load at boot, and on demand via the <strong>Rescan state/skills</strong>{' '}
          button on that page, which picks up new folders and edits to{' '}
          <code className="bs-code-inline">SKILL.md</code> /{' '}
          <code className="bs-code-inline">tool.mjs</code> without a restart. Like the
          built-ins, a custom skill only fires autonomously when it&rsquo;s enabled{' '}
          <em>and</em> assigned to the persona on air (Personas page). <strong>Run now</strong>{' '}
          is an operator override that ignores the toggle, the persona, the frequency gate,
          and the cooldown.
        </p>
        <p className="text-muted">
          Full reference, including the example skill, lives in{' '}
          <code className="bs-code-inline">docs/custom-skills.md</code>.
        </p>
      </section>
    </ManualPage>
  );
}
