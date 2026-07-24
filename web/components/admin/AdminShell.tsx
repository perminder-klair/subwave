'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { ComponentType, CSSProperties, ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, m } from 'motion/react';
import { useDynamicStyle } from '../../hooks/useDynamicStyle';
import {
  Radio,
  BarChart3,
  Disc3,
  CalendarClock,
  Drama,
  Sparkles,
  SlidersHorizontal,
  Terminal,
  BookOpen,
  Apple,
  Smartphone,
  Monitor,
  Users,
  Headphones,
  Plug,
  Coffee,
  MessageCircle,
  Podcast,
  Palette,
  LogOut,
  ChevronDown,
  ChevronRight,
  MoreHorizontal,
  ListMusic,
  Telescope,
  Clock,
  CalendarDays,
  Volume2,
  Music,
  AudioLines,
  Waves,
  RadioTower,
} from 'lucide-react';
import { useAdminAuth } from '../../lib/adminAuth';
import type { SignInResult } from '../../lib/adminAuth';
import { useStationFeed } from '../../hooks/useStationFeed';
import SignInForm from './SignInForm';
import NavidromeBanner from './NavidromeBanner';
import StationSwitcher from './StationSwitcher';
import OdometerNumber from '../OdometerNumber';
import BoothBuddy from '../BoothBuddy';
import ThemeSwitcher from '../ThemeSwitcher';
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
} from '../ui/command';
import { V3AlertDialog } from '../ui/alert-dialog';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from '../ui/sidebar';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '../ui/breadcrumb';
import { Separator } from '../ui/separator';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { DiscMark } from '../../lib/discMark';
import { animate as motionAnimate } from 'motion/react';

type NavIcon = ComponentType<{
  className?: string;
  size?: number;
  strokeWidth?: number;
  'aria-hidden'?: boolean | 'true' | 'false';
}>;

interface NavSubItem {
  href: string;
  id: string;
  label: string;
  icon: NavIcon;
  // Tab-based children (Moods / Imaging) share the parent's page and differ
  // only by ?tab=. `tab` is the query value this item selects; `defaultTab`
  // marks the one shown when the URL carries no (or an unknown) ?tab=. Route
  // children (Library → Playlists / Observatory) leave both unset.
  tab?: string;
  defaultTab?: boolean;
}

interface NavItem {
  href: string;
  id: string;
  label: string;
  icon: NavIcon;
  pill?: string;
  // Nested pages surfaced under a collapsible submenu (e.g. Library →
  // Playlists / Observatory). The parent still links to its own page; the
  // chevron toggles the sub-items.
  children?: NavSubItem[];
}

interface NavSection {
  label: string;
  items: NavItem[];
}

// Nav is grouped: what's happening now → what the station plays → the box itself.
const NAV_SECTIONS: NavSection[] = [
  {
    label: 'Monitor',
    items: [
      { href: '/admin/dash', id: 'dash', label: 'Dash', icon: Radio, pill: 'live' },
      { href: '/admin/stats', id: 'stats', label: 'Stats', icon: BarChart3 },
    ],
  },
  {
    label: 'Programming',
    items: [
      // Library owns a collapsible submenu — Playlists (/admin/playlists) and
      // the Observatory (/observatory) live under its wing. The parent still
      // links to /admin/library; the chevron opens/closes the sub-items (which
      // also stay reachable from the doorway cards inside the Library page).
      {
        href: '/admin/library',
        id: 'library',
        label: 'Library',
        icon: Disc3,
        children: [
          { href: '/admin/playlists', id: 'playlists', label: 'Playlists', icon: ListMusic },
          { href: '/observatory', id: 'observatory', label: 'Observatory', icon: Telescope },
        ],
      },
      { href: '/admin/shows', id: 'shows', label: 'Shows', icon: CalendarClock },
      { href: '/admin/personas', id: 'personas', label: 'Personas', icon: Drama },
      { href: '/admin/skills', id: 'skills', label: 'Skills', icon: Sparkles },
      // Imaging + Moods are single pages with ?tab= sections; the submenu
      // deep-links into each tab (see ImagingPanel / MoodsPanel).
      {
        href: '/admin/imaging',
        id: 'imaging',
        label: 'Imaging',
        icon: Podcast,
        children: [
          { href: '/admin/imaging?tab=jingles', id: 'imaging-jingles', label: 'Jingles', icon: Music, tab: 'jingles', defaultTab: true },
          { href: '/admin/imaging?tab=sfx', id: 'imaging-sfx', label: 'SFX', icon: AudioLines, tab: 'sfx' },
          { href: '/admin/imaging?tab=beds', id: 'imaging-beds', label: 'Beds', icon: Waves, tab: 'beds' },
        ],
      },
      {
        href: '/admin/moods',
        id: 'moods',
        label: 'Moods',
        icon: Palette,
        children: [
          { href: '/admin/moods?tab=vocab', id: 'moods-vocab', label: 'Vocabulary', icon: Palette, tab: 'vocab', defaultTab: true },
          { href: '/admin/moods?tab=moments', id: 'moods-moments', label: 'Moments', icon: Clock, tab: 'moments' },
          { href: '/admin/moods?tab=festivals', id: 'moods-festivals', label: 'Festivals', icon: CalendarDays, tab: 'festivals' },
          { href: '/admin/moods?tab=speech', id: 'moods-speech', label: 'Speech', icon: Volume2, tab: 'speech' },
        ],
      },
    ],
  },
  {
    label: 'System',
    items: [
      { href: '/admin/connect', id: 'connect', label: 'Connect', icon: Plug },
      { href: '/admin/stations', id: 'stations', label: 'Stations', icon: RadioTower },
      { href: '/admin/settings', id: 'settings', label: 'Settings', icon: SlidersHorizontal },
      { href: '/admin/debug', id: 'debug', label: 'Debug', icon: Terminal },
    ],
  },
];

interface AppLink {
  href: string;
  label: string;
  icon: NavIcon;
}

// Native player apps — surfaced from the top-bar "Listen" dropdown alongside
// the in-browser player.
const APP_LINKS: AppLink[] = [
  { href: 'https://apps.apple.com/app/sub-wave/id6778786696', label: 'iOS app', icon: Apple },
  {
    href: 'https://play.google.com/store/apps/details?id=com.getsubwave.app',
    label: 'Android app',
    icon: Smartphone,
  },
  {
    href: 'https://github.com/getsubwave/subwave-desktop/releases/latest',
    label: 'Desktop app',
    icon: Monitor,
  },
];

// Footer utility links (grouped with Sign out in the sidebar footer).
const FOOTER_LINKS: { href: string; label: string; icon: NavIcon; pill: string }[] = [
  { href: '/manual', label: 'Manual', icon: BookOpen, pill: '↗' },
  { href: 'https://discord.gg/vjVbVKnMBa', label: 'Discord', icon: MessageCircle, pill: '↗' },
];

// Section + page label for the top-bar breadcrumb. Playlists and DJ Doc aren't
// sidebar items (Playlists lives under Library's doorway, DJ Doc in the header
// strip), so they're resolved explicitly; Library stays lit in the rail while
// on Playlists, so the crumb mirrors that with the Programming section.
function resolveCrumb(pathname: string | null): { section?: string; page: string } {
  if (pathname?.startsWith('/admin/playlists')) return { section: 'Programming', page: 'Playlists' };
  if (pathname?.startsWith('/admin/doctor')) return { section: 'Monitor', page: 'DJ Doc' };
  for (const section of NAV_SECTIONS) {
    const item = section.items.find(n => pathname?.startsWith(n.href));
    if (item) return { section: section.label, page: item.label };
  }
  return { page: 'Admin' };
}

export interface AdminShellProps {
  children: ReactNode;
  // Resolved server-side from the `sidebar_state` cookie so the rail renders
  // collapsed/expanded on first paint without a hydration flash.
  defaultOpen?: boolean;
}

// Wraps every page under /admin. Renders the newsprint shell (shadcn Sidebar +
// sticky top bar) behind a sign-in gate. Children are admin panels that
// re-call useAdminAuth themselves to avoid prop-drilling the adminFetch.
export default function AdminShell({ children, defaultOpen = true }: AdminShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { auth, needsAuth, hydrated, signIn, signOut, adminFetch } = useAdminAuth();

  const handleSignIn = useCallback(
    async (user: string, pass: string): Promise<SignInResult> => {
      const res = await signIn(user, pass);
      if (res?.ok && pathname !== '/admin/dash') router.push('/admin/dash');
      return res;
    },
    [signIn, pathname, router],
  );

  // Probe an admin endpoint on first paint so a revoked token surfaces the
  // sign-in form proactively.
  useEffect(() => {
    if (!hydrated || !auth) return;
    let cancelled = false;
    (async () => {
      try {
        await adminFetch('/settings');
      } catch {}
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [hydrated, auth, adminFetch]);

  // First-run redirect — if the controller reports needsSetup, push the
  // operator straight into the wizard rather than dropping them on an admin
  // dashboard that's full of empty panels. Public endpoint, no auth needed.
  useEffect(() => {
    if (!hydrated) return;
    if (pathname?.startsWith('/onboarding')) return;
    const API = (process.env.NEXT_PUBLIC_API_URL as string | undefined) || '/api';
    fetch(`${API}/onboarding/status`)
      .then(r => (r.ok ? r.json() : null))
      .then((j: { needsSetup?: boolean } | null) => {
        if (j?.needsSetup) router.push('/onboarding');
      })
      .catch(() => {});
  }, [hydrated, pathname, router]);

  if (!hydrated) {
    return (
      <div className="admin-root paper flex min-h-screen items-center justify-center">
        <span className="caption">loading…</span>
      </div>
    );
  }

  // Authentication gate — covers both "no token yet" and "token rejected".
  if (!auth || needsAuth) {
    return (
      <div className="admin-root paper min-h-screen">
        <SignedOutHeader />
        <div className="mx-auto max-w-[1440px] px-7 py-12">
          <SignInForm onSubmit={handleSignIn} />
        </div>
      </div>
    );
  }

  return (
    <div className="admin-root paper">
      {/* Narrower rail than the shadcn 16rem default — the admin nav is short
          labels, so ~13rem reclaims horizontal room for the panels. */}
      <SidebarProvider defaultOpen={defaultOpen} style={{ '--sidebar-width': '13rem' } as CSSProperties}>
        <AdminSidebar pathname={pathname} onSignOut={signOut} />
        <SidebarInset className="min-w-0 bg-transparent">
          <TopBar pathname={pathname} />
          {/* Persistent connectivity warning — visible on every admin page
              whenever the live station can't reach Navidrome. Renders nothing
              when healthy. */}
          <NavidromeBanner adminFetch={adminFetch} />
          <div className="mx-auto w-full max-w-[1440px] min-w-0 px-5 py-4">
            {/* Panel route transitions — 120 ms cross-fade between admin pages
                keyed on pathname. No y translate (operator surface, vertical
                drift would feel twitchy on a list of panels). */}
            <AnimatePresence mode="wait" initial={false}>
              <m.div
                key={pathname}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.12 }}
              >
                {children}
              </m.div>
            </AnimatePresence>
          </div>
        </SidebarInset>
      </SidebarProvider>
      <AdminCommandMenu />
      {/* Toaster is mounted once at the app shell (app/layout.tsx). */}
    </div>
  );
}

// ⌘K / Ctrl+K command menu for the admin console — jump between panels without
// reaching for the sidebar. Reuses the shared cmdk-based CommandDialog, and is
// mounted from the authenticated admin shell so it is available on every admin
// route. The chord is a modifier combo, so it is safe to honour even while a
// field is focused (it never intercepts a bare keystroke).
function AdminCommandMenu() {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Toggling on auto-repeat would flicker the dialog while the chord is
      // held — fire once per press, like every other shortcut.
      if (e.repeat) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(o => !o);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const go = (href: string) => () => {
    setOpen(false);
    router.push(href);
  };

  // Flatten the sidebar nav (section items + their route/tab children) into one
  // searchable jump list.
  const targets: { href: string; label: string; group: string }[] = [];
  for (const section of NAV_SECTIONS) {
    for (const item of section.items) {
      targets.push({ href: item.href, label: item.label, group: section.label });
      for (const child of item.children ?? []) {
        targets.push({
          href: child.href,
          label: `${item.label} → ${child.label}`,
          group: section.label,
        });
      }
    }
  }

  return (
    <CommandDialog open={open} onOpenChange={setOpen} label="Admin command menu">
      <CommandInput placeholder="Jump to a panel…" />
      <CommandList>
        <CommandEmpty>No matches.</CommandEmpty>
        <CommandGroup heading="Go to">
          {targets.map(t => (
            <CommandItem key={`${t.href}::${t.label}`} value={t.label} onSelect={go(t.href)}>
              <span>{t.label}</span>
              <CommandShortcut>{t.group}</CommandShortcut>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

// The wordmark (SidebarHeader), grouped nav (SidebarContent), and the footer
// (Manual / Discord / Sign out, then the Ko-fi ask, then the version). Collapses
// to an icon rail; the mobile branch renders inside a Sheet drawer (handled by
// the Sidebar component).
function AdminSidebar({
  pathname,
  onSignOut,
}: {
  pathname: string | null;
  onSignOut: () => void;
}) {
  const { setOpenMobile, isMobile } = useSidebar();
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);
  // The shell lives in the persistent layout, so a client-side nav doesn't
  // remount it — the mobile Sheet would stay open over the new page. Close it
  // explicitly on any drawer link tap.
  const closeOnMobileNav = () => {
    if (isMobile) setOpenMobile(false);
  };
  return (
    <Sidebar collapsible="icon" className="border-sidebar-border">
      <SidebarHeader className="gap-1 px-2 py-3">
        <Link
          href="/admin/dash"
          onClick={closeOnMobileNav}
          className="flex items-center gap-2 px-1 no-underline"
        >
          {/* The station's disc mark — also serves as the collapsed rail logo. */}
          <span className="inline-flex size-5 shrink-0">
            <DiscMark size={20} />
          </span>
          <span className="text-[13px] font-extrabold tracking-[0.1em] text-ink uppercase group-data-[collapsible=icon]:hidden">
            SUB / WAVE
          </span>
        </Link>
        <span className="caption px-1 group-data-[collapsible=icon]:hidden">control center</span>
        {/* Multi-station: the shadcn "Teams"-style switcher — active station
            with a dropdown of the others; no-ops down to a single row on
            single-station installs. */}
        <StationSwitcher onNavigate={closeOnMobileNav} />
      </SidebarHeader>

      <SidebarContent className="gap-4 px-2 py-1">
        {NAV_SECTIONS.map(section => (
          <SidebarGroup key={section.label} className="p-0">
            <SidebarGroupLabel>{section.label}</SidebarGroupLabel>
            <SidebarMenu className="gap-1.5">
              {section.items.map(n =>
                n.children?.length ? (
                  <CollapsibleNavItem
                    key={n.id}
                    item={n}
                    pathname={pathname}
                    onNavigate={closeOnMobileNav}
                  />
                ) : (
                  <NavItemRow
                    key={n.id}
                    item={n}
                    pathname={pathname}
                    onNavigate={closeOnMobileNav}
                  />
                ),
              )}
            </SidebarMenu>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter className="gap-3 px-2 py-3">
        {/* Manual, Discord, and Sign out merged into one "More" submenu. A
            dropdown (rather than an inline collapsible) so it stays reachable
            when the rail is collapsed to icons. */}
        <SidebarMenu className="gap-1.5">
          <SidebarMenuItem>
            {/* Non-modal: a modal Radix menu locks body scroll, and the lock
                compensates for the removed scrollbar with a 15px right margin
                on <body> — which pulls the sticky top bar off the right edge
                for as long as the menu is open. A nav menu has no reason to
                trap scroll, so opt out and the shift never happens. */}
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton title="More">
                  <MoreHorizontal
                    className="shrink-0 opacity-80"
                    strokeWidth={2}
                    aria-hidden="true"
                  />
                  <span className="flex-1 truncate">More</span>
                  <ChevronDown className="ml-auto opacity-60" strokeWidth={2} aria-hidden="true" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="right" align="end" className="min-w-[11rem]">
                <DropdownMenuGroup>
                  {FOOTER_LINKS.map(link => {
                    const Icon = link.icon;
                    return (
                      <DropdownMenuItem asChild key={link.href}>
                        <Link
                          href={link.href}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={closeOnMobileNav}
                        >
                          <Icon aria-hidden="true" />
                          {link.label}
                        </Link>
                      </DropdownMenuItem>
                    );
                  })}
                  <DropdownMenuItem onClick={() => setConfirmingSignOut(true)}>
                    <LogOut aria-hidden="true" />
                    Sign out
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>

        {/* The Ko-fi ask — the one vermilion item on the rail. */}
        <SidebarMenu className="gap-1.5">
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              tooltip="Buy me a coffee"
              className="border-[color-mix(in_oklab,var(--accent)_55%,var(--line))] text-[var(--accent)] hover:border-[var(--accent)]"
            >
              <Link href="https://ko-fi.com/pklair" target="_blank" rel="noopener noreferrer">
                <Coffee className="shrink-0 opacity-80" strokeWidth={2} aria-hidden="true" />
                <span className="flex-1 truncate">Buy me a coffee</span>
              </Link>
            </SidebarMenuButton>
            <SidebarMenuBadge className="border-[var(--accent)] text-[var(--accent)]">
              ♥
            </SidebarMenuBadge>
          </SidebarMenuItem>
        </SidebarMenu>

        {process.env.NEXT_PUBLIC_APP_VERSION ? (
          <div className="border-t border-dashed border-[var(--separator-strong)] px-1 pt-3 text-[10px] tracking-[0.18em] text-muted uppercase group-data-[collapsible=icon]:hidden">
            v{process.env.NEXT_PUBLIC_APP_VERSION}
          </div>
        ) : null}
      </SidebarFooter>
      <SidebarRail />

      {/* Sign out drops the cached credentials — worth a confirm, matching the
          dash's skip-track dialog. */}
      <V3AlertDialog
        open={confirmingSignOut}
        onOpenChange={setConfirmingSignOut}
        title="Sign out"
        description="Sign out of the admin console? You'll need the operator credentials to get back in."
        confirmLabel="sign out"
        danger
        onConfirm={onSignOut}
      />
    </Sidebar>
  );
}

// The filled active pill, morphed across nav rows via a shared layoutId — same
// trick as DotRail. Only ever ONE row renders it at a time (sub-items use their
// own subtler highlight), so the layout animation never doubles up.
function NavActiveBg() {
  return (
    <m.span
      layoutId="admin-nav-active"
      className="absolute inset-0 z-0 bg-ink"
      initial={false}
      transition={{ type: 'spring', stiffness: 380, damping: 32 }}
      aria-hidden="true"
    />
  );
}

// A plain (childless) nav row.
function NavItemRow({
  item,
  pathname,
  onNavigate,
}: {
  item: NavItem;
  pathname: string | null;
  onNavigate: () => void;
}) {
  const active = !!pathname && pathname.startsWith(item.href);
  const Icon = item.icon;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={active} tooltip={item.label}>
        <Link href={item.href} onClick={onNavigate}>
          {active && <NavActiveBg />}
          <Icon className="relative z-[1] shrink-0 opacity-80" strokeWidth={2} aria-hidden="true" />
          <span className="relative z-[1] flex-1 truncate">{item.label}</span>
        </Link>
      </SidebarMenuButton>
      {item.pill && <SidebarMenuBadge>{item.pill}</SidebarMenuBadge>}
    </SidebarMenuItem>
  );
}

// A nav row that owns a collapsible submenu (Library → Playlists / Observatory).
// The parent button still links to its own page; a chevron action toggles the
// sub-items open/closed. The group auto-opens whenever the operator is on the
// parent or any of its child pages. In the icon-collapsed rail both the chevron
// and the sub-list hide (built into SidebarMenuAction / SidebarMenuSub), so the
// parent icon just links straight through.
function CollapsibleNavItem({
  item,
  pathname,
  onNavigate,
}: {
  item: NavItem;
  pathname: string | null;
  onNavigate: () => void;
}) {
  const children = item.children ?? [];
  const searchParams = useSearchParams();

  // Tab-based groups (Moods / Imaging) share the parent page and select a
  // section via ?tab=; resolve the effective tab (falling back to the group's
  // default when the URL has none/unknown), then a child is active when the
  // page matches and its tab is the effective one. Route-based groups (Library)
  // just prefix-match their child's own path.
  const tabChildren = children.filter(c => c.tab != null);
  const validTabs = tabChildren.map(c => c.tab as string);
  const rawTab = searchParams.get('tab');
  const effectiveTab =
    rawTab && validTabs.includes(rawTab)
      ? rawTab
      : (tabChildren.find(c => c.defaultTab)?.tab ?? null);
  const childActive = (sub: NavSubItem): boolean =>
    sub.tab != null
      ? pathname === item.href && sub.tab === effectiveTab
      : !!pathname && pathname.startsWith(sub.href);

  const hasActiveChild = children.some(childActive);
  const onSection = (!!pathname && pathname.startsWith(item.href)) || hasActiveChild;
  // Parent shows the filled pill only on its own page with no child selected
  // (Library's overview). Tab groups always have a child selected, so the pill
  // moves to the child and the parent stays a plain, open group header.
  const parentActive = onSection && !hasActiveChild;

  const [open, setOpen] = useState(onSection);
  // Reveal the group whenever a nav lands on one of its pages (the shell is
  // persistent, so the state survives across route changes otherwise).
  useEffect(() => {
    if (onSection) setOpen(true);
  }, [onSection]);
  const Icon = item.icon;
  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <SidebarMenuItem>
        <SidebarMenuButton asChild isActive={parentActive} tooltip={item.label}>
          <Link href={item.href} onClick={onNavigate}>
            {parentActive && <NavActiveBg />}
            <Icon
              className="relative z-[1] shrink-0 opacity-80"
              strokeWidth={2}
              aria-hidden="true"
            />
            <span className="relative z-[1] flex-1 truncate">{item.label}</span>
          </Link>
        </SidebarMenuButton>
        <CollapsibleTrigger asChild>
          <SidebarMenuAction
            className="z-[2] transition-transform data-[state=open]:rotate-90"
            aria-label={`Toggle ${item.label} submenu`}
          >
            <ChevronRight strokeWidth={2} aria-hidden="true" />
          </SidebarMenuAction>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub className="mt-1">
            {children.map(sub => {
              const SubIcon = sub.icon;
              return (
                <SidebarMenuSubItem key={sub.id}>
                  <SidebarMenuSubButton asChild isActive={childActive(sub)}>
                    <Link href={sub.href} onClick={onNavigate}>
                      <SubIcon aria-hidden="true" />
                      <span className="truncate">{sub.label}</span>
                    </Link>
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
              );
            })}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  );
}

// Sticky top bar — sidebar toggle, breadcrumb, and the live-station strip.
function TopBar({ pathname }: { pathname: string | null }) {
  const { section, page } = resolveCrumb(pathname);
  const { nowPlaying, listeners } = useStationFeed();
  const onAir = !!nowPlaying?.title;
  const listenersObj =
    listeners && typeof listeners === 'object'
      ? (listeners as { current?: number; count?: number })
      : null;
  const count =
    listenersObj?.current ??
    listenersObj?.count ??
    (typeof listeners === 'number' ? listeners : null);

  const dotRef = useRef<HTMLSpanElement>(null);
  useDynamicStyle(dotRef, {
    background: onAir ? 'var(--accent)' : 'var(--muted)',
    boxShadow: onAir
      ? '0 0 0 3px color-mix(in oklab, var(--accent) 20%, transparent)'
      : 'none',
  });

  // Pulse the dot when onAir flips false → true (track just started). We
  // don't pulse on the steady-state polls — only on transitions.
  const wasOnAirRef = useRef(onAir);
  useEffect(() => {
    if (onAir && !wasOnAirRef.current && dotRef.current) {
      motionAnimate(
        dotRef.current,
        { scale: [1.4, 1] },
        { duration: 0.18, ease: [0.2, 0.7, 0.2, 1] },
      );
    }
    wasOnAirRef.current = onAir;
  }, [onAir]);

  return (
    <header className="sticky top-0 z-20 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-ink bg-[var(--card-bg)] px-4 py-2.5 sm:px-6">
      <SidebarTrigger className="-ml-1 shrink-0" />
      <Separator orientation="vertical" className="hidden h-5 sm:block" />
      {/* Breadcrumb text is hidden on mobile — space is tight next to the
          hamburger, and the current page is already obvious from the drawer. */}
      <Breadcrumb className="hidden sm:block">
        <BreadcrumbList className="gap-1.5 text-[10px] tracking-[0.28em] uppercase sm:gap-2">
          {section && (
            <>
              <BreadcrumbItem className="text-muted">{section}</BreadcrumbItem>
              <BreadcrumbSeparator className="text-muted">/</BreadcrumbSeparator>
            </>
          )}
          <BreadcrumbItem>
            <BreadcrumbPage className="font-bold text-ink">{page}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <span className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-2 text-[10px] tracking-[0.22em] text-ink uppercase">
        {/* Live dot only — the on-air/off-air word is dropped; the dot's colour
            (accent when live, muted when not) already carries the state. */}
        <span
          ref={dotRef}
          className="size-2 rounded-full bg-[var(--accent)]"
          aria-label={onAir ? 'on air' : 'off air'}
          title={onAir ? 'on air' : 'off air'}
        />
        {count != null && (
          <>
            <span className="h-4 w-px bg-separator-strong" />
            <span
              className="inline-flex items-center gap-1"
              aria-label={`${count} listening`}
              title={`${count} listening`}
            >
              <OdometerNumber value={count} />
              <Users size={13} strokeWidth={2} aria-hidden="true" />
            </span>
          </>
        )}
        {/* DJ Doc — the primary entry point lives here in the header, right
            after the listener count, with the booth buddy in its on-air mood. */}
        <span className="h-4 w-px bg-separator-strong" />
        <Link
          href="/admin/doctor"
          className="inline-flex items-center gap-1.5 text-[var(--accent)] no-underline"
          title="DJ Doc — run a station health check and get the producer's review"
        >
          <BoothBuddy mood="onair" size={16} />
          <span className="caption">DJ Doc</span>
        </Link>
        <ThemeSwitcher variant="admin" />
        {/* Listen — a menu grouping the in-browser player with the native apps. */}
        {/* modal={false} for the same reason as the sidebar's More menu — no
            body scroll lock, so no scrollbar-compensation margin shift. */}
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger
            className="caption inline-flex cursor-pointer items-center gap-1 text-muted focus:outline-none"
            aria-label="Listen and get the app"
            title="Listen"
          >
            <Headphones size={15} strokeWidth={2} aria-hidden="true" />
            <ChevronDown size={11} strokeWidth={2} aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[11rem]">
            <DropdownMenuGroup>
              <DropdownMenuItem asChild>
                <Link href="/listen" target="_blank" rel="noopener noreferrer">
                  <Headphones aria-hidden="true" />
                  Listen in browser
                </Link>
              </DropdownMenuItem>
              {APP_LINKS.map(app => {
                const Icon = app.icon;
                return (
                  <DropdownMenuItem asChild key={app.href}>
                    <a href={app.href} target="_blank" rel="noopener noreferrer">
                      <Icon aria-hidden="true" />
                      {app.label}
                    </a>
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
    </header>
  );
}

// Slim header for the signed-out gate — no sidebar behind it.
function SignedOutHeader() {
  return (
    <header className="flex items-center gap-3 border-b border-ink bg-[var(--card-bg)] px-4 py-2.5 sm:px-7">
      <span className="text-[13px] font-extrabold tracking-[0.1em] text-ink uppercase">
        SUB / WAVE
      </span>
      <span className="caption text-muted">· admin</span>
      <span className="ml-auto flex items-center gap-3">
        <ThemeSwitcher variant="admin" />
        <Link
          href="/listen"
          target="_blank"
          rel="noopener noreferrer"
          className="caption inline-flex items-center text-muted no-underline"
          aria-label="Open the player"
          title="Listen"
        >
          <Headphones size={15} strokeWidth={2} aria-hidden="true" />
        </Link>
      </span>
    </header>
  );
}

