'use client';

// Sidebar station switcher — the multi-station counterpart of shadcn's
// "Teams" switcher: the active station sits at the top of the sidebar and
// the dropdown lists every station on this install plus a shortcut to
// /admin/stations. Switching from here is the same flow as the panel's
// MAKE LIVE: confirm → POST /stations/:id/activate → full-screen switching
// overlay until the restarted controller answers with the new boot-frozen
// station id (useStationSwitchPoll). Renders nothing until the station list
// loads — the wordmark above stays the sidebar's constant brand anchor.

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { ChevronsUpDown, Plus, RadioTower } from 'lucide-react';
import { useAdminAuth } from '../../lib/adminAuth';
import { notify, errorMessage } from '../../lib/notify';
import { useStationSwitchPoll } from '../../hooks/useStationSwitch';
import { Pill } from './ui';
import { EmptyState } from '../ui/empty-state';
import { V3AlertDialog } from '../ui/alert-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '../ui/sidebar';

interface StationRow {
  id: string | null;
  name: string;
  configured: boolean;
  createdAt: string | null;
  active: boolean;
}

interface StationsResponse {
  multiStation: boolean;
  activeId: string | null;
  stations: StationRow[];
}

export default function StationSwitcher({ onNavigate }: { onNavigate?: () => void }) {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const [data, setData] = useState<StationsResponse | null>(null);
  const [confirmLive, setConfirmLive] = useState<StationRow | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  useStationSwitchPoll(switching);

  const load = useCallback(async () => {
    try {
      const r = await adminFetch('/stations');
      if (!r.ok) return;
      setData((await r.json()) as StationsResponse);
    } catch {
      /* sidebar chrome — fail quiet; the switcher just doesn't render */
    }
  }, [adminFetch]);

  useEffect(() => {
    if (hydrated && !needsAuth) void load();
  }, [hydrated, needsAuth, load]);

  const activate = async (id: string) => {
    try {
      const r = await adminFetch(`/stations/${id}/activate`, { method: 'POST' });
      const j = (await r.json()) as { error?: string };
      if (!r.ok) throw new Error(j?.error || `failed (${r.status})`);
      setSwitching(id);
    } catch (e) {
      notify.err(`Switch failed: ${errorMessage(e)}`);
    }
  };

  const active = data?.stations.find(s => s.active) ?? null;
  const others = data?.stations.filter(s => !s.active) ?? [];

  if (!hydrated || needsAuth || !active) return null;

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <DropdownMenu modal={false} onOpenChange={o => { if (o) void load(); }}>
            <DropdownMenuTrigger asChild>
              <SidebarMenuButton size="lg" tooltip="Switch station">
                <span className="flex aspect-square size-8 shrink-0 items-center justify-center rounded-sm border border-ink">
                  <RadioTower className="size-4" />
                </span>
                <span className="grid flex-1 text-left leading-tight">
                  <span className="truncate text-[13px] font-extrabold tracking-[0.08em] uppercase">
                    {active.name}
                  </span>
                  <span className="caption truncate">
                    {active.id ?? 'this install'} · on air
                  </span>
                </span>
                <ChevronsUpDown className="ml-auto size-4 opacity-60" />
              </SidebarMenuButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="bottom" align="start" className="min-w-[13rem]">
              <DropdownMenuLabel>Stations</DropdownMenuLabel>
              <DropdownMenuItem disabled className="justify-between gap-2">
                <span className="truncate">{active.name}</span>
                <Pill tone="accent" dot>
                  Live
                </Pill>
              </DropdownMenuItem>
              {others.map(s => (
                <DropdownMenuItem
                  key={s.id}
                  className="justify-between gap-2"
                  onClick={() => setConfirmLive(s)}
                >
                  <span className="truncate">{s.name}</span>
                  {!s.configured ? <span className="caption">unconfigured</span> : null}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <Link href="/admin/stations" onClick={onNavigate}>
                  <Plus className="size-4" />
                  New / manage stations
                </Link>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>

      <V3AlertDialog
        open={confirmLive !== null}
        onOpenChange={o => {
          if (!o) setConfirmLive(null);
        }}
        title="Switch the live station"
        description={`Make “${confirmLive?.name ?? ''}” the live station? Every listener is dropped for ~10 seconds while the mixer and controller restart.`}
        confirmLabel="Make live"
        danger
        onConfirm={() => {
          if (confirmLive?.id) void activate(confirmLive.id);
          setConfirmLive(null);
        }}
      />

      {switching ? (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/95 backdrop-blur-sm">
          <EmptyState
            icon={<RadioTower className="animate-pulse" />}
            title="Switching stations…"
            description="The mixer and controller are restarting against the new station. Listeners reconnect automatically — this page reloads on its own once the switch completes."
          />
        </div>
      ) : null}
    </>
  );
}
