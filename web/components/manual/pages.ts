// The manual's page list — order drives both the sidebar contents and the
// prev/next links. Kept in a plain module (no 'use client') so it can be
// imported by both the client nav and the server page components.
export interface ManualPageEntry {
  href: string;
  label: string;
}

export const MANUAL_PAGES: ManualPageEntry[] = [
  { href: '/manual', label: 'Overview' },
  { href: '/manual/getting-started', label: 'Getting Started' },
  { href: '/manual/requests', label: 'Making Requests' },
  { href: '/manual/clients', label: 'Listen With' },
  { href: '/manual/shortcuts', label: 'Keyboard Shortcuts' },
  { href: '/manual/dj', label: 'How the DJ Works' },
  { href: '/manual/admin', label: 'Admin & Settings' },
  { href: '/manual/themes', label: 'Themes' },
  { href: '/manual/cli', label: 'The Operator CLI' },
  { href: '/manual/llm', label: 'Models & Tokens' },
  { href: '/manual/mcp', label: 'Agent Access' },
  { href: '/manual/faq', label: 'FAQ' },
];
