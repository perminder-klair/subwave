# Request a song from Home Assistant

Posts a listener request to SUB/WAVE. The station returns `202` immediately and queues the song after the current track. It does not cut what is playing.

Public endpoint, no token. The live URL is on Admin → Connect → Integrations.

| Install | URL |
|---|---|
| Caddy (usual) | `http://HOST:7700/api/request` |
| Controller only | `http://HOST:7701/request` |

## Install

1. `secrets.yaml`:

   ```yaml
   subwave_request_url: http://HOST:7700/api/request
   ```

2. `configuration.yaml`. This is a mapping under `homeassistant`, not a list item and not a line next to `script:`:

   ```yaml
   homeassistant:
     packages:
       subwave_request: !include subwave_request.yaml
   ```

   Copy `subwave_request.yaml` into the config directory (the same folder as `configuration.yaml`). A config that already splits `script`, `rest_command`, and `input_text` into their own files can keep that layout. The package merges with those includes. Do not paste this file's keys into `scripts.yaml`.

3. Copy `custom_sentences/en/subwave_request.yaml` to `<config>/custom_sentences/en/`. Create those two folders if they are missing. Home Assistant only loads sentences from that path. It is not an `!include`, and it does not belong beside `scripts.yaml` or inside `input_text/`.

4. Check the configuration, then restart Home Assistant or use **Developer tools → YAML → Reload YAML configuration** and reload custom sentences. Later edits to `subwave_request.yaml` also need that YAML reload. Linking a Person to a user does not.

`input_text` cannot be longer than 255 characters. The station accepts 280. The dashboard box uses 255. A voice request is not limited by the box.

## Dashboard button

Add an Entities card with:

- `input_text.subwave_request` — the song, artist, or vibe
- `script.subwave_send_request` — the button

Empty text does nothing. A `202` clears the box. Anything else leaves the text so you can retry.

## Voice

This is Home Assistant Assist in the companion app, not the car's Google or Gemini button. That button cannot open the Assist dialog or pass a song name through.

- "subwave play Midnight City"
- "play Midnight City on subwave"
- "request something calm on the radio"

Assist says "Asked SUB/WAVE for ...". It cannot read the station's reply. Look at the station queue and the booth log for the outcome.

The request shows up as the next queued track, under the name from the section below. It waits out the song already on air.

## Whose name goes on the air

The first word of the Person whose user id is the logged-in account. "John Doe" is credited as `John`.

Being logged into the Android app is not enough. Home Assistant does not expose the account's display name to a template. The template only sees `context.user_id`, then looks for a Person with that id. No match, and the request is credited as `home`.

Fix: **Settings → People → your person → Allow login**, and choose the same user the phone is logged in as. Save. The next request picks up the new link. No YAML reload.

When the lookup misses, the script raises one persistent notification, `SUB/WAVE credited this request as home`. The same notification id is replaced on the next miss, so it does not stack.

The Developer tools template editor always reports `'context' is undefined`. It is not a service call, so it never has a user. Test by sending a request while logged in, then look at the queue credit or that notification.

## Limits

Voice and the button share the Home Assistant host's IP. Station defaults are a 60 second cooldown and 8 accepted requests per hour from that IP. A second request while the first is still queued is refused until it leaves the queue. Requests can also be closed in station settings.

## Troubleshooting

| What you see | Cause |
|---|---|
| Configuration will not start, `input_text` max must be at most 255 | The box was set to the station's 280-character limit. Use `max: 255`. |
| Package did not load, or `packages` failed validation | The include was a list item (`- subwave_request:`). Drop the dash. |
| Assist does not understand the phrase | `custom_sentences/en/subwave_request.yaml` is missing, or custom sentences were not reloaded. |
| Assist says "Unexpected error" | The spoken reply tried to read the HTTP result. An intent script can only speak the sentence slots (`query`). Reload YAML after updating the package. |
| Assist says it asked, and the queue has nothing new | The track is behind the one on air, or the station refused (cooldown, one request already queued, requests closed). The booth log has the raw text. Assist cannot say the refusal. |
| Credit is `home` | No Person is linked to that login, or the session had no user. See the section above. The persistent notification is the same miss. |
| Template editor: `'context' is undefined` | Expected. The editor has no logged-in user. |
