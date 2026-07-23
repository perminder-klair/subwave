# Admin shell on shadcn Sidebar — design

**Date:** 2026-07-23
**Status:** Proposed
**Scope:** `web/components/admin/AdminShell.tsx`, `web/components/ui/`, `web/app/globals.css`, `web/app/admin/layout.tsx`

## Goal

Rebuild the admin console's navigation shell (left rail + top bar) on shadcn's
Sidebar component, keeping the newsprint visual identity. Decided with the
operator: **icon-rail collapse** on desktop, **newsprint retune** for the skin
(shadcn behavior, SUB/WAVE look — the same pattern as `ui/button.tsx`).

What this buys over the hand-rolled shell:

- **Mobile:** a proper Sheet drawer behind a hamburger, replacing the ~15-button
  grid that currently stacks above the page content below 860px.
- **Desktop:** collapsible icon rail with cookie-persisted state and a
  Cmd/Ctrl+B toggle — page content gains ~170px on dense pages
  (Library, Settings, Shows).
- **Top bar:** sticky header per the shadcn dashboard pattern
  (SidebarTrigger + Breadcrumb), replacing the non-sticky hand-rolled crumb.
- **Less bespoke CSS:** ~200 lines of `.shell-*` rules deleted from
  `globals.css`.

## Current state (what survives, what goes)

`AdminShell.tsx` renders: sign-in gate → `ShellHeader` (wordmark, crumb, live
dot, listener odometer, DJ Doc link, ThemeSwitcher, listen link, sign-out with
confirm) → `NavidromeBanner` → `.shell-body` grid (200px `.shell-nav` +
`<main>`) → `AnimatePresence` 120ms page cross-fade → `Toaster`.

Survives unchanged: the auth gate, first-run redirect, revoked-token probe,
`NavidromeBanner`, the right-side header strip, the sign-out confirm dialog,
`NAV_SECTIONS` data, the motion `layoutId` active-morph, the page cross-fade,
`Toaster`, and the `.admin-root` scoping class (every panel's CSS hangs off it).

Goes: `.shell-body` / `.shell-nav` / `.nav-item` / mobile-flatten CSS, the
non-sticky `.shell-header` layout, the hand-rolled crumb.

## Architecture

### New files

| File | Origin | Notes |
| --- | --- | --- |
| `web/components/ui/sidebar.tsx` | shadcn registry (radix/new-york — the CLI resolves the variant from `components.json`; the base-ui docs URL is just the site default) | Retuned to newsprint (see Skin). Mobile branch imports `sheet-primitive` instead of `sheet`. |
| `web/components/ui/sheet-primitive.tsx` | shadcn registry `sheet` | **Renamed on install.** `ui/sheet.tsx` is a custom single-export component used across admin panels — it stays untouched. The shadcn Sheet primitives land under this name solely for the sidebar's mobile drawer. |
| `web/components/ui/skeleton.tsx` | shadcn registry | Sidebar dependency (`SidebarMenuSkeleton`). Retune = sharp corners, `--ink-soft` fill. |
| `web/components/ui/breadcrumb.tsx` | shadcn registry | Top-bar breadcrumb. Retuned: caption type (10px, 0.28em tracking, uppercase) to match the current crumb. |
| `web/hooks/use-mobile.ts` | shadcn registry | Sidebar dependency. Default 768px breakpoint replaces the CSS 860px one. |

Install approach: `npx shadcn@latest add sidebar breadcrumb --dry-run` first;
because `sheet.tsx` exists the CLI would prompt to overwrite — never accept.
Vendor the sheet primitives via `npx shadcn@latest view @shadcn/sheet` into
`sheet-primitive.tsx` by hand, then fix the sidebar's import. All other deps
(button, separator, tooltip, input) already exist and are already retuned —
do not re-add or overwrite them.

### AdminShell structure (signed in)

```tsx
<div className="admin-root paper">
  <SidebarProvider defaultOpen={defaultOpen}>
    <Sidebar collapsible="icon">
      <SidebarHeader>            {/* wordmark; monogram “S/W” in icon mode */}
      <SidebarContent>
        {NAV_SECTIONS.map(→ <SidebarGroup> + <SidebarGroupLabel> +
          <SidebarMenu> → <SidebarMenuItem> → <SidebarMenuButton asChild
            isActive tooltip={label}> → <Link> (keeps the m.span
            layoutId="admin-nav-active" morph) + <SidebarMenuBadge> for pills)}
      </SidebarContent>
      <SidebarFooter>            {/* external links group + Ko-fi + version foot */}
      <SidebarRail />            {/* click-edge toggle */}
    </Sidebar>
    <SidebarInset>
      <header className="sticky top-0 z-10 …">   {/* see Top bar */}
      <NavidromeBanner />
      <main className="mx-auto w-full max-w-[1440px] px-5 py-4 min-w-0">
        <AnimatePresence>{children}</AnimatePresence>
      </main>
    </SidebarInset>
  </SidebarProvider>
  <Toaster />
</div>
```

- **Cookie-correct SSR:** `app/admin/layout.tsx` is a server component — it
  reads the `sidebar_state` cookie via `next/headers` `cookies()` and passes
  `defaultOpen` into `AdminShell`, so the rail renders collapsed/expanded
  without a hydration flash.
- **Signed-out / loading states:** no sidebar. A slim top bar (wordmark,
  ThemeSwitcher, listen link) over the SignInForm — structurally what
  `ShellHeader signedIn={false}` does today, rebuilt in Tailwind.
- **Content width:** `SidebarInset` is full-bleed; the inner `max-w-[1440px]`
  wrapper preserves today's line lengths so the 15 admin pages don't reflow.
  When the rail collapses, the wrapper re-centers and wide panels gain width
  up to the cap.

### Top bar (inside SidebarInset)

Sticky (`sticky top-0 z-10`), `--card-bg` fill, `border-b` in ink — the same
chrome-strip treatment the current header has, plus stickiness. Left to right:

1. `SidebarTrigger` (hamburger on mobile, collapse toggle on desktop)
2. Vertical `Separator`
3. `Breadcrumb`: `<section label> / <page>` (e.g. **Programming / Library**),
   from `NAV_SECTIONS`; special cases kept: `/admin/doctor` → "DJ Doc",
   `/admin/playlists` → "Programming / Playlists" (Library stays lit in the
   rail, as today).
4. Right strip, unchanged in content and order: live dot (with the on-air pulse
   animation), listener `OdometerNumber` + Users icon, DJ Doc link with
   `BoothBuddy`, `ThemeSwitcher variant="admin"`, listen (headphones) link,
   sign-out button + `V3AlertDialog` confirm.

The wordmark moves from the top bar into `SidebarHeader` (shadcn dashboard
convention: brand in the sidebar, context in the header). In icon-collapse
mode it shrinks to an "S/W" monogram.

### Skin — newsprint retune of sidebar.tsx

Same treatment `button.tsx` got: keep the component's API, structure, data
attributes, and behavior byte-for-byte; restyle only.

- **Tokens:** add the `--sidebar-*` family to the existing `@theme` bridge in
  `globals.css` (`--color-sidebar: var(--sidebar)` etc.) and define the values
  from newsprint vars scoped where the current bridge does it:
  `--sidebar: var(--card-bg)`, `--sidebar-foreground: var(--ink)`,
  `--sidebar-accent: var(--ink-soft)`, `--sidebar-border: var(--line)`,
  `--sidebar-ring: var(--accent)`. Deriving from `--ink`/`--bg` keeps every
  theme palette and dark mode working with zero per-theme cases.
- **Nav items:** `SidebarMenuButton` restyled to the bordered-card look —
  1px `--line` border, `--card-bg` fill, 11px uppercase 0.16em labels, sharp
  corners, no shadows; hover firms the border to ink (today's exact hover).
  Active state stays owned by the motion span (ink fill morphing between
  items); the button contributes `text-bg` + ink border via
  `data-[active=true]`.
- **Group labels:** 9px, 0.22em tracking, uppercase, `--muted` — the current
  `.nav-section-label`.
- **Badges:** `SidebarMenuBadge` restyled to the current `.pill`
  (1px currentColor border, 9px, accent fill when the item is active).
- **Footer:** external links (Manual, iOS, Android, Desktop, Discord) as a
  `SidebarMenu` in `SidebarFooter`; Ko-fi keeps its vermilion `nav-support`
  treatment; the "sub / wave admin console vX.Y.Z" foot keeps its dashed top
  border and hides in icon mode (`group-data-[collapsible=icon]:hidden`).
- **Icon mode:** labels/badges/foot hide (component handles it); each item
  shows its lucide icon centered with the label as a `tooltip` — Tooltip is
  already installed.
- **Mobile drawer:** the sidebar's Sheet branch, full newsprint (card fill,
  ink hairline edge). Drawer closes on nav (the component's default
  link-click behavior inside the sheet — verify during implementation).

### CSS changes in globals.css

- Delete: `.shell-body`, `.shell-nav` and all descendants (`.nav-section`,
  `.nav-item`, `.nav-ext`, `.nav-support`, `.nav-foot`), the ≤860px flatten
  block, and `.shell-header` rules that the Tailwind rebuild obsoletes.
- Keep: `.admin-root` var block, `.paper`, type helpers (`.eyebrow`,
  `.caption`, `.mono-num`). `.live-dot` and `.sign-out` are rebuilt as
  Tailwind on the new header and their CSS rules deleted.
- Add: the `--sidebar-*` token definitions + `@theme` bridge entries.

### Keyboard shortcut

The sidebar ships Cmd/Ctrl+B. Nothing in the admin binds B today
(`useKeyboardShortcuts` is player-side) — no conflict.

## Alternatives considered

- **B — keep the custom shell, cherry-pick mobile drawer + sticky header:**
  saves the retune work but leaves two nav systems' worth of CSS and forfeits
  collapse/cookie/shortcut behavior. Rejected.
- **C — stock shadcn skin:** fastest, but the admin was deliberately redesigned
  to the newsprint identity and every other ui component is retuned to it.
  Rejected with the operator.

## Error handling / edge cases

- **Hydration:** `defaultOpen` from the server-read cookie prevents the
  collapse-state flash; the auth gate is client-side as before.
- **Unknown routes** (`/admin/whatever`): breadcrumb falls back to "Admin",
  as the current crumb does.
- **Motion morph across collapse:** the `layoutId` span animates within
  whichever sidebar instance is mounted; desktop↔mobile remount is a fresh
  instance, which is fine (no cross-instance morph expected).
- **Panels assuming 200px rail:** none found — pages only depend on
  `.admin-root` scoping and their own max-width; the inset wrapper preserves
  the 1440px cap.

## Testing

- `cd web && npm run lint` (eslint + tsc) — the merge gate.
- Playwright pass via the `verify` skill (isolated controller + worktree dev
  server, pre-seeded `subwave_admin_auth`): every nav route renders, active
  state + breadcrumb correct, collapse persists across reload (cookie),
  Cmd+B toggles, mobile viewport gets the drawer and it closes on navigation,
  sign-in/sign-out flows intact, dark mode + at least one non-default theme
  palette.
- Visual sweep of dense pages (Library, Settings, Shows) expanded and
  collapsed.

## Out of scope

Panel internals, `StationHeader` (dash page strip), onboarding wizard, the
listener player, and any nav IA changes (sections and destinations stay
exactly as they are).
