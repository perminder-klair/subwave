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

// What a tool answers when its deadline fires first. The same `{ error }` shape
// every tool's own catch returns, so the step keeps a real tool result (not an
// SDK tool-error) and the model reads it like any other failed source.
export function toolDeadlineResult(name: string): { error: string } {
  return { error: `${name} ran out of time — choose from your other tool results this round` };
}

// Make a tool's deadline real. In ai@7 the agent's per-tool timeout
// (strategy/agent.ts TOOL_TIMEOUT_MS) and the run's shared deadline reach a tool
// ONLY as `options.abortSignal`: the SDK awaits execute() and never races it, so
// a tool that ignores the signal holds its step for as long as it likes and the
// "backstop" never fires. This races execute() against that signal for every
// registered tool. It does not cancel the work: a tool with slow I/O also
// threads the signal into it, so the abandoned call stops instead of finishing
// in the background.
export function withToolDeadline(name: string, t: Tool): Tool {
  const execute = (t as { execute?: (input: unknown, options: any) => unknown }).execute;
  if (typeof execute !== 'function') return t;
  return {
    ...t,
    execute: (input: unknown, options: any) => {
      const signal: AbortSignal | undefined = options?.abortSignal;
      if (!signal) return execute(input, options);
      if (signal.aborted) return Promise.resolve(toolDeadlineResult(name));
      return new Promise((resolve, reject) => {
        const onAbort = () => resolve(toolDeadlineResult(name));
        signal.addEventListener('abort', onAbort, { once: true });
        Promise.resolve()
          .then(() => execute(input, options))
          .then(resolve, reject)
          .finally(() => signal.removeEventListener('abort', onAbort));
      });
    },
  } as Tool;
}
