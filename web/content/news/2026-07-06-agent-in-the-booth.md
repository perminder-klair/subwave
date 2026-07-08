---
title: Let an agent work the booth
date: 2026-07-06
category: Feature
author: The SUB/WAVE desk
excerpt: The station's MCP server grew from five tools to seventeen. An AI agent can now search the library, queue exact tracks, run skills, and sound an airhorn before an emergency announcement.
---

An operator wired an agent to Environment Canada so weather warnings for his area go straight to air, read by the DJ. The one thing he couldn't do was sound the airhorn first. Now he can, and the agent side of the station got a lot bigger while we were at it.

## What's new

The MCP server (`mcp-subwave/` in the repo) is how an AI agent like Claude talks to your station. It launched with five tools; it now has seventeen. An agent can read the schedule and the DJ's session transcript, or search the library and queue an exact track with no rate limit. It can run any skill, skip the current track (operators only), and fire a sound effect on air. Announcements can carry a stinger too: name an effect and it plays under the DJ's first words. Song requests also report properly again; the tool now waits for the booth's verdict and comes back with the matched track and the DJ's ack.

## How to use it

The station now serves MCP over HTTP, so there's nothing to install — point your client at `<your-station>/api/mcp` and pass your admin credentials as an `Authorization` header:

```
claude mcp add --transport http subwave https://your-station/api/mcp \
  --header "Authorization: Basic $(printf '%s' "$ADMIN_USER:$ADMIN_PASS" | base64)"
```

The admin **Connect → MCP** tab hands you that command with your station's URL already filled in. Claude Desktop and Claude Code both work, and there's still a local stdio server if you'd rather not expose the endpoint. For the alert trick, call `subwave_dj_announce` with `mode: raw` so nothing gets paraphrased, and `sfx: airhorn`.

## Why it helps

The station already runs itself; this gives your other automations a proper way in. A weather watcher, a calendar bot, a home server that wants to say the backup finished: anything that can speak MCP can now put a voice on your air, airhorn included, with the same guardrails the admin panel uses.
