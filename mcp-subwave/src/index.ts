#!/usr/bin/env node
/**
 * subwave-mcp — an MCP server that lets an agent drive the SUB/WAVE radio.
 *
 * Exposes the SUB/WAVE controller's request and DJ surfaces as MCP tools so a
 * model can: see what's on-air, request a song (the AI DJ matches, intros, and
 * queues it), put a spoken update on-air, and fire scripted voice segments.
 *
 * Transport: stdio — this server is meant to run next to a local controller.
 *
 * Environment:
 *   SUBWAVE_API_URL     controller base URL (default http://localhost:7701;
 *                       prod behind Caddy is http://localhost:7700/api)
 *   SUBWAVE_ADMIN_USER  admin Basic-auth user  — required for DJ control tools
 *   SUBWAVE_ADMIN_PASS  admin Basic-auth pass  — required for DJ control tools
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { SubwaveClient, SubwaveError } from "./client.js";

const client = new SubwaveClient({
  baseUrl: (process.env.SUBWAVE_API_URL || "http://localhost:7701").replace(/\/$/, ""),
  adminUser: process.env.SUBWAVE_ADMIN_USER,
  adminPass: process.env.SUBWAVE_ADMIN_PASS,
});

const server = new McpServer({
  name: "subwave-mcp",
  version: "0.1.0",
});

/** Render any value as a text content block. */
function text(value: unknown): { type: "text"; text: string } {
  return {
    type: "text",
    text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
  };
}

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

// ---------------------------------------------------------------------------
// subwave_now_playing — what's on-air right now
// ---------------------------------------------------------------------------
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
      return { content: [text(data)], structuredContent: data };
    }),
);

// ---------------------------------------------------------------------------
// subwave_station_state — queue, history, booth log
// ---------------------------------------------------------------------------
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
      return { content: [text(data)], structuredContent: data };
    }),
);

// ---------------------------------------------------------------------------
// subwave_request_song — ask the AI DJ to play something
// ---------------------------------------------------------------------------
server.registerTool(
  "subwave_request_song",
  {
    title: "Request a song",
    description:
      "Submit a natural-language song request to the SUB/WAVE AI DJ. Accepts a " +
      "specific track or artist (\"play Midnight City by M83\"), a vibe (\"something " +
      "calm for a rainy evening\"), or a follow-on like \"more like this\". The DJ " +
      "matches it against the library, writes a spoken intro, and queues the track — " +
      "it does NOT interrupt the current song; track-end is the only transition. " +
      "Public endpoint, rate-limited to 1 request per 20s and 8 per hour.",
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
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  ({ request, requester }) =>
    run(async () => {
      const result = await client.requestSong(request, requester);
      const summary = result.success
        ? `Queued "${result.track?.title}" by ${result.track?.artist} at position ` +
          `${result.queuePosition}. DJ says: ${result.ack ?? "(no ack)"}`
        : `Request not fulfilled: ${result.message ?? "no match in the library."}`;
      return { content: [text(summary)], structuredContent: { ...result } };
    }),
);

// ---------------------------------------------------------------------------
// subwave_dj_announce — put a spoken update on-air (admin)
// ---------------------------------------------------------------------------
server.registerTool(
  "subwave_dj_announce",
  {
    title: "Send a DJ announcement",
    description:
      "Make the SUB/WAVE DJ speak an update on-air — a news flash, a shout-out, a " +
      "heads-up, anything you want voiced. ADMIN endpoint: needs SUBWAVE_ADMIN_USER " +
      "and SUBWAVE_ADMIN_PASS set for this server.\n" +
      "mode='styled' (default) treats your text as an instruction and lets the DJ " +
      "rewrite it in persona before speaking — best when you give a topic or rough " +
      "wording. mode='raw' speaks your text verbatim — best for exact wording.\n" +
      "placement='solo' (default) is a heavy-ducked solo DJ moment; placement=" +
      "'over-track' is lightly ducked so the DJ talks over the playing song.",
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
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  ({ message, mode, placement }) =>
    run(async () => {
      const kind = placement === "over-track" ? "link" : "dj-speak";
      const result = await client.djSay(message, mode, kind);
      return {
        content: [text(`On-air now (${result.mode}/${result.kind}): "${result.spoken}"`)],
        structuredContent: { ...result },
      };
    }),
);

// ---------------------------------------------------------------------------
// subwave_dj_segment — fire a scripted voice segment (admin)
// ---------------------------------------------------------------------------
server.registerTool(
  "subwave_dj_segment",
  {
    title: "Fire a DJ voice segment",
    description:
      "Trigger one of the SUB/WAVE DJ's scripted voice segments on demand: " +
      "'station-id' (station ident), 'hourly' (time/weather check-in), or 'link' " +
      "(a between-track auto-DJ link). ADMIN endpoint — needs SUBWAVE_ADMIN_USER / " +
      "SUBWAVE_ADMIN_PASS. This is an operator override: it bypasses the DJ's " +
      "frequency gate. For a custom message, use subwave_dj_announce instead.",
    inputSchema: {
      type: z
        .enum(["station-id", "hourly", "link"])
        .describe("Which scripted segment to fire."),
    },
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

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only — stdout is the MCP channel.
  console.error("subwave-mcp ready on stdio");
}

main().catch((err) => {
  console.error("subwave-mcp failed to start:", err);
  process.exit(1);
});
