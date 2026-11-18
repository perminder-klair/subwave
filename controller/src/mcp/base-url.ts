/**
 * Where the stdio MCP server finds the controller when SUBWAVE_API_URL is
 * unset. Dev exposes the controller directly on :7701; prod publishes only
 * Caddy, which mounts it at :7700/api. Hard-coding either in the shared
 * .mcp.json breaks the other — and :7700 alone is no tie-breaker, since in dev
 * it is the Next dev server, which has no /api proxy. So probe each candidate's
 * /health and take the first that answers like the controller.
 *
 * An explicit SUBWAVE_API_URL always wins and is never probed. When nothing
 * answers (the stack is down at launch) it falls back to the first candidate,
 * which is the pre-existing default, so the tool errors read as before.
 */
import { fetchWithTimeout } from "../util/fetch-timeout.js";

export const DEFAULT_API_URLS = ["http://localhost:7701", "http://localhost:7700/api"];

const PROBE_TIMEOUT_MS = 1500;

/** True when `base` answers GET /health with the controller's JSON status. */
export async function answersAsController(base: string): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(`${base}/health`, { timeoutMs: PROBE_TIMEOUT_MS });
    if (!res.ok) return false;
    const body = (await res.json()) as unknown;
    return typeof (body as { status?: unknown })?.status === "string";
  } catch {
    return false;
  }
}

export async function resolveApiUrl(
  explicit: string | undefined,
  probe: (base: string) => Promise<boolean> = answersAsController,
  candidates: string[] = DEFAULT_API_URLS,
): Promise<string> {
  if (explicit?.trim()) return explicit.trim().replace(/\/$/, "");
  for (const base of candidates) {
    if (await probe(base)) return base;
  }
  return candidates[0];
}
