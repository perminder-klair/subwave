# Request a song from Home Assistant

Posts a listener request to SUB/WAVE from a Home Assistant dashboard or from Assist. The station answers `202` at once, which only means it took the request. It then looks for a track and adds it to the end of its queue, so the song plays after anything already queued, not always straight after the current one. It never cuts what is playing.

Public endpoint, no token. The station shows its own URL on **Admin → Connect → API**: the endpoint is `POST /request` under **Listener Requests**, and its full URL is the **Base** at the top of that tab followed by `/request`.

| Install | URL |
|---|---|
| Standard (`docker-compose.yml`, Caddy on port 7700) | `http://HOST:7700/api/request` |
| Your own reverse proxy (`docker-compose.byo.yml`) | `https://YOUR-HOST/api/request` through the proxy, or `http://HOST:7701/request` straight to the controller. The direct URL works from another machine only while `BIND_ADDRESS` is left at its default `0.0.0.0`; with `127.0.0.1`, use the proxy URL. |

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

4. Check the configuration, then restart Home Assistant. The first install needs a restart, not a reload: the package brings in `rest_command` and `intent_script`, and **Developer tools → YAML → All YAML configuration** (or **Settings → System → Restart → Quick reload**) only reloads integrations that are already running. After that first restart, an edit to either file needs only that reload. Linking a Person to a user needs no reload.

`input_text` cannot be longer than 255 characters. The station accepts 280. The dashboard box uses 255. A voice request has no box, but the station still refuses one over 280 characters.

## Dashboard button

Add an Entities card with:

- `input_text.subwave_request` — the song, artist, or vibe
- `script.subwave_send_request` — the button

The package also adds `script.subwave_post_request`, the step the button and Assist share. It needs no card.

Empty text does nothing. A `202` clears the box. Anything else leaves the text so you can retry, and the Home Assistant log says why (see Troubleshooting).

## Voice

This is Home Assistant Assist in the companion app, not the car's Google or Gemini button. That button cannot open the Assist dialog or pass a song name through.

- "subwave play Midnight City"
- "play Midnight City on subwave"
- "request something calm on the radio"

Assist answers "Asked SUB/WAVE for ..." whatever the station replies, refusals included. It reports an error only when the station cannot be reached (see Troubleshooting). For what became of a request, look at **Admin → Dash → Requests** on the station.

The request joins the end of the station's queue under the name from the section below.

## Whose name goes on the air

The first word of the Person whose user id is the logged-in account. "John Doe" is credited as `John`.

Being logged into the Android app is not enough. Home Assistant does not expose the account's display name to a template. The template only sees `context.user_id`, then looks for a Person with that id. No match, and the request is credited as `home`.

Fix: **Settings → People → your person → Allow login**, and choose the same user the phone is logged in as. Save. The next request picks up the new link. No YAML reload.

When the lookup misses, the script raises one persistent notification, `SUB/WAVE credited this request as home`. The same notification id is replaced on the next miss, so it does not stack. The notification follows the lookup, not the name, so a linked Person whose first name is `home` raises nothing.

A voice satellite (a Home Assistant Voice speaker, an ESPHome or Wyoming satellite, a VoIP phone) runs Assist without a person's login behind it. Its requests are always credited as `home` and always raise the notification. Use Assist in the companion app to be credited by name.

The station screens the name too. A name that matches the station's name, a persona's name, or `dj`, `admin`, `host`, `mod` or `moderator`, or that has no characters the station can air, is credited as `anon`.

The Developer tools template editor always reports `'context' is undefined`. It is not a service call, so it never has a user. Test by sending a request while logged in, then look at the queue credit or that notification.

## Limits

Voice and the button share the Home Assistant host's IP, so they share its limits. With the station's default settings:

- 60 seconds between requests from that IP.
- 8 accepted requests an hour from that IP, and 30 an hour across the whole station.
- One request at a time from that IP. The next is refused until the last one has finished playing, and never for longer than 10 minutes after it was sent. A request that queued nothing does not hold the next one.
- At most 6 listener requests waiting in the queue.

They are set in **Admin → Settings → Station → Listener requests** (under **Advanced**), next to the switch that closes requests altogether. Two opt-in settings also refuse requests while nobody is listening: **Pause DJ when empty** and **Pause when the room is empty**. Both are off by default.

## Troubleshooting

| What you see | Cause |
|---|---|
| Configuration will not start, `input_text` max must be at most 255 | The box was set to the station's 280-character limit. Use `max: 255`. |
| Package did not load, or `packages` failed validation | The include was a list item (`- subwave_request:`). Drop the dash. |
| After the first install, the button does nothing and the log says `Action rest_command.subwave_request_song not found`, or Assist says `Unknown intent RequestSubwave` | Home Assistant was reloaded, not restarted. Restart it once. |
| Assist does not understand the phrase | `custom_sentences/en/subwave_request.yaml` is missing or in the wrong folder, or the YAML configuration was not reloaded after editing it. |
| Assist says "An unexpected error occurred" | Home Assistant could not reach the station: a wrong host or port in `secrets.yaml`, the station is down, or the network refused the connection (this fails at once), or the station did not answer within 10 seconds. The Home Assistant log has the `rest_command` error. |
| The button leaves the text in the box, or Assist says it asked and the queue has nothing new | The station refused the request, or took it and then queued nothing. The station keeps no record of a refusal, but Home Assistant logs it: **Settings → System → Logs** shows a `rest_command` warning, `Error. Url: … Status code 429` (one of the limits above), `400` (the text was empty, over 280 characters, or had nothing left once the station cleaned it) `503` (requests are closed, the station is starting up, or it is paused while nobody is listening), or `404`/`405` (the URL is missing `/api` on a standard install, so it reached the web app instead of the station). A request the station took is in **Admin → Dash → Requests** with its outcome: the request was not something the station can play, no track matched, the match played too recently (a 120-minute repeat cooldown by default), it is blocked, the show is clean and the match is explicit, or it was already queued. |
| Credit is `home` | No Person is linked to that login, the session had no user, or the request came from a voice satellite. See the section above. The persistent notification is the same miss. |
| Credit is `anon` | The station replaced the name. See the section above. |
| Template editor: `'context' is undefined` | Expected. The editor has no logged-in user. |
