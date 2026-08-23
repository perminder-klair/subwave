'use client';

import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Mounted by AdminShell only after its authenticated checks pass, so one client
// survives navigation between admin panels but is destroyed with the signed-out
// branch. Created in a useState initializer, not at module scope: a module-level
// client is shared across requests during SSR, which leaks one render pass's
// cached admin data into another.
export default function AdminQueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({
    defaultOptions: {
      queries: {
        // The admin console is a single operator on a LAN box watching their
        // own station. Refetch-on-focus is noise here, and every list on this
        // page has an explicit Refresh button.
        refetchOnWindowFocus: false,
        // adminFetch turns a 401 into a sign-out; retrying it would fire three
        // more unauthenticated calls and race the token wipe (lib/adminAuth.ts).
        retry: false,
        // Long enough that a tab switch reuses the cache (the point of this
        // change), short enough that coming back to a list after a minute
        // revalidates. Per-query overrides where a list is cheaper or dearer.
        staleTime: 30_000,
      },
    },
  }));
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
