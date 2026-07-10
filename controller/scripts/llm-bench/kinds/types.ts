// The per-kind contract for llm-bench. A kind module declares which telemetry
// kind it exercises, which picker mode it represents, and its scenarios: each
// scenario makes ONE live-barrel call with fixture inputs and returns named
// rule violations (empty array = pass). Schema validity is implicit — a call
// that can't produce its schema throws, which the CLI buckets separately.

export interface Scenario {
  name: string;
  run(): Promise<unknown>;
  check?(out: unknown): string[];
}

export interface KindSpec {
  kind: string;
  /** CLI filter group: pick | segment | request | scripts | banter | programme */
  group: string;
  /** which picker mode this kind represents; 'any' kinds behave identically in
   *  both and run once regardless of --modes */
  mode: 'pool' | 'agent' | 'any';
  scenarios: Scenario[];
}
