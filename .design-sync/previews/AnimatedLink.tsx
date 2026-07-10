import * as React from 'react';
import { AnimatedLink } from 'sub-wave-web';

// NOTE: every variant decorates ON HOVER — the sliding underline, the lifting
// arrow glyph, and the block-fill sweep all animate from a scale-x-0 rest
// state, so a STATIC capture shows the link at rest (inheriting text colour,
// no decoration). Cells present each link standalone and prominent so it reads
// as an interactive link; the hover motion itself cannot be screenshotted.

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div style={{ display: 'grid', gap: 6, maxWidth: 420 }}>
    <span
      style={{
        fontSize: 10,
        letterSpacing: '0.22em',
        textTransform: 'uppercase',
        opacity: 0.55,
        fontWeight: 700,
      }}
    >
      {label}
    </span>
    <span style={{ fontSize: 17 }}>{children}</span>
  </div>
);

// underline — sliding underline sweeps in on hover (origin flips right→left).
export const Underline = () => (
  <Row label="variant · underline">
    <AnimatedLink href="/schedule">View the programme schedule</AnimatedLink>
  </Row>
);

// arrow — external-style link; an arrow glyph lifts in beside it on hover.
export const Arrow = () => (
  <Row label="variant · arrow">
    <AnimatedLink variant="arrow" href="https://getsubwave.com">
      Read the docs
    </AnimatedLink>
  </Row>
);

// highlight — block-fill sweep behind the text (mix-blend-difference) on hover.
export const Highlight = () => (
  <Row label="variant · highlight">
    <AnimatedLink variant="highlight" href="/landing">
      Switch to the broadsheet
    </AnimatedLink>
  </Row>
);

// In-context nav row — how the links sit in the site masthead/footer.
export const NavRow = () => (
  <nav style={{ display: 'flex', gap: 22, fontSize: 14 }}>
    <AnimatedLink href="/listen">Listen</AnimatedLink>
    <AnimatedLink href="/schedule">Schedule</AnimatedLink>
    <AnimatedLink href="/news">Dispatches</AnimatedLink>
    <AnimatedLink variant="arrow" href="mailto:hi@getsubwave.com">
      Contact
    </AnimatedLink>
  </nav>
);
