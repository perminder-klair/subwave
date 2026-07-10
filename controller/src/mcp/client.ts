/**
 * HTTP client for the SUB/WAVE controller API — the shared implementation
 * behind both MCP transports:
 *   - the controller's built-in HTTP MCP endpoint (routes/mcp.ts), which points
 *     this client at the controller's own port (loopback) and forwards the
 *     caller's Authorization header, and
 *   - the standalone stdio server (mcp-subwave/src/index.ts), which points it at
 *     SUBWAVE_API_URL with admin creds from its own environment.
 *
 * Three endpoint classes matter here:
 *   - public, read-only:        GET /health, /now-playing, /state, /schedule,
 *                               /session, /request/:id
 *   - public, rate-limited:     POST /request (202 receipt + background resolve)
 *   - admin, Basic-auth gated:  the /dj/* command surface and /sfx
 *
 * Every failure is turned into a SubwaveError carrying a message written for
 * the agent — it says what went wrong AND what to do about it, so the model
 * can recover (wait out a cooldown, supply credentials) instead of guessing.
 */

import { fetchWithTimeout } from "../util/fetch-timeout.js";

/** A failure the agent should be able to read and act on directly. */
export class SubwaveError extends Error {
  /** Optional seconds-to-wait, surfaced from HTTP 429 Retry-After. */
  readonly retryAfter?: number;
  constructor(message: string, retryAfter?: number) {
    super(message);
    this.name = "SubwaveError";
    this.retryAfter = retryAfter;
  }
}

export interface SubwaveConfig {
  /** Controller base URL, no trailing slash. */
  baseUrl: string;
  /** Admin Basic-auth user — only needed for the DJ control endpoints. */
  adminUser?: string;
  /** Admin Basic-auth password — only needed for the DJ control endpoints. */
  adminPass?: string;
  /**
   * Pre-formed Authorization header to forward verbatim on admin calls, used
   * by the controller's HTTP MCP mount to pass the caller's credentials
   * straight through. Takes precedence over adminUser/adminPass when set.
   */
  forwardAuth?: string;
  /**
   * Original caller IP to forward as X-Forwarded-For, used by the controller's
   * HTTP MCP mount so per-IP rate limiting (POST /request) keys on the real
   * caller instead of collapsing every MCP user into the loopback address.
   */
  forwardIp?: string;
}

/** POST /request hands back a receipt; the booth resolves in the background. */
export interface RequestSubmission {
  success: boolean;
  requestId: string;
  status: string;
}

/** GET /request/:id — outcome of a submitted request. */
export interface RequestStatus {
  /** 'pending' | 'resolved' | 'failed' | 'unknown' (pruned or lost to a restart). */
  status: string;
  success?: boolean;
  /** DJ's spoken acknowledgement of the request, when matched. */
  ack?: string | null;
  track?: { title: string; artist: string | null } | null;
  /** 1-based position in the upcoming queue. */
  queuePosition?: number | null;
  /** Operator-facing message on a miss / closed / throttled request. */
  message?: string | null;
}

export interface DjSayResult {
  ok: boolean;
  mode: "raw" | "styled";
  kind: "dj-speak" | "link";
  /** The exact words sent to air (post-LLM rewrite when mode=styled). */
  spoken: string;
  /** Sound effect aired under the announcement, when one was requested. */
  sfx?: string | null;
}

export interface DjSegmentResult {
  ok: boolean;
  type: string;
  spoken: string;
}

export interface DjSkillResult {
  ok: boolean;
  name: string;
  /** What went to air — null when the skill chose to stay silent. */
  spoken: string | null;
}

export interface QueueTrackResult {
  ok: boolean;
  track: { title: string; artist: string | null };
  queuePosition: number;
}

export interface SfxPlayResult {
  ok: boolean;
  name: string;
}

export class SubwaveClient {
  constructor(private readonly config: SubwaveConfig) {}

  private get hasAdminCreds(): boolean {
    return Boolean(this.config.forwardAuth || (this.config.adminUser && this.config.adminPass));
  }

  private authHeader(): Record<string, string> {
    if (this.config.forwardAuth) return { authorization: this.config.forwardAuth };
    if (!(this.config.adminUser && this.config.adminPass)) return {};
    const raw = `${this.config.adminUser}:${this.config.adminPass}`;
    return { authorization: `Basic ${Buffer.from(raw).toString("base64")}` };
  }

  /** Core fetch wrapper: timeout, JSON parsing, and agent-readable errors. */
  private async call<T>(
    path: string,
    init: { method?: string; body?: unknown; admin?: boolean; allowStatuses?: number[] } = {},
  ): Promise<T> {
    const url = `${this.config.baseUrl}${path}`;

    let res: Response;
    try {
      res = await fetchWithTimeout(url, {
        method: init.method ?? "GET",
        timeoutMs: 15_000,
        headers: {
          ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
          ...(this.config.forwardIp ? { "x-forwarded-for": this.config.forwardIp } : {}),
          ...(init.admin ? this.authHeader() : {}),
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new SubwaveError(
        `Could not reach the SUB/WAVE controller at ${url} (${reason}). ` +
          `Check that the stack is running and reachable.`,
      );
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    const field = (key: string): string | undefined => {
      const v = body && typeof body === "object" ? (body as Record<string, unknown>)[key] : undefined;
      return typeof v === "string" ? v : undefined;
    };

    // Some endpoints use an error status as a meaningful answer (e.g. 404 from
    // GET /request/:id means "unknown request") — let the caller opt in.
    if (init.allowStatuses?.includes(res.status)) return body as T;

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after")) || undefined;
      throw new SubwaveError(
        field("message") ??
          `Rate limited — wait ${retryAfter ?? "a moment"}s before requesting again. ` +
            `The controller caps song requests at 1 per 20s and 8 per hour.`,
        retryAfter,
      );
    }

    if (res.status === 401 || res.status === 403) {
      throw new SubwaveError(
        `The controller rejected admin credentials for ${path}. ` +
          (this.hasAdminCreds
            ? `The admin credentials provided to this MCP connection don't match the ` +
              `station's ADMIN_USER / ADMIN_PASS.`
            : `This is an admin-only tool. Provide the station's admin credentials to this ` +
              `MCP connection (an Authorization header for the HTTP endpoint, or ` +
              `SUBWAVE_ADMIN_USER / SUBWAVE_ADMIN_PASS for the stdio server).`),
      );
    }

    // 503 carries its own explanation — requests closed by the operator
    // (REQUESTS_DISABLED) or the zero-listener autopilot pause. Pass the
    // controller's message through rather than guessing which.
    if (res.status === 503) {
      throw new SubwaveError(
        field("message") ??
          field("error") ??
          `The station declined the call (HTTP 503) — requests may be closed or the DJ paused.`,
      );
    }

    if (!res.ok) {
      throw new SubwaveError(field("error") ?? field("message") ?? `HTTP ${res.status} from ${path}`);
    }

    return body as T;
  }

  // -------------------------------------------------------------- public --

  /** GET /health — liveness probe; resolves to true when the stream is on-air. */
  async health(): Promise<boolean> {
    const body = await this.call<{ status?: string }>("/health");
    return body.status === "on-air";
  }

  /** GET /now-playing — current track, station context, listener counts. */
  async nowPlaying(): Promise<Record<string, unknown>> {
    return this.call<Record<string, unknown>>("/now-playing");
  }

  /** GET /state — upcoming queue, recent history, and the DJ booth log. */
  async state(): Promise<Record<string, unknown>> {
    return this.call<Record<string, unknown>>("/state");
  }

  /** GET /schedule — shows, personas, and the weekly schedule grid. */
  async schedule(): Promise<Record<string, unknown>> {
    return this.call<Record<string, unknown>>("/schedule");
  }

  /** GET /session — the live DJ session and its recent transcript turns. */
  async session(): Promise<Record<string, unknown>> {
    return this.call<Record<string, unknown>>("/session");
  }

  /** POST /request — submit a song request; returns a 202 receipt to poll. */
  async requestSong(text: string, requester?: string): Promise<RequestSubmission> {
    return this.call<RequestSubmission>("/request", {
      method: "POST",
      body: { text, name: requester },
    });
  }

  /** GET /request/:id — poll the outcome of a submitted request. */
  async requestStatus(id: string): Promise<RequestStatus> {
    // 404 here means "unknown id" (pruned or lost to a restart), not an error.
    return this.call<RequestStatus>(`/request/${encodeURIComponent(id)}`, {
      allowStatuses: [404],
    });
  }

  // --------------------------------------------------------------- admin --

  /** POST /dj/say — make the DJ speak on-air, optionally over a stinger. */
  async djSay(
    text: string,
    mode: "raw" | "styled",
    kind: "dj-speak" | "link",
    sfx?: string,
  ): Promise<DjSayResult> {
    return this.call<DjSayResult>("/dj/say", {
      method: "POST",
      admin: true,
      body: { text, mode, kind, ...(sfx ? { sfx } : {}) },
    });
  }

  /** POST /dj/segment — fire a scripted voice segment on demand. */
  async djSegment(type: string): Promise<DjSegmentResult> {
    return this.call<DjSegmentResult>("/dj/segment", {
      method: "POST",
      admin: true,
      body: { type },
    });
  }

  /** GET /dj/skills — the skill catalogue (built-in + operator skills). */
  async listSkills(): Promise<Record<string, unknown>> {
    return this.call<Record<string, unknown>>("/dj/skills", { admin: true });
  }

  /** POST /dj/skill — run a named skill segment now (operator override). */
  async runSkill(name: string): Promise<DjSkillResult> {
    return this.call<DjSkillResult>("/dj/skill", {
      method: "POST",
      admin: true,
      body: { name },
    });
  }

  /** GET /dj/search?q= — deterministic library search (no LLM, no rate limit). */
  async searchLibrary(q: string): Promise<{ results: Record<string, unknown>[] }> {
    return this.call<{ results: Record<string, unknown>[] }>(
      `/dj/search?q=${encodeURIComponent(q)}`,
      { admin: true },
    );
  }

  /** POST /dj/queue-track — queue an exact track from a search result. */
  async queueTrack(track: Record<string, unknown>): Promise<QueueTrackResult> {
    return this.call<QueueTrackResult>("/dj/queue-track", {
      method: "POST",
      admin: true,
      body: track,
    });
  }

  /** POST /dj/skip — force-end the current track (operator override). */
  async skipTrack(): Promise<{ ok: boolean }> {
    return this.call<{ ok: boolean }>("/dj/skip", { method: "POST", admin: true });
  }

  /** POST /dj/refresh-playlist — rebuild the fallback auto-playlist now. */
  async refreshPlaylist(): Promise<{ ok: boolean }> {
    return this.call<{ ok: boolean }>("/dj/refresh-playlist", { method: "POST", admin: true });
  }

  /** GET /sfx — the sound-effects library. */
  async listSfx(): Promise<Record<string, unknown>> {
    return this.call<Record<string, unknown>>("/sfx", { admin: true });
  }

  /** POST /sfx/:name/play — fire a sound effect on-air now. */
  async playSfx(name: string): Promise<SfxPlayResult> {
    return this.call<SfxPlayResult>(`/sfx/${encodeURIComponent(name)}/play`, {
      method: "POST",
      admin: true,
    });
  }
}
