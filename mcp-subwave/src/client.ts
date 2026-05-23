/**
 * HTTP client for the SUB/WAVE controller API.
 *
 * The controller is a local Express service (default :7701 in dev, or behind
 * the Caddy edge at :7700/api in prod). Two endpoint classes matter here:
 *   - public, rate-limited:   GET /now-playing, GET /state, POST /request
 *   - admin, Basic-auth gated: POST /dj/say, POST /dj/segment
 *
 * Every failure is turned into a SubwaveError carrying a message written for
 * the agent — it says what went wrong AND what to do about it, so the model
 * can recover (wait out a cooldown, fix an env var) instead of guessing.
 */

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
}

export interface RequestResult {
  success: boolean;
  /** DJ's spoken acknowledgement of the request, when matched. */
  ack?: string;
  /** Operator-facing message on a miss / closed / throttled request. */
  message?: string;
  track?: { title: string; artist: string };
  /** 1-based position in the upcoming queue. */
  queuePosition?: number;
}

export interface DjSayResult {
  ok: boolean;
  mode: "raw" | "styled";
  kind: "dj-speak" | "link";
  /** The exact words sent to air (post-LLM rewrite when mode=styled). */
  spoken: string;
}

export interface DjSegmentResult {
  ok: boolean;
  type: string;
  spoken: string;
}

export class SubwaveClient {
  constructor(private readonly config: SubwaveConfig) {}

  private get hasAdminCreds(): boolean {
    return Boolean(this.config.adminUser && this.config.adminPass);
  }

  private authHeader(): Record<string, string> {
    if (!this.hasAdminCreds) return {};
    const raw = `${this.config.adminUser}:${this.config.adminPass}`;
    return { authorization: `Basic ${Buffer.from(raw).toString("base64")}` };
  }

  /** Core fetch wrapper: timeout, JSON parsing, and agent-readable errors. */
  private async call<T>(
    path: string,
    init: { method?: string; body?: unknown; admin?: boolean } = {},
  ): Promise<T> {
    const url = `${this.config.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);

    let res: Response;
    try {
      res = await fetch(url, {
        method: init.method ?? "GET",
        signal: controller.signal,
        headers: {
          ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
          ...(init.admin ? this.authHeader() : {}),
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new SubwaveError(
        `Could not reach the SUB/WAVE controller at ${url} (${reason}). ` +
          `Check that the stack is running and that SUBWAVE_API_URL points at it ` +
          `(dev default http://localhost:7701, prod http://localhost:7700/api).`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after")) || undefined;
      const body = await res.json().catch(() => ({}) as Record<string, unknown>);
      throw new SubwaveError(
        typeof body.message === "string"
          ? body.message
          : `Rate limited — wait ${retryAfter ?? "a moment"}s before requesting again. ` +
              `The controller caps song requests at 1 per 20s and 8 per hour.`,
        retryAfter,
      );
    }

    if (res.status === 401 || res.status === 403) {
      throw new SubwaveError(
        `The controller rejected admin credentials for ${path}. ` +
          (this.hasAdminCreds
            ? `The SUBWAVE_ADMIN_USER / SUBWAVE_ADMIN_PASS given to this MCP server don't match ` +
              `ADMIN_USER / ADMIN_PASS in the controller's .env.`
            : `This endpoint needs admin auth. Set SUBWAVE_ADMIN_USER and SUBWAVE_ADMIN_PASS ` +
              `in this MCP server's environment to the controller's ADMIN_USER / ADMIN_PASS.`),
      );
    }

    if (res.status === 503) {
      throw new SubwaveError(
        `Song requests are temporarily closed on the station (REQUESTS_DISABLED is set on the controller).`,
      );
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }

    if (!res.ok) {
      const msg =
        body && typeof body === "object" && "error" in body
          ? String((body as Record<string, unknown>).error)
          : `HTTP ${res.status} from ${path}`;
      throw new SubwaveError(msg);
    }

    return body as T;
  }

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

  /** POST /request — submit a natural-language song request to the AI DJ. */
  async requestSong(text: string, requester?: string): Promise<RequestResult> {
    return this.call<RequestResult>("/request", {
      method: "POST",
      body: { text, name: requester },
    });
  }

  /** POST /dj/say — make the DJ speak on-air (admin). */
  async djSay(
    text: string,
    mode: "raw" | "styled",
    kind: "dj-speak" | "link",
  ): Promise<DjSayResult> {
    return this.call<DjSayResult>("/dj/say", {
      method: "POST",
      admin: true,
      body: { text, mode, kind },
    });
  }

  /** POST /dj/segment — fire a scripted voice segment on demand (admin). */
  async djSegment(type: "station-id" | "hourly" | "link"): Promise<DjSegmentResult> {
    return this.call<DjSegmentResult>("/dj/segment", {
      method: "POST",
      admin: true,
      body: { type },
    });
  }
}
