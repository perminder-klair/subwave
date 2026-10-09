import { type DeepsecPlugin, defineConfig } from "deepsec/config";
import { subwaveLiquidsoapIpc } from "./matchers/subwave-liquidsoap-ipc.js";
import { subwaveShellRender } from "./matchers/subwave-shell-render.js";

// NOTE: ignorePaths / priorityPaths / promptAppend do NOT belong here.
//
// `deepsec scan` reads those three only from data/<projectId>/config.json — it
// never looks at the project declaration below, and it fails SILENTLY rather
// than erroring, so a copy here looks applied while the scan happily indexes
// everything. That matters for this repo specifically: without the exclusions,
// the scan pulls in .env, controller/.env, docker/.env and state/settings.json,
// whose contents (ADMIN_PASS, the Navidrome password, LLM/TTS API keys) then
// ride into the model prompt on `process`.
//
// The real config is .deepsec/data/subwave/config.json. Edit it there.

// deepsec's built-in matchers cover no `.sh` or `.liq` file, so without these
// the Icecast render (entrypoint + AIO supervisor) and radio.liq — both named
// in INFO.md's threat model — are never candidates and never reach `process`.
const subwavePlugin: DeepsecPlugin = {
  name: "subwave",
  matchers: [subwaveShellRender, subwaveLiquidsoapIpc],
};

export default defineConfig({
  projects: [
    { id: "subwave", root: ".." },
    // <deepsec:projects-insert-above>
  ],
  plugins: [subwavePlugin],
  // deepsec's own defaults are the codex agent and, for claude, an older Opus.
  // Pinned so the README's bare `pnpm deepsec process` runs what the last pass
  // ran; --agent / --model still override.
  defaultAgent: "claude",
  defaultModel: "claude-opus-5-5",
});
