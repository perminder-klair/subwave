'use client';

import Link from 'next/link';
import {
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
  NavigationMenuTrigger,
} from '@/components/ui/navigation-menu';

const COMMUNITY = [
  { href: '/skills', tag: 'The Exchange', title: 'Skills', blurb: 'Segments to teach your DJ.' },
  { href: '/personas', tag: 'The Green Room', title: 'Personas', blurb: 'DJs to book for your booth.' },
  { href: '/shows', tag: 'The Programme Guide', title: 'Shows', blurb: 'Slots to fill your grid.' },
  { href: '/apps', tag: 'The Receivers', title: 'Apps', blurb: 'Players, bots and clients.' },
] as const;

export default function CommunityMenu() {
  return (
    <NavigationMenu className="bs-masthead-menu">
      <NavigationMenuList>
        <NavigationMenuItem>
          <NavigationMenuTrigger className="bs-masthead-link bs-masthead-trigger">
            Community
            <span aria-hidden="true" className="bs-masthead-caret">
              ▾
            </span>
          </NavigationMenuTrigger>

          <NavigationMenuContent className="bs-masthead-panel">
            <ul className="bs-masthead-panel-list">
              {COMMUNITY.map((c) => (
                <li key={c.href}>
                  <NavigationMenuLink asChild>
                    <Link href={c.href} className="bs-masthead-panel-item">
                      <span className="bs-masthead-panel-tag">{c.tag}</span>
                      <span className="bs-masthead-panel-title">{c.title}</span>
                      <span className="bs-masthead-panel-blurb">{c.blurb}</span>
                    </Link>
                  </NavigationMenuLink>
                </li>
              ))}
            </ul>
          </NavigationMenuContent>
        </NavigationMenuItem>
      </NavigationMenuList>
    </NavigationMenu>
  );
}
