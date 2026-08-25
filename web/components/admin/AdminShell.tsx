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
  Mic,
} from 'lucide-react';
import { useAdminAuth } from '../../lib/adminAuth';
import type { SignInResult } from '../../lib/adminAuth';
import AdminQueryProvider from './AdminQueryProvider';
import { useStationFeed } from '../../hooks/useStationFeed';
import SignInForm from './SignInForm';
import NavidromeBanner from './NavidromeBanner';
import MusicStarvedBanner from './MusicStarvedBanner';
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
  // `tab` is the ?tab= value this item selects; `defaultTab` marks the one
  // shown when the URL carries no (or an unknown) tab. Route children leave
  // both unset.
  tab?: string;
  defaultTab?: boolean;
}

interface NavItem {
  href: string;
  id: string;
  label: string;
  icon: NavIcon;
  pill?: string;
  // The parent still links to its own page; the chevron toggles the sub-items.
  children?: NavSubItem[];
}

interface NavSection {
  label: string;
  items: NavItem[];
}

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
      {
        href: '/admin/shows',
        id: 'shows',
        label: 'Shows',
        icon: CalendarClock,
        children: [
          { href: '/admin/shows/schedule', id: 'shows-schedule', label: 'Schedule', icon: CalendarDays },
        ],
      },
      { href: '/admin/personas', id: 'personas', label: 'Personas', icon: Drama },
      { href: '/admin/skills', id: 'skills', label: 'Skills', icon: Sparkles },
      {
        href: '/admin/imaging',
        id: 'imaging',
        label: 'Imaging',
        icon: Podcast,
        children: [
          { href: '/admin/imaging?tab=jingles', id: 'imaging-jingles', label: 'Jingles', icon: Music, tab: 'jingles', defaultTab: true },
          { href: '/admin/imaging?tab=sfx', id: 'imaging-sfx', label: 'SFX', icon: AudioLines, tab: 'sfx' },
          { href: '/admin/imaging?tab=beds', id: 'imaging-beds', label: 'Beds', icon: Waves, tab: 'beds' },
          { href: '/admin/imaging?tab=voices', id: 'imaging-voices', label: 'Voices', icon: Mic, tab: 'voices' },
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

const FOOTER_LINKS: { href: string; label: string; icon: NavIcon; pill: string }[] = [
  { href: '/manual', label: 'Manual', icon: BookOpen, pill: '↗' },
  { href: 'https://discord.gg/vjVbVKnMBa', label: 'Discord', icon: MessageCircle, pill: '↗' },
];

// Playlists, DJ Doc, and Stations aren't sidebar items, so they're resolved
// explicitly; their crumb sections mirror where the rail stays lit.
function resolveCrumb(pathname: string | null): { section?: string; page: string } {
  if (pathname?.startsWith('/admin/playlists')) return { section: 'Programming', page: 'Playlists' };
  if (pathname?.startsWith('/admin/shows/schedule')) return { section: 'Programming', page: 'Schedule' };
  if (pathname?.startsWith('/admin/doctor')) return { section: 'Monitor', page: 'DJ Doc' };
  if (pathname?.startsWith('/admin/stations')) return { section: 'System', page: 'Stations' };
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

// Routes that take the whole inset — no max-width, no padding.
const FULL_BLEED_ROUTES = ['/admin/shows/schedule'];

export default function AdminShell({ children, defaultOpen = true }: AdminShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { auth, needsAuth, hydrated, signIn, signOut, adminFetch } = useAdminAuth();
  const fullBleed = !!pathname && FULL_BLEED_ROUTES.some(r => pathname.startsWith(r));
  // Navidrome down raises the starve banner too; show only the specific one.
  const [navidromeOk, setNavidromeOk] = useState(true);

  const handleSignIn = useCallback(
    async (user: string, pass: string): Promise<SignInResult> => {
      const res = await signIn(user, pass);
      if (res?.ok && pathname !== '/admin/dash') router.push('/admin/dash');
      return res;
    },
    [signIn, pathname, router],
  );

  // First-run redirect into the wizard. Public endpoint, no auth needed.
  useEffect(() => {
    if (!hydrated) return;
    if (pathname?.startsWith('/onboarding')) return;
    const API = (process.env.NEXT_PUBLIC_API_URL as string | undefined) || '/api';
    // admin-query-imperative: first-run-redirect
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
    <AdminQueryProvider key={auth}>
      <div className="admin-root paper">
        {/* Narrower than the shadcn 16rem default — the nav is short labels. */}
        <SidebarProvider defaultOpen={defaultOpen} style={{ '--sidebar-width': '13rem' } as CSSProperties}>
          <AdminSidebar pathname={pathname} onSignOut={signOut} adminFetch={adminFetch} />
          <SidebarInset className="min-w-0 bg-transparent">
            <TopBar pathname={pathname} />
            <NavidromeBanner adminFetch={adminFetch} onStatus={setNavidromeOk} />
            <MusicStarvedBanner adminFetch={adminFetch} suppressed={!navidromeOk} />
            <div
              className={
                fullBleed
                  ? 'flex w-full min-w-0 flex-1 flex-col'
                  : 'mx-auto w-full max-w-[1440px] min-w-0 px-6 py-6'
              }
            >
              {/* No y translate — vertical drift feels twitchy on a list of panels. */}
              <AnimatePresence mode="wait" initial={false}>
                <m.div
                  key={pathname}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.12 }}
                  className={fullBleed ? 'flex min-h-full flex-1 flex-col' : undefined}
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
    </AdminQueryProvider>
  );
}

// ⌘K / Ctrl+K panel jump list. The chord is a modifier combo, so it is safe to
// honour even while a field is focused (it never intercepts a bare keystroke).
function AdminCommandMenu() {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Toggling on auto-repeat would flicker the dialog while the chord is held.
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

function AdminSidebar({
  pathname,
  onSignOut,
  adminFetch,
}: {
  pathname: string | null;
  onSignOut: () => void;
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
}) {
  const { setOpenMobile, isMobile } = useSidebar();
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);
  // The shell lives in the persistent layout, so a client-side nav doesn't
  // remount it — the mobile Sheet would stay open over the new page.
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
          <span className="inline-flex size-5 shrink-0">
            <DiscMark size={20} />
          </span>
          <span className="text-[13px] font-extrabold tracking-[0.1em] text-ink uppercase group-data-[collapsible=icon]:hidden">
            SUB / WAVE
          </span>
        </Link>
        <span className="caption px-1 group-data-[collapsible=icon]:hidden">control center</span>
        <StationSwitcher adminFetch={adminFetch} onNavigate={closeOnMobileNav} />
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
        {/* A dropdown rather than an inline collapsible so it stays reachable
            when the rail is collapsed to icons. */}
        <SidebarMenu className="gap-1.5">
          <SidebarMenuItem>
            {/* Non-modal: a modal Radix menu locks body scroll, and the lock's
                15px scrollbar-compensation margin pulls the sticky top bar off
                the right edge while the menu is open. */}
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
          <div className="border-t border-dashed border-[var(--separator-strong)] px-1 pt-1.5 text-[10px] tracking-[0.18em] text-muted uppercase group-data-[collapsible=icon]:hidden">
            v{process.env.NEXT_PUBLIC_APP_VERSION}
          </div>
        ) : null}
      </SidebarFooter>
      <SidebarRail />

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

// Only ever ONE row may render this at a time (sub-items use their own
// highlight), or the shared-layoutId animation doubles up.
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

// In the icon-collapsed rail both the chevron and the sub-list hide (built into
// SidebarMenuAction / SidebarMenuSub), so the parent icon links straight through.
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

  // Tab-based groups share the parent page, so a child is active when the page
  // matches and its tab is the effective one (falling back to the group's
  // default). Route-based groups just prefix-match their child's own path.
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
  // Parent takes the pill only with no child selected; tab groups always have
  // one, so there the pill moves to the child.
  const parentActive = onSection && !hasActiveChild;

  const [open, setOpen] = useState(onSection);
  // The shell is persistent, so open state survives route changes — re-reveal
  // the group whenever a nav lands on one of its pages.
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

  // Pulse only on the false → true transition, not on steady-state polls.
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
    <header className="sticky top-0 z-20 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-[var(--line)] bg-[var(--sidebar)] px-4 py-2.5 sm:px-6">
      {/* Roomier hit box on a phone, where this is the only way back to the nav. */}
      <SidebarTrigger className="-ml-1 size-9 shrink-0 sm:size-7" />
      <Separator orientation="vertical" className="hidden h-5 sm:block" />
      {/* Hidden on mobile — space is tight next to the hamburger. */}
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
        <span className="h-4 w-px bg-separator-strong" />
        <Link
          href="/admin/doctor"
          className="inline-flex min-h-9 items-center gap-1.5 text-[var(--accent)] no-underline sm:min-h-0"
          title="DJ Doc — run a station health check and get the producer's review"
        >
          <BoothBuddy mood="onair" size={16} />
          <span className="caption">DJ Doc</span>
        </Link>
        <ThemeSwitcher variant="admin" />
        {/* modal={false} for the same reason as the sidebar's More menu — no
            body scroll lock, so no scrollbar-compensation margin shift. */}
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger
            className="caption inline-flex min-h-9 cursor-pointer items-center gap-1 text-muted focus:outline-none sm:min-h-0"
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
