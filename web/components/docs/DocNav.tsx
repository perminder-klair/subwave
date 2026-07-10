'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export interface DocNavPage {
  href: string;
  label: string;
}

export interface DocNavProps {
  pages: DocNavPage[];
  eyebrow: string;
  ariaLabel: string;
}

// Sticky sidebar table of contents shared by the /setup and /manual doc
// sections. Everything that differs between the two — the page list, the
// eyebrow heading, and the nav's accessible name — comes in as props.
export default function DocNav({ pages, eyebrow, ariaLabel }: DocNavProps) {
  const pathname = usePathname();

  return (
    <nav className="bs-manual-nav" aria-label={ariaLabel}>
      <p className="bs-eyebrow">{eyebrow}</p>
      <ol className="bs-manual-nav-list">
        {pages.map((page, i) => {
          const active = pathname === page.href;
          return (
            <li key={page.href}>
              <Link
                href={page.href}
                className="bs-manual-nav-link"
                data-active={active || undefined}
                aria-current={active ? 'page' : undefined}
              >
                <span className="bs-manual-nav-num">{String(i + 1).padStart(2, '0')}</span>
                {page.label}
              </Link>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
