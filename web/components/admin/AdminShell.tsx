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
  Palette,
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
import { animate as motionAnimate } from 'motion/react';

interface NavItem {
  href: string;
  id: string;
  label: string;
  icon: ComponentType<{
    className?: string;
    size?: number;
    strokeWidth?: number;
    'aria-hidden'?: boolean | 'true' | 'false';
  }>;
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
      { href: '/admin/moods', id: 'moods', label: 'Moods', icon: Palette },
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

const NAV = NAV_SECTIONS.flatMap(s => s.items);

export interface AdminShellProps {
  children: ReactNode;
}

// Wraps every page under /admin. Renders the newsprint shell + sign-in gate.
// Children are admin panels that re-call useAdminAuth themselves to avoid
// prop-drilling the adminFetch.
export default function AdminShell({ children }: AdminShellProps) {
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
      <div className="admin-root paper flex items-center justify-center">
        <span className="caption">loading…</span>
      </div>
    );
  }

  // Authentication gate — covers both "no token yet" and "token rejected".
  if (!auth || needsAuth) {
    return (
      <div className="admin-root paper">
        <ShellHeader pathname={pathname} signedIn={false} />
        <div className="mx-auto max-w-[1440px] px-7 py-12">
          <SignInForm onSubmit={handleSignIn} />
        </div>
      </div>
    );
  }

  return (
    <div className="admin-root paper">
      <ShellHeader pathname={pathname} signedIn onSignOut={signOut} />
      {/* Persistent connectivity warning — visible on every admin page whenever
          the live station can't reach Navidrome. Renders nothing when healthy. */}
      <NavidromeBanner adminFetch={adminFetch} />
      <div className="shell-body">
        <nav className="shell-nav">
          {NAV_SECTIONS.map(section => (
            <div key={section.label} className="nav-section">
              <span className="nav-section-label">{section.label}</span>
              {section.items.map(n => {
                // Playlists lives under Library's wing now — keep Library lit there.
                const active =
                  pathname?.startsWith(n.href) ||
                  (n.id === 'library' && pathname?.startsWith('/admin/playlists'));
                const Icon = n.icon;
                return (
                  <Link key={n.id} href={n.href} className={`nav-item ${active ? 'active' : ''}`}>
                    {/* Active background morphs across nav groups via shared
                        layoutId — same trick as DotRail. initial={false}
                        suppresses the first-paint animation. */}
                    {active && (
                      <m.span
                        layoutId="admin-nav-active"
                        className="absolute inset-0 z-0 bg-ink"
                        initial={false}
                        transition={{ type: 'spring', stiffness: 380, damping: 32 }}
                        aria-hidden="true"
                      />
                    )}
                    <Icon className="nav-icon" size={15} strokeWidth={2} aria-hidden="true" />
                    <span className="nav-label">{n.label}</span>
                    {n.pill && <span className="pill">{n.pill}</span>}
                  </Link>
                );
              })}
            </div>
          ))}
          {/* External links — grouped like a nav-section so they sit tight
              together (3px) rather than the rail's 18px; nav-ext pins the
              group to the bottom. */}
          <div className="nav-section nav-ext">
            <Link
              href="/manual"
              target="_blank"
              rel="noopener noreferrer"
              className="nav-item"
            >
              <BookOpen className="nav-icon" size={15} strokeWidth={2} aria-hidden="true" />
              <span className="nav-label">Manual</span>
              <span className="pill">↗</span>
            </Link>
            <Link
              href="https://apps.apple.com/app/sub-wave/id6778786696"
              target="_blank"
              rel="noopener noreferrer"
              className="nav-item"
            >
              <Apple className="nav-icon" size={15} strokeWidth={2} aria-hidden="true" />
              <span className="nav-label">iOS app</span>
              <span className="pill">↗</span>
            </Link>
            <Link
              href="https://play.google.com/store/apps/details?id=com.getsubwave.app"
              target="_blank"
              rel="noopener noreferrer"
              className="nav-item"
            >
              <Smartphone className="nav-icon" size={15} strokeWidth={2} aria-hidden="true" />
              <span className="nav-label">Android app</span>
              <span className="pill">↗</span>
            </Link>
            <Link
              href="https://github.com/getsubwave/subwave-desktop/releases/latest"
              target="_blank"
              rel="noopener noreferrer"
              className="nav-item"
            >
              <Monitor className="nav-icon" size={15} strokeWidth={2} aria-hidden="true" />
              <span className="nav-label">Desktop app</span>
              <span className="pill">↗</span>
            </Link>
            <Link
              href="https://discord.gg/vjVbVKnMBa"
              target="_blank"
              rel="noopener noreferrer"
              className="nav-item"
            >
              <MessageCircle className="nav-icon" size={15} strokeWidth={2} aria-hidden="true" />
              <span className="nav-label">Discord</span>
              <span className="pill">↗</span>
            </Link>
            {/* The donation link — "Support" read as tech support, so say what
                it is. nav-support gives it the one splash of vermilion on the
                rail so it doesn't camouflage among the utility links. */}
            <Link
              href="https://ko-fi.com/pklair"
              target="_blank"
              rel="noopener noreferrer"
              className="nav-item nav-support"
            >
              <Coffee className="nav-icon" size={15} strokeWidth={2} aria-hidden="true" />
              <span className="nav-label">Buy me a coffee</span>
              <span className="pill">♥</span>
            </Link>
          </div>
          <div className="nav-foot">
            sub / wave
            <br />
            admin console
            {process.env.NEXT_PUBLIC_APP_VERSION ? (
              <>
                <br />
                <span className="nav-foot-version">
                  v{process.env.NEXT_PUBLIC_APP_VERSION}
                </span>
              </>
            ) : null}
          </div>
        </nav>
        <main className="min-w-0">
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
        </main>
      </div>
      <Toaster />
    </div>
  );
}

interface ShellHeaderProps {
  pathname: string | null;
  signedIn: boolean;
  onSignOut?: () => void;
}

// Header — wordmark, breadcrumb, and (when signed in) the live station strip.
function ShellHeader({ pathname, signedIn, onSignOut }: ShellHeaderProps) {
  // DJ Doc and Playlists aren't in the sidebar nav (DJ Doc is reached from the
  // header strip, Playlists from Library's doorway), so the nav lookup can't
  // resolve their breadcrumb labels — special-case them.
  const current =
    NAV.find(n => pathname?.startsWith(n.href))?.label ||
    (pathname?.startsWith('/admin/doctor') ? 'DJ Doc'
      : pathname?.startsWith('/admin/playlists') ? 'Playlists'
        : 'Admin');
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
  useDynamicStyle(dotRef, { background: onAir ? 'var(--accent)' : 'var(--muted)' });

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
    <header className="shell-header">
      <span className="wordmark">SUB / WAVE</span>
      <span className="caption text-muted">· admin</span>
      <span className="crumb">
        / <b>{current}</b>
      </span>
      {signedIn && (
        <span className="right">
          {/* Live dot only — the on-air/off-air word is dropped; the dot's colour
              (accent when live, muted when not) already carries the state. */}
          <span
            ref={dotRef}
            className="live-dot"
            aria-label={onAir ? 'on air' : 'off air'}
            title={onAir ? 'on air' : 'off air'}
          />
          {count != null && (
            <>
              <span className="w-px self-stretch bg-separator-strong" />
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
          <span className="w-px self-stretch bg-separator-strong" />
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
          {onSignOut && <SignOutButton onSignOut={onSignOut} />}
        </span>
      )}
      {!signedIn && (
        <span className="right">
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
      )}
    </header>
  );
}

// Sign out drops the cached credentials, so a stray click means re-entering
// them — worth a confirm, matching the dash's skip-track dialog.
function SignOutButton({ onSignOut }: { onSignOut: () => void }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <button className="sign-out" onClick={() => setConfirming(true)}>
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
