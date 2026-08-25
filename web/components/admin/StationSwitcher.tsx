'use client';

// Sidebar station switcher. Switching runs the same flow as the panel's MAKE
// LIVE: confirm → POST /stations/:id/activate → full-screen overlay until the
// restarted controller answers with the new boot-frozen station id
// (useStationSwitchPoll). Renders nothing until the station list loads.

import Link from 'next/link';
import { useState } from 'react';
import { ChevronsUpDown, Plus, RadioTower } from 'lucide-react';
import { adminJson, type AdminFetch } from '../../lib/admin-query';
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
import { useStationsQuery, type StationRow } from './operations-queries';

export default function StationSwitcher({
  adminFetch,
  onNavigate,
}: {
  adminFetch: AdminFetch;
  onNavigate?: () => void;
}) {
  const stationsQuery = useStationsQuery(adminFetch);
  const data = stationsQuery.data ?? null;
  const [confirmLive, setConfirmLive] = useState<StationRow | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  useStationSwitchPoll(switching);

  const activate = async (id: string) => {
    try {
      await adminJson(adminFetch, `/stations/${id}/activate`, { method: 'POST' });
      setSwitching(id);
    } catch (e) {
      notify.err(`Switch failed: ${errorMessage(e)}`);
    }
  };

  const active = data?.stations.find(s => s.active) ?? null;
  const others = data?.stations.filter(s => !s.active) ?? [];

  if (!active) return null;

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <DropdownMenu modal={false} onOpenChange={o => { if (o) void stationsQuery.refetch(); }}>
            <DropdownMenuTrigger asChild>
              <SidebarMenuButton tooltip="Switch station">
                <span className="flex aspect-square size-5 shrink-0 items-center justify-center rounded-sm border border-ink">
                  <RadioTower className="size-3" />
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px] font-extrabold tracking-[0.08em] uppercase">
                  {active.name}
                </span>
                <ChevronsUpDown className="ml-auto size-4 opacity-60" />
              </SidebarMenuButton>
            </DropdownMenuTrigger>
            {/* A long station name would otherwise size the menu past a phone
                viewport — cap it and let the item labels truncate. */}
            <DropdownMenuContent side="bottom" align="start" className="max-w-[calc(100vw-2rem)] min-w-[13rem]">
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
