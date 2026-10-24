# Alexa voice control

SUB/WAVE can expose one direct Alexa Custom Skill per station deployment. Once
configured, an operator can say:

> “Alexa, start Subwave Radio.”

Alexa verifies the request at `https://your-station.example/api/alexa`, and the
controller returns an `AudioPlayer.Play` directive pointing the Echo directly at
the station’s selected public stream mount. No Lambda
function, phone, Chromecast, or separate streaming service is required.

This is a direct Custom Skill, not Google-style catalog discovery. The phrase
`Subwave Radio` is the fixed Alexa invocation name configured in the Alexa
Developer Console. The station name in Admin → Settings → Station is dynamic:
it is used in the spoken confirmation, so changing it does not require changing
the invocation name or Skill ID.

## Requirements

- The station must be reachable over public HTTPS.
- `SITE_URL` must be set to the public station origin, for example
  `https://radio.example.com`.
- The selected stream mount must be publicly playable. SUB/WAVE exposes
  `/stream.mp3` always, plus optional `/stream.opus`, `/stream.flac`, and
  `/stream.aac` mounts.
- Stream password/listener authentication must be off. Alexa cannot provide the
  station’s listener password to an Echo through this integration.
- Create one Alexa Custom Skill and use its Skill ID for this deployment. A
  single SUB/WAVE deployment intentionally supports one active Skill ID.

The integration is disabled by default.

## SUB/WAVE settings

1. Open Admin → Connect → Alexa.
2. Open the **Host your own Alexa skill** card.
3. Leave the integration disabled until the Alexa endpoint and interaction model
   have been created.
4. Paste the Alexa Skill ID into **Alexa Skill ID**.
5. Enable the integration and save station settings.

If listener authentication is enabled, SUB/WAVE refuses to enable Alexa because
the Echo would not be able to fetch the stream. Turning on Alexa does not expose
the admin API or station settings; only the Alexa endpoint is public.

## Alexa Developer Console setup

The exact console labels can change, but the required values are:

1. Create an **Alexa Custom Skill**.
2. Choose **English (India)** and **English (US)** as the initial locales if both
   audiences are needed.
3. Set the invocation name to **subwave radio**. Do not use the station’s
   dynamic name as the invocation name unless you deliberately want to change
   the Alexa model whenever the station name changes.
4. Use the custom skill interaction model. Add these intents and sample
   utterances:

   | Intent | Example utterances |
   | --- | --- |
   | `StartRadioIntent` | `start the radio`, `play the radio`, `start listening` |
   | `PlayRadioIntent` | `play the station`, `play radio` |
   | `AMAZON.ResumeIntent` | use the built-in intent |
   | `AMAZON.PauseIntent` | use the built-in intent |
   | `AMAZON.StopIntent` | use the built-in intent |
   | `AMAZON.CancelIntent` | use the built-in intent |
   | `AMAZON.HelpIntent` | use the built-in intent |
   | `AMAZON.FallbackIntent` | use the built-in intent |

   There are no station-name slots in this MVP. Each skill belongs to one
   station deployment, so the user invokes that deployment’s fixed skill name.

5. In the skill’s endpoint configuration, select **HTTPS** and set:

   `https://your-station.example/api/alexa`

   Replace the host with the value of `SITE_URL`. Keep Alexa’s certificate
   checking enabled; the SUB/WAVE endpoint uses Amazon’s official SDK adapter to
   verify the request signature and timestamp.

6. In Admin → Connect → Alexa, select the stream format to return to Alexa.
   Optional formats must be enabled in the stream settings first.
7. Build the model, copy the **Skill ID**, paste it into SUB/WAVE’s Alexa Skill
   ID setting, enable the integration, and save.
8. Use the Alexa Developer Console test simulator or a linked Echo to test the
   invocation.

## Supported behavior

| Voice command | Result |
| --- | --- |
| `Alexa, start Subwave Radio` | Starts the live stream and speaks `Starting STATION NAME.` |
| `Alexa, ask Subwave Radio to start the radio` | Same as start |
| `Alexa, pause Subwave Radio` | Stops the live stream and says `Radio paused.` |
| `Alexa, resume Subwave Radio` | Starts the stream again at the current live edge |
| `Alexa, stop Subwave Radio` | Stops playback and says `Radio stopped.` |

Live radio has no seekable recording position. Resume therefore starts a fresh
connection at the live edge; it cannot resume the same song position.

When Icecast is offline, start/resume speaks `The station is currently offline.`
and returns no audio directive. The station’s current name is read from settings
at request time, so a name change is reflected without restarting the controller.

## Security and operational notes

- The endpoint is disabled until both `enabled: true` and a Skill ID are saved.
- The configured Skill ID is checked by the official Alexa SDK before request
  handlers run.
- Alexa request signatures and timestamps are verified by
  `ask-sdk-express-adapter`; the controller does not accept an unsigned JSON
  shortcut.
- The stream URL is intentionally public. Do not enable this integration for a
  station that requires listener authentication.
- This feature does not publish the station to an Alexa-wide radio catalog.
  Users need the skill enabled on their Alexa account/device and must invoke the
  fixed skill name.
- One station deployment maps to one skill and one selected public stream URL. A
  multi-station directory, random station selection, and “next station” are not
  part of this first version.

## Acceptance checklist

Before asking users to try the skill, verify:

- `curl -I https://your-station.example/stream.mp3` reaches the public stream.
- `SITE_URL` is the HTTPS origin users reach, without a trailing `/`.
- Admin settings show Alexa enabled and the correct Skill ID.
- The Alexa endpoint is configured as `/api/alexa`, not `/alexa`.
- Start works while the station is online.
- Pause stops playback, and resume starts at the live edge.
- Stopping the broadcast produces the offline spoken response and no audio.
- Enabling listener authentication is rejected while Alexa is enabled.
