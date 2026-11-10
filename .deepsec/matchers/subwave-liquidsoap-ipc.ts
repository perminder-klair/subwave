import type { CandidateMatch, MatcherPlugin } from "deepsec/config";
import { regexMatcher } from "deepsec/config";

/**
 * Trust boundaries in the Liquidsoap mixer.
 *
 * deepsec ships no matcher for `.liq`, so `radio.liq` is never a candidate.
 * It is the far side of the controller's file IPC: it polls next.txt /
 * say.txt / intro.txt / jingle-now.txt (whose `annotate:` URIs carry track
 * titles and artists from the music server), turns them into requests,
 * shells out, answers telnet commands on :1234, and writes the JSON markers
 * the controller and the public `/now-playing` route read back. Each of
 * those is a place untrusted text crosses a parser.
 */
export const subwaveLiquidsoapIpc: MatcherPlugin = {
  slug: "subwave-liquidsoap-ipc",
  description: "Liquidsoap reading IPC files, building requests, shelling out, serving telnet, writing markers",
  noiseTier: "normal",
  filePatterns: ["liquidsoap/**/*.liq", "docker/**/*.liq"],
  examples: [
    `  ret = process.run(timeout=float_of_int(timeout), cmd)`,
    `  lines = process.read.lines("ffprobe #{process.quote(f)}")`,
    `  raw = file.contents(next_file)`,
    `    r = request.create(uri)`,
    `server.register(namespace="dj", "cancel", cancel_cmd)`,
    `  file.write(data=json, atomic=true, "/var/sub-wave/now-playing.json")`,
  ],
  match(content): CandidateMatch[] {
    return regexMatcher(
      "subwave-liquidsoap-ipc",
      [
        { regex: /\bprocess\.(?:run|read)\b/, label: "shell command executed from Liquidsoap" },
        { regex: /\bfile\.contents\s*\(/, label: "reads a controller-written IPC file" },
        { regex: /\brequest\.create\s*\(/, label: "request built from a string (URI / annotate: parsing)" },
        { regex: /\bserver\.register\s*\(/, label: "telnet command handler" },
        { regex: /\bfile\.write\s*\(/, label: "marker file written for the controller / public routes" },
      ],
      content,
    );
  },
};
