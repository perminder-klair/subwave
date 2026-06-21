// The setup-guide doc pages — order drives both the sidebar contents and
// the prev/next links. Kept in a plain module (no 'use client') so it can be
// imported by both the client nav and the server page components.
//
// The wizard lives at /onboarding; these are the deep documentation pages an
// operator reads through /setup (or from the wizard's "I'd rather read the
// docs" escape hatch).
export interface SetupPageEntry {
  href: string;
  label: string;
}

export const SETUP_PAGES: SetupPageEntry[] = [
  { href: '/setup', label: 'Overview' },
  { href: '/setup/prerequisites', label: 'Prerequisites' },
  { href: '/setup/quick-start', label: 'Quick Start' },
  { href: '/setup/manual', label: 'Manual Install' },
  { href: '/setup/unraid', label: 'Unraid' },
  { href: '/setup/development', label: 'Development' },
  { href: '/setup/updates', label: 'Updates & Help' },
];
