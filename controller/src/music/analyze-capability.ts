// Pure decisions the analysis pass makes about what it skips, and what it tells
// the operator when it does. Side-effect-free so they can be unit-pinned
// (scripts/analyze-capability.test.ts). The messages are the contract: this is
// the only place an operator with a broken analyzer finds out what broke.

type AnalysisDimension = 'audio' | 'vocal' | 'stem';

// Which backend is answering, so the retry advice names something that exists.
// 'sidecar' has an analyzer container; 'local' (librosa venv, every AIO image)
// runs the worker as a child of the controller.
type AnalysisBackend = 'sidecar' | 'local' | string | null;

export interface CapabilityInputs {
  dimension: AnalysisDimension;
  // The operator wants this dimension (env force or the admin toggle).
  wanted: boolean;
  // Backend can emit it. false = definitively not; null = unknown (a local
  // backend that hasn't been probed, or a sidecar too old to advertise).
  capable: boolean | null;
  // Set when `capable` is false because the model LOAD failed rather than the
  // build being lean. null otherwise, including on a lean image.
  error: string | null;
  // analyzer.backendLabel(). Only affects the retry sentence; omitting it gives
  // generic wording.
  backend?: AnalysisBackend;
}

export interface CapabilityDecision {
  // Widen the pass to already-analysed tracks missing this dimension. False
  // when the backend definitively can't produce it, since widening would then
  // re-analyse the whole library every pass for a guaranteed no-op.
  widen: boolean;
  // One line for the pass log, or null when there is nothing to say.
  notice: string | null;
}

const LABEL: Record<AnalysisDimension, string> = {
  audio: 'audio',
  vocal: 'vocal',
  stem: 'stem',
};

// What the dimension needs, in the operator's terms. Vocal ranges and the stem
// cache are the same Demucs separation, so they fail together.
const MODEL: Record<AnalysisDimension, string> = {
  audio: 'CLAP',
  vocal: 'Demucs',
  stem: 'Demucs',
};

// How to get an image that has the model. Names the image rather than a build
// arg: `ANALYZER_HEAVY=1` is the switch the compose files read, and it is inert
// on the AIO (docs/unraid.md).
const HEAVY_HINT =
  'set ANALYZER_HEAVY=1 and recreate the analyzer, or run the -heavy AIO image';

// What the operator has to restart to clear the sticky capability latch, which
// is not the same process on every deployment: a sidecar remembers the error in
// the analyzer container (server.py capability_errors, not cleared by a worker
// respawn), while a local/AIO install latches in the controller's own module
// state and only clears when the controller goes down.
function retryHint(backend: AnalysisBackend): string {
  if (backend === 'sidecar') return 'restart the analyzer (`docker compose restart analyzer`)';
  if (backend === 'local') {
    return 'restart the controller (this deployment runs the analyzer in-process, so there is no separate analyzer to restart)';
  }
  return 'restart the analyzer — or the controller, if it runs the analyzer in-process';
}

export function backfillDecision(x: CapabilityInputs): CapabilityDecision {
  if (!x.wanted) return { widen: false, notice: null };
  if (x.capable !== false) return { widen: true, notice: null };
  const label = LABEL[x.dimension];
  const model = MODEL[x.dimension];
  if (x.error) {
    // The image has the model and it failed to load. The latch will not clear
    // itself, so the retry has to be a restart.
    return {
      widen: false,
      notice:
        `${label} backfill skipped — ${model} is installed but failed to load: ${x.error}. ` +
        `Fix the cause, then ${retryHint(x.backend ?? null)} to retry (the failure is remembered ` +
        'until then, so the pass stops re-analysing tracks it cannot fill).',
    };
  }
  return {
    widen: false,
    notice: `${label} backfill skipped — this analyzer is built without ${model} (${HEAVY_HINT})`,
  };
}

// Tracks pulled in only because their CLAP vector is missing skip the baseline
// acoustic pass. Any baseline/vocal/stem scope membership keeps the full path;
// audioBackfill is explicit so ordinary analysis never becomes embedding-only.
export function analysisModeForTrack(
  id: string,
  fullAnalysisIds: ReadonlySet<string>,
  audioBackfill: boolean,
): 'full' | 'embedding-only' {
  return audioBackfill && !fullAnalysisIds.has(id) ? 'embedding-only' : 'full';
}

// How many tracks in a row may fail before the pass stops treating a throw as
// evidence about the file rather than about the system (a dead analyzer, an
// absent music backend, an unmounted volume).
export const SYSTEMIC_FAILURE_RUN = 5;

// Whether a thrown analysis should count against MAX_ANALYSIS_FAILURES. The
// per-track stamp exists so a permanently unanalysable file leaves the scope;
// it is the wrong instrument for a systemic outage, which throws for every
// remaining track.
//
// `consecutive` = failures since the last success in this pass, including the
// one being decided, so scattered bad files never build a run. A true answer
// means "this MAY be about the file": the caller BUFFERS the stamp and writes it
// only once a later success proves the pass healthy, discarding it if the run
// trips the threshold. Stamping eagerly would sentence tracks in id order on
// every pass of a persistent outage, and an excluded track cannot self-heal.
export function failureCountsAgainstTrack(consecutive: number): boolean {
  return consecutive <= SYSTEMIC_FAILURE_RUN;
}
