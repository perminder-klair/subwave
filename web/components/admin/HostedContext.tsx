'use client';

// Hosted mode (SUBWAVE_HOSTED): a station run by SUB/WAVE Cloud. The server
// page reads the env with lib/hosted.ts hostedFromEnv (force-dynamic, so
// prebuilt images resolve it at runtime) and provides it here, so deep
// sections (library tagger, music source, the persona engine picker) can show
// what the box agent manages without threading a prop through every panel.
// The controller enforces the same rules on save (controller/src/setup/hosted.ts);
// this only decides what to show.
//
// Only client code belongs in this file: a server page that calls a function
// exported from here throws (see lib/hosted.ts).

import { createContext, useContext, type ReactNode } from 'react';
import type { HostedInfo } from '../../lib/hosted';

export type { HostedInfo };

const HostedContext = createContext<HostedInfo>({ hosted: false });

export function HostedProvider({ value, children }: { value: HostedInfo; children: ReactNode }) {
  return <HostedContext.Provider value={value}>{children}</HostedContext.Provider>;
}

export function useHosted(): HostedInfo {
  return useContext(HostedContext);
}
