'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { ComponentType, ReactNode } from 'react';
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
} from 'lucide-react';
import { useAdminAuth } from '../../lib/adminAuth';
import type { SignInResult } from '../../lib/adminAuth';
import { useStationFeed } from '../../hooks/useStationFeed';
import SignInForm from './SignInForm';
import NavidromeBanner from './NavidromeBanner';
import OdometerNumber from '../OdometerNumber';
import BoothBuddy from '../BoothBuddy';
import ThemeSwitcher from '../ThemeSwitcher';
import { Toaster } from '../ui/toaster';
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
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from '../ui/sidebar';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '../ui/breadcrumb';
import { Separator } from '../ui/separator';
import { cn } from '@/lib/cn';
import { animate as motionAnimate } from 'motion/react';

type NavIcon = ComponentType<{
  className?: string;
  size?: number;
  strokeWidth?: number;
  'aria-hidden'?: boolean | 'true' | 'false';
}>;

interface NavItem {
  href: string;
  id: string;
  label: string;
  icon: NavIcon;
  pill?: string;
}

interface NavSection {
  label: string;
  items: NavItem[];
}

// Nav is grouped: what's happening now → what the station plays → the box itself.
const NAV_SECTIONS: NavSection[] = [
  {
    label: 'Monitor',
    items: [{ href: '/admin/dash', id: 'dash', label: 'Dash', icon: Radio, pill: 'live' }],
  },
  {
    label: 'Programming',
    items: [
      // Playlists (/admin/playlists) and the Observatory (/observatory) are
      // reached from doorways inside Library — not top-level nav items.
      { href: '/admin/library', id: 'library', label: 'Library', icon: Disc3 },
      { href: '/admin/shows', id: 'shows', label: 'Shows', icon: CalendarClock },
      { href: '/admin/personas', id: 'personas', label: 'Personas', icon: Drama },
      { href: '/admin/skills', id: 'skills', label: 'Skills', icon: Sparkles },
      { href: '/admin/imaging', id: 'imaging', label: 'Imaging', icon: Podcast },
    ],
  },
  {
    label: 'System',
    items: [
      { href: '/admin/stats', id: 'stats', label: 'Stats', icon: BarChart3 },
      { href: '/admin/connect', id: 'connect', label: 'Connect', icon: Plug },
      { href: '/admin/settings', id: 'settings', label: 'Settings', icon: SlidersHorizontal },
      { href: '/admin/debug', id: 'debug', label: 'Debug', icon: Terminal },
    ],
  },
];

interface ExternalLink {
  href: string;
  label: string;
  icon: NavIcon;
  pill: string;
  // The Ko-fi ask — the one vermilion item on the rail so it reads as a
  // request, not another utility link.
  accent?: boolean;
}

const EXTERNAL_LINKS: ExternalLink[] = [
  { href: '/manual', label: 'Manual', icon: BookOpen, pill: '↗' },
  {
    href: 'https://apps.apple.com/app/sub-wave/id6778786696',
    label: 'iOS app',
    icon: Apple,
    pill: '↗',
  },
  {
    href: 'https://play.google.com/store/apps/details?id=com.getsubwave.app',
    label: 'Android app',
    icon: Smartphone,
    pill: '↗',
  },
  {
    href: 'https://github.com/getsubwave/subwave-desktop/releases/latest',
    label: 'Desktop app',
    icon: Monitor,
    pill: '↗',
  },
  { href: 'https://discord.gg/vjVbVKnMBa', label: 'Discord', icon: MessageCircle, pill: '↗' },
  { href: 'https://ko-fi.com/pklair', label: 'Buy me a coffee', icon: Coffee, pill: '♥', accent: true },
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
      <SidebarProvider defaultOpen={defaultOpen}>
        <AdminSidebar pathname={pathname} />
        <SidebarInset className="min-w-0 bg-transparent">
          <TopBar pathname={pathname} onSignOut={signOut} />
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
      <Toaster />
    </div>
  );
}

// The wordmark (SidebarHeader), grouped nav (SidebarContent), and external
// links + version foot (SidebarFooter). Collapses to an icon rail; the mobile
// branch renders inside a Sheet drawer (handled by the Sidebar component).
function AdminSidebar({ pathname }: { pathname: string | null }) {
  const { setOpenMobile, isMobile } = useSidebar();
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
          className="flex items-center px-1 text-[13px] font-extrabold tracking-[0.1em] text-ink uppercase no-underline"
        >
          <span className="group-data-[collapsible=icon]:hidden">SUB / WAVE</span>
          <span className="hidden group-data-[collapsible=icon]:inline">S/W</span>
        </Link>
        <span className="caption px-1 group-data-[collapsible=icon]:hidden">admin console</span>
      </SidebarHeader>

      <SidebarContent className="gap-4 px-2 py-1">
        {NAV_SECTIONS.map(section => (
          <SidebarGroup key={section.label} className="p-0">
            <SidebarGroupLabel>{section.label}</SidebarGroupLabel>
            <SidebarMenu className="gap-1.5">
              {section.items.map(n => {
                // Playlists lives under Library's wing — keep Library lit there.
                const active =
                  !!pathname &&
                  (pathname.startsWith(n.href) ||
                    (n.id === 'library' && pathname.startsWith('/admin/playlists')));
                const Icon = n.icon;
                return (
                  <SidebarMenuItem key={n.id}>
                    <SidebarMenuButton asChild isActive={active} tooltip={n.label}>
                      <Link href={n.href} onClick={closeOnMobileNav}>
                        {/* Active background morphs across nav groups via a
                            shared layoutId — same trick as DotRail. The icon
                            and label sit above it via z-index. */}
                        {active && (
                          <m.span
                            layoutId="admin-nav-active"
                            className="absolute inset-0 z-0 bg-ink"
                            initial={false}
                            transition={{ type: 'spring', stiffness: 380, damping: 32 }}
                            aria-hidden="true"
                          />
                        )}
                        <Icon
                          className="relative z-[1] shrink-0 opacity-80"
                          strokeWidth={2}
                          aria-hidden="true"
                        />
                        <span className="relative z-[1] flex-1 truncate">{n.label}</span>
                      </Link>
                    </SidebarMenuButton>
                    {n.pill && <SidebarMenuBadge>{n.pill}</SidebarMenuBadge>}
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter className="gap-3 px-2 py-3">
        <SidebarMenu className="gap-1.5">
          {EXTERNAL_LINKS.map(link => {
            const Icon = link.icon;
            return (
              <SidebarMenuItem key={link.href}>
                <SidebarMenuButton
                  asChild
                  tooltip={link.label}
                  className={cn(
                    link.accent &&
                      'border-[color-mix(in_oklab,var(--accent)_55%,var(--line))] text-[var(--accent)] hover:border-[var(--accent)]',
                  )}
                >
                  <Link href={link.href} target="_blank" rel="noopener noreferrer">
                    <Icon className="shrink-0 opacity-80" strokeWidth={2} aria-hidden="true" />
                    <span className="flex-1 truncate">{link.label}</span>
                  </Link>
                </SidebarMenuButton>
                <SidebarMenuBadge
                  className={cn(link.accent && 'border-[var(--accent)] text-[var(--accent)]')}
                >
                  {link.pill}
                </SidebarMenuBadge>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
        <div className="border-t border-dashed border-[var(--separator-strong)] px-1 pt-3 text-[10px] leading-relaxed tracking-[0.18em] text-muted uppercase group-data-[collapsible=icon]:hidden">
          sub / wave
          <br />
          admin console
          {process.env.NEXT_PUBLIC_APP_VERSION ? (
            <>
              <br />
              <span className="tracking-[0.12em] opacity-70">
                v{process.env.NEXT_PUBLIC_APP_VERSION}
              </span>
            </>
          ) : null}
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

// Sticky top bar — sidebar toggle, breadcrumb, and the live-station strip.
function TopBar({
  pathname,
  onSignOut,
}: {
  pathname: string | null;
  onSignOut: () => void;
}) {
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
      <Separator orientation="vertical" className="h-5" />
      <Breadcrumb>
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
        <SignOutButton onSignOut={onSignOut} />
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

// Sign out drops the cached credentials, so a stray click means re-entering
// them — worth a confirm, matching the dash's skip-track dialog.
function SignOutButton({ onSignOut }: { onSignOut: () => void }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <button
        className="cursor-pointer border border-ink bg-transparent px-3 py-[5px] text-[9px] font-bold tracking-[0.25em] text-ink uppercase hover:bg-ink hover:text-bg"
        onClick={() => setConfirming(true)}
      >
        sign out
      </button>
      <V3AlertDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Sign out"
        description="Sign out of the admin console? You'll need the operator credentials to get back in."
        confirmLabel="sign out"
        danger
        onConfirm={onSignOut}
      />
    </>
  );
}
