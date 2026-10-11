// Read access to loaded skills without importing the loader's queue integration.
export interface LoadedCapability {
  skill: string;
  kind: string;
  seeded: boolean;
  toolFn?: (...args: unknown[]) => unknown;
  ready?: () => boolean;
  config?: unknown;
}
let capabilities: LoadedCapability[] = [];
export function loadedCapabilities(): LoadedCapability[] { return capabilities; }
export function replaceLoadedCapabilities(next: LoadedCapability[]): void { capabilities = next; }
