export interface SetupPageEntry {
  href: string;
  label: string;
}

export const SETUP_PAGES: SetupPageEntry[] = [
  { href: '/setup', label: 'Overview' },
  { href: '/setup/prerequisites', label: 'Prerequisites' },
  { href: '/setup/quick-start', label: 'Quick Start' },
  // Per-platform pages: the same install, with the host-shaped details that
  // differ (runtime, memory, arch, firewall, filesystem) spelled out.
  { href: '/setup/macos', label: 'macOS' },
  { href: '/setup/windows', label: 'Windows' },
  { href: '/setup/linux', label: 'Linux' },
  { href: '/setup/manual', label: 'Manual Install' },
  { href: '/setup/unraid', label: 'Unraid' },
  { href: '/setup/development', label: 'Development' },
  { href: '/setup/updates', label: 'Updates & Help' },
];
