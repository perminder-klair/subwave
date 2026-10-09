// Each tool owns its available gate, including checks for its backing indexes.

import type { Tool } from 'ai';
import type { PickerContext } from './scope.js';

export interface PickerToolModule {
  // The name the model sees. Must be unique across the registry in index.ts.
  name: string;
  // Registered only when this returns true. Absent = always registered.
  //
  // A tool whose backing data is missing must be gated OFF rather than left to
  // return []: offering a dead tool steers the model into a timeout before the
  // pool fallback rescues it (the "DJ Latency 75s" spike, 18% pick failure), and
  // on a forced-tool provider the single discovery call is spent on nothing.
  available?(ctx: PickerContext): boolean;
  build(ctx: PickerContext): Tool;
}

export function definePickerTool(mod: PickerToolModule): PickerToolModule {
  return mod;
}
