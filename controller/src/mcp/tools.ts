/**
 * The SUB/WAVE MCP tool set — the single source of truth for both transports
 * (the controller's HTTP mount in routes/mcp.ts, and the standalone stdio
 * server in mcp-subwave/src/index.ts). `registerSubwaveTools(server, client)`
 * registers all 17 tools on an McpServer; each tool is a thin wrapper over one
 * controller endpoint via the shared SubwaveClient.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SubwaveError, type RequestStatus, type SubwaveClient } from "./client.js";

/** Render any value as a text content block. */
function text(value: unknown): { type: "text"; text: string } {
  return {
    type: "text",
    text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Wrap a tool body so SubwaveError (and anything else) becomes an MCP error
 * result the agent can read, rather than a thrown exception. The error text is
 * already actionable — see client.ts — so we pass it straight through.
 */
async function run(
  body: () => Promise<{ content: ReturnType<typeof text>[]; structuredContent?: Record<string, unknown> }>,
) {
  try {
    return await body();
  } catch (err) {
    const message =
      err instanceof SubwaveError
        ? err.message
        : `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
    return { content: [text(message)], isError: true };
  }
}

// Song requests resolve in the booth in the background (LLM match + TTS
// intro); the receipt is polled until it lands. The default budget covers a
// slow homelab LLM leg; past it the tool hands back the id for a later status
// call. The HTTP transport passes a shorter budget (see routes/mcp.ts) so an
// unauthenticated POST can't hold a connection open for the full 45s.
const REQUEST_POLL_MS = 2_000;
const DEFAULT_REQUEST_POLL_BUDGET_MS = 45_000;

export interface RegisterToolsOptions {
  /** Max time subwave_request_song blocks polling for an outcome. */
  requestPollBudgetMs?: number;
}

/** Shared output shape for the request tools — mirrors GET /request/:id. */
const REQUEST_OUTPUT = {
  requestId: z.string(),
  status: z.string().describe("'pending' | 'resolved' | 'failed' | 'unknown'"),
  success: z.boolean().optional(),
  ack: z.string().nullable().optional(),
  track: z.object({ title: z.string(), artist: z.string().nullable() }).nullable().optional(),
  queuePosition: z.number().nullable().optional(),
  message: z.string().nullable().optional(),
};

function summarizeRequest(requestId: string, status: RequestStatus): string {
  if (status.status === "resolved") {
    return (
      `Queued "${status.track?.title}" by ${status.track?.artist} at position ` +
      `${status.queuePosition}. DJ says: ${status.ack ?? "(no ack)"}`
    );
  }
  if (status.status === "failed") {
    return `Request not fulfilled: ${status.message ?? "no match in the library."}`;
  }
  if (status.status === "pending") {
    return (
      `Request ${requestId} is still being matched in the booth — check the outcome ` +
      `with subwave_request_status in a little while.`
    );
  }
  return `Request ${requestId} is unknown to the controller — it was pruned or lost to a restart.`;
}

/** Register the full SUB/WAVE tool set on an McpServer. */
export function registerSubwaveTools(
  server: McpServer,
  client: SubwaveClient,
  options: RegisterToolsOptions = {},
): void {
  const pollBudgetMs = options.requestPollBudgetMs ?? DEFAULT_REQUEST_POLL_BUDGET_MS;
  const pollBudgetLabel = `~${Math.round(pollBudgetMs / 1000)}s`;
  // -------------------------------------------------------------------------
  // subwave_health — is the station up?
  // -------------------------------------------------------------------------
  server.registerTool(
    "subwave_health",
    {
      title: "SUB/WAVE liveness",
      description:
        "Check that the SUB/WAVE controller is reachable and the station reports on-air. " +
        "Call this first when other tools fail — it separates 'stack is down' from " +
        "'endpoint-specific problem'.",
      inputSchema: {},
      outputSchema: { onAir: z.boolean() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () =>
      run(async () => {
        const onAir = await client.health();
        return {
          content: [text(onAir ? "SUB/WAVE is on-air." : "Controller reachable, but not reporting on-air.")],
          structuredContent: { onAir },
        };
      }),
  );

  // -------------------------------------------------------------------------
  // subwave_now_playing — what's on-air right now
  // -------------------------------------------------------------------------
  server.registerTool(
    "subwave_now_playing",
    {
      title: "Now playing on SUB/WAVE",
      description:
        "Get the track currently on-air on the SUB/WAVE radio station, plus station " +
        "context (time, weather, dominant mood) and live listener counts. Call this " +
        "before requesting a song or sending a DJ update so the request fits what's " +
        "actually playing (e.g. \"something slower than this\").",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () =>
      run(async () => {
        const data = await client.nowPlaying();
        return { content: [text(data)] };
      }),
  );

  // -------------------------------------------------------------------------
  // subwave_station_state — queue, history, booth log
  // -------------------------------------------------------------------------
  server.registerTool(
    "subwave_station_state",
    {
      title: "SUB/WAVE queue & history",
      description:
        "Get the SUB/WAVE station state: the upcoming track queue, recently played " +
        "history, and the DJ booth log. Use this to check whether a requested song " +
        "already landed in the queue, or to review what the DJ has been doing.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () =>
      run(async () => {
        const data = await client.state();
        return { content: [text(data)] };
      }),
  );

  // -------------------------------------------------------------------------
  // subwave_schedule — shows, personas, weekly grid
  // -------------------------------------------------------------------------
  server.registerTool(
    "subwave_schedule",
    {
      title: "SUB/WAVE schedule",
      description:
        "Get the station's programming: DJ personas, shows, and the weekly schedule " +
        "grid (interpreted in the station's timezone, which is included). Useful for " +
        "knowing who's on air and whether a guest show or programme is running before " +
        "firing 'banter' or 'programme-*' segments.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () =>
      run(async () => {
        const data = await client.schedule();
        return { content: [text(data)] };
      }),
  );

  // -------------------------------------------------------------------------
  // subwave_session — the DJ's live session transcript
  // -------------------------------------------------------------------------
  server.registerTool(
    "subwave_session",
    {
      title: "SUB/WAVE DJ session",
      description:
        "Get the DJ's current stream session — its identity (show or auto period/mood, " +
        "start time) and the recent transcript of spoken segments and events. This is " +
        "what the DJ 'remembers'; read it to keep an announcement coherent with what " +
        "was just said on-air.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () =>
      run(async () => {
        const data = await client.session();
        return { content: [text(data)] };
      }),
  );

  // -------------------------------------------------------------------------
  // subwave_request_song — ask the AI DJ to play something
  // -------------------------------------------------------------------------
  server.registerTool(
    "subwave_request_song",
    {
      title: "Request a song",
      description:
        "Submit a natural-language song request to the SUB/WAVE AI DJ. Accepts a " +
        "specific track or artist (\"play Midnight City by M83\"), a vibe (\"something " +
        "calm for a rainy evening\"), or a follow-on like \"more like this\". The DJ " +
        "matches it against the library, writes a spoken intro, and queues the track — " +
        "it does NOT interrupt the current song. The controller resolves requests in " +
        `the background; this tool waits (up to ${pollBudgetLabel}) for the outcome and reports it ` +
        "(if still pending after that, poll subwave_request_status with the returned id). " +
        "Public endpoint, rate-limited to 1 request per 20s and 8 per hour; requests " +
        "pause when nobody is listening. For an exact, non-LLM pick use " +
        "subwave_search_library + subwave_queue_track instead.",
      inputSchema: {
        request: z
          .string()
          .min(1)
          .max(280)
          .describe(
            "What to play, in plain language. A song, an artist, a mood, or " +
              "'more like this'. Max 280 chars.",
          ),
        requester: z
          .string()
          .max(40)
          .optional()
          .describe("Name to credit the request to on-air. Defaults to 'anon'."),
      },
      outputSchema: REQUEST_OUTPUT,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    ({ request, requester }) =>
      run(async () => {
        const receipt = await client.requestSong(request, requester);
        let status: RequestStatus = { status: receipt.status || "pending" };
        const deadline = Date.now() + pollBudgetMs;
        while (status.status === "pending" && Date.now() < deadline) {
          await sleep(REQUEST_POLL_MS);
          status = await client.requestStatus(receipt.requestId);
        }
        return {
          content: [text(summarizeRequest(receipt.requestId, status))],
          structuredContent: { requestId: receipt.requestId, ...status },
        };
      }),
  );

  // -------------------------------------------------------------------------
  // subwave_request_status — poll an earlier request's outcome
  // -------------------------------------------------------------------------
  server.registerTool(
    "subwave_request_status",
    {
      title: "Check a song request",
      description:
        "Look up the outcome of a previously submitted song request by its requestId " +
        "(returned by subwave_request_song). Status 'unknown' means the id was pruned " +
        "or lost to a controller restart — stop polling.",
      inputSchema: {
        requestId: z.string().min(1).describe("The requestId from subwave_request_song."),
      },
      outputSchema: REQUEST_OUTPUT,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ requestId }) =>
      run(async () => {
        const status = await client.requestStatus(requestId);
        return {
          content: [text(summarizeRequest(requestId, status))],
          structuredContent: { requestId, ...status },
        };
      }),
  );

  // -------------------------------------------------------------------------
  // subwave_search_library — deterministic library search (admin)
  // -------------------------------------------------------------------------
  server.registerTool(
    "subwave_search_library",
    {
      title: "Search the music library",
      description:
        "Search the station's music library by title/artist/album terms. Returns up to " +
        "12 queue-ready tracks (id, title, artist, album, year, genre, duration, mood " +
        "tags). ADMIN endpoint — no LLM, no rate limit. Pair with subwave_queue_track " +
        "to queue an exact result.",
      inputSchema: {
        q: z.string().min(1).describe("Search terms, e.g. 'boards of canada roygbiv'."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ q }) =>
      run(async () => {
        const data = await client.searchLibrary(q);
        return { content: [text(data)] };
      }),
  );

  // -------------------------------------------------------------------------
  // subwave_queue_track — queue an exact track (admin)
  // -------------------------------------------------------------------------
  server.registerTool(
    "subwave_queue_track",
    {
      title: "Queue an exact track",
      description:
        "Push a specific track onto the play queue — an operator pick, no DJ intro, no " +
        "rate limit. ADMIN endpoint. Pass the fields of a subwave_search_library " +
        "result; id and title are required. The track plays after the queue ahead of " +
        "it; it does not interrupt the current song.",
      inputSchema: {
        id: z.string().min(1).describe("Track id from subwave_search_library."),
        title: z.string().min(1),
        artist: z.string().optional(),
        album: z.string().optional(),
        year: z.number().optional(),
        genre: z.string().optional(),
      },
      outputSchema: {
        ok: z.boolean(),
        track: z.object({ title: z.string(), artist: z.string().nullable() }),
        queuePosition: z.number(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (track) =>
      run(async () => {
        const result = await client.queueTrack(track);
        return {
          content: [
            text(
              `Queued "${result.track.title}"${result.track.artist ? ` by ${result.track.artist}` : ""} ` +
                `at position ${result.queuePosition}.`,
            ),
          ],
          structuredContent: { ...result },
        };
      }),
  );

  // -------------------------------------------------------------------------
  // subwave_skip_track — force-end the current track (admin)
  // -------------------------------------------------------------------------
  server.registerTool(
    "subwave_skip_track",
    {
      title: "Skip the current track",
      description:
        "Force-end the track playing right now and move to the next item — an operator " +
        "override, since every listener hears the same broadcast. ADMIN endpoint. Use " +
        "sparingly and deliberately; there is intentionally no listener-facing skip.",
      inputSchema: {},
      outputSchema: { ok: z.boolean() },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    () =>
      run(async () => {
        const result = await client.skipTrack();
        return { content: [text("Track skipped — the next queue item is taking over.")], structuredContent: { ...result } };
      }),
  );

  // -------------------------------------------------------------------------
  // subwave_dj_announce — put a spoken update on-air (admin)
  // -------------------------------------------------------------------------
  server.registerTool(
    "subwave_dj_announce",
    {
      title: "Send a DJ announcement",
      description:
        "Make the SUB/WAVE DJ speak an update on-air — a news flash, a weather warning, " +
        "a shout-out, anything you want voiced. ADMIN endpoint: needs admin credentials " +
        "on this MCP connection.\n" +
        "mode='styled' (default) treats your text as an instruction and lets the DJ " +
        "rewrite it in persona before speaking — best when you give a topic or rough " +
        "wording. mode='raw' speaks your text verbatim — best for exact wording (use " +
        "raw for emergency alerts so nothing gets paraphrased).\n" +
        "placement='solo' (default) is a heavy-ducked solo DJ moment; placement=" +
        "'over-track' is lightly ducked so the DJ talks over the playing song.\n" +
        "sfx names a sound effect from the station library to air under the opening " +
        "words as an attention stinger (e.g. 'airhorn' before an emergency warning) — " +
        "list valid names with subwave_list_sfx.",
      inputSchema: {
        message: z
          .string()
          .min(1)
          .max(500)
          .describe("The update to put on-air — finished words, or a topic to voice. Max 500 chars."),
        mode: z
          .enum(["styled", "raw"])
          .default("styled")
          .describe("'styled': DJ rewrites it in persona. 'raw': spoken verbatim."),
        placement: z
          .enum(["solo", "over-track"])
          .default("solo")
          .describe("'solo': ducked solo moment. 'over-track': voiced over the current song."),
        sfx: z
          .string()
          .optional()
          .describe(
            "Optional sound-effect name to air under the announcement's opening words " +
              "(defaults available on most stations: airhorn, record-scratch, applause, " +
              "whoosh, drum-roll). Omit for voice only.",
          ),
      },
      outputSchema: {
        ok: z.boolean(),
        mode: z.enum(["raw", "styled"]),
        kind: z.string(),
        spoken: z.string(),
        sfx: z.string().nullable().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    ({ message, mode, placement, sfx }) =>
      run(async () => {
        const kind = placement === "over-track" ? "link" : "dj-speak";
        const result = await client.djSay(message, mode, kind, sfx);
        const stinger = result.sfx ? ` with '${result.sfx}' stinger` : "";
        return {
          content: [text(`On-air now (${result.mode}/${result.kind}${stinger}): "${result.spoken}"`)],
          structuredContent: { ...result },
        };
      }),
  );

  // -------------------------------------------------------------------------
  // subwave_dj_segment — fire a scripted voice segment (admin)
  // -------------------------------------------------------------------------
  server.registerTool(
    "subwave_dj_segment",
    {
      title: "Fire a DJ voice segment",
      description:
        "Trigger one of the SUB/WAVE DJ's scripted voice segments on demand: " +
        "'station-id' (station ident), 'hourly' (time/weather check-in), 'link' (a " +
        "between-track auto-DJ link), 'banter' (multi-voice guest exchange — needs a " +
        "guest show on air), or 'programme-intro'/'programme-feature'/'programme-outro' " +
        "(episode beats — need a programme show on air; check subwave_schedule first). " +
        "ADMIN endpoint. This is an operator override: it bypasses the DJ's frequency " +
        "gate. For a custom message, use subwave_dj_announce; for a data-driven " +
        "segment (weather, news, …), use subwave_run_skill.",
      inputSchema: {
        type: z
          .enum([
            "station-id",
            "hourly",
            "link",
            "banter",
            "programme-intro",
            "programme-feature",
            "programme-outro",
          ])
          .describe("Which scripted segment to fire."),
      },
      outputSchema: { ok: z.boolean(), type: z.string(), spoken: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    ({ type }) =>
      run(async () => {
        const result = await client.djSegment(type);
        return {
          content: [text(`Fired '${result.type}' segment. On-air: "${result.spoken}"`)],
          structuredContent: { ...result },
        };
      }),
  );

  // -------------------------------------------------------------------------
  // subwave_list_skills — the skill catalogue (admin)
  // -------------------------------------------------------------------------
  server.registerTool(
    "subwave_list_skills",
    {
      title: "List DJ skills",
      description:
        "List the DJ's between-track segment skills — the built-ins (weather, news, " +
        "traffic, curiosity, album-anniversary, library-deep-cut, web-search) plus any " +
        "operator-authored skills — with their labels, cooldowns, and enabled state. " +
        "ADMIN endpoint. Use the 'name' field with subwave_run_skill.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () =>
      run(async () => {
        const data = await client.listSkills();
        return { content: [text(data)] };
      }),
  );

  // -------------------------------------------------------------------------
  // subwave_run_skill — run a named skill segment now (admin)
  // -------------------------------------------------------------------------
  server.registerTool(
    "subwave_run_skill",
    {
      title: "Run a DJ skill",
      description:
        "Run one of the DJ's segment skills on-air right now — e.g. 'weather' for a " +
        "weather check-in, 'news' for a headlines beat, or any custom skill the " +
        "operator has installed. The segment director fetches real data and voices it " +
        "in persona. ADMIN endpoint; operator override (ignores cooldowns and the " +
        "frequency gate, works even on a disabled skill). List valid names with " +
        "subwave_list_skills.",
      inputSchema: {
        name: z.string().min(1).describe("Skill name from subwave_list_skills, e.g. 'weather'."),
      },
      outputSchema: {
        ok: z.boolean(),
        name: z.string(),
        spoken: z.string().nullable(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    ({ name }) =>
      run(async () => {
        const result = await client.runSkill(name);
        return {
          content: [
            text(
              result.spoken
                ? `Ran skill '${result.name}'. On-air: "${result.spoken}"`
                : `Ran skill '${result.name}' — it chose to stay silent this time.`,
            ),
          ],
          structuredContent: { ...result },
        };
      }),
  );

  // -------------------------------------------------------------------------
  // subwave_list_sfx — the sound-effects library (admin)
  // -------------------------------------------------------------------------
  server.registerTool(
    "subwave_list_sfx",
    {
      title: "List sound effects",
      description:
        "List the station's sound-effects library — short stingers (≤10s) the DJ can " +
        "play under a voice line or on their own. ADMIN endpoint. Use a returned name " +
        "with subwave_play_sfx or the sfx parameter of subwave_dj_announce.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () =>
      run(async () => {
        const data = await client.listSfx();
        return { content: [text(data)] };
      }),
  );

  // -------------------------------------------------------------------------
  // subwave_play_sfx — fire a sound effect on-air (admin)
  // -------------------------------------------------------------------------
  server.registerTool(
    "subwave_play_sfx",
    {
      title: "Play a sound effect on-air",
      description:
        "Fire a sound effect from the station library on-air immediately — mixed over " +
        "the programme with a light music duck (it does not stop the song). ADMIN " +
        "endpoint. Good as a standalone attention cue; to pair a stinger with spoken " +
        "words, prefer subwave_dj_announce's sfx parameter so the two are aligned. " +
        "List valid names with subwave_list_sfx.",
      inputSchema: {
        name: z
          .string()
          .min(1)
          .describe("Effect name, e.g. 'airhorn'. List valid names with subwave_list_sfx."),
      },
      outputSchema: { ok: z.boolean(), name: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    ({ name }) =>
      run(async () => {
        const result = await client.playSfx(name);
        return {
          content: [text(`Sound effect '${result.name}' is going to air.`)],
          structuredContent: { ...result },
        };
      }),
  );

  // -------------------------------------------------------------------------
  // subwave_refresh_playlist — rebuild the fallback auto-playlist (admin)
  // -------------------------------------------------------------------------
  server.registerTool(
    "subwave_refresh_playlist",
    {
      title: "Refresh the auto-playlist",
      description:
        "Rebuild the Liquidsoap fallback auto-playlist for the current mood right now, " +
        "instead of waiting for the scheduled refresh. ADMIN endpoint. Use after big " +
        "library changes or a mood shift; it does not affect the current track or the " +
        "request queue.",
      inputSchema: {},
      outputSchema: { ok: z.boolean() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    () =>
      run(async () => {
        const result = await client.refreshPlaylist();
        return { content: [text("Auto-playlist rebuilt for the current mood.")], structuredContent: { ...result } };
      }),
  );
}
