'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { PersonalScrobbleState } from '@/hooks/usePersonalScrobble';

const PersonalScrobbleContext = createContext<PersonalScrobbleState | null>(null);

export function PersonalScrobbleProvider({
  value,
  children,
}: {
  value: PersonalScrobbleState;
  children: ReactNode;
}) {
  return (
    <PersonalScrobbleContext.Provider value={value}>
      {children}
    </PersonalScrobbleContext.Provider>
  );
}

export function usePersonalScrobbleContext(): PersonalScrobbleState | null {
  return useContext(PersonalScrobbleContext);
}
