// The doctor's vocabulary: a finding's status, the closed set of one-click
// fixes a finding may offer, and the slice of settings the checks inspect.
//
// Part of the doctor/ split - see ../doctor.ts for the section runner.



type Status = 'ok' | 'warn' | 'fail' | 'skip';

// Closed set of safe, already-implemented admin actions a finding may offer as a
// one-click remediation. The web panel maps each id → the matching POST route.
export type FixId =
  | 'refresh-playlist'
  | 'restart-mixer'
  | 'generate-jingles'
  | 'tag-library'
  | 'subsonic-reset';

export interface FixAction {
  id: FixId;
  label: string;
}

export interface Finding {
  label: string;
  status: Status;
  detail?: string;
  hint?: string;
  fix?: FixAction;
}

export interface DoctorSection {
  name: string;
  findings: Finding[];
}

export interface DoctorReport {
  t: string;
  sections: DoctorSection[];
  counts: { ok: number; warn: number; fail: number; skip: number };
}

interface ReviewPriority {
  title: string;
  severity: 'low' | 'med' | 'high';
  why: string;
  suggestedFix: string;
  // When set, the panel can render the matching one-click fix button right on
  // this priority. The panel still cross-checks it against the report's own
  // findings, so a stray/hallucinated id never surfaces a button.
  fixId?: FixId | null;
}

export interface DoctorReview {
  available: boolean;
  reason?: string; // why the review couldn't run (LLM offline / not configured)
  overall?: 'healthy' | 'attention' | 'critical';
  summary?: string;
  priorities?: ReviewPriority[];
}

// The performance-affecting slice of settings.get() the doctor inspects. All
// optional — settings.get() is untyped and any field may be absent — so every
// read is a safe `?.` access. Widened over time as new checks reference more.
export interface StationSettings {
  llm?: {
    pickerAgent?: boolean;
    reasoning?: boolean;
    agentTimeoutMs?: number;
    provider?: string;
    numCtx?: number;
    maxOutputTokens?: number;
    requestWebResolve?: boolean;
    toolChoice?: string;
    exemptRequests?: boolean;
    pauseWhenEmpty?: boolean;
    noRepeatWindow?: number;
  };
  tts?: { defaultEngine?: string; byKind?: Record<string, string | undefined> };
  search?: { provider?: string };
  audio?: { embeddings?: boolean; vocalActivity?: boolean; stemCache?: boolean; stemCacheGb?: number };
  transitions?: { pairDrain?: boolean; stemBlends?: boolean };
  stream?: { opusEnabled?: boolean; flacEnabled?: boolean; aacEnabled?: boolean };
  archive?: { enabled?: boolean };
  crossfadeDuration?: number;
  jingleRatio?: number;
  jingleRotate?: 'mixer' | 'controller';
  maxTrackSeconds?: number;
  loudness?: { targetLufs?: number };
}


