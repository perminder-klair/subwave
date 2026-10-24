# AI-agent setup guide for the Alexa development skill

This guide is for an AI coding agent helping a user install, configure, build,
deploy, and test this Alexa skill package for the user's own radio deployment.
It is intentionally separate from the short end-user README so an agent has a
clear operating procedure and a complete test inventory.

The package is designed for a personal Alexa Developer account and the
development stage of a Custom Skill. It is not a publishing or certification
procedure.

## Agent operating rules

Before changing anything, the agent should:

1. Work from the repository root and confirm that the requested package is
   `alexa-skill-package`.
2. Ask the user for any missing deployment values instead of guessing them:
   - the user's public HTTPS Alexa endpoint;
   - the user's desired skill name;
   - the user's lowercase invocation name;
   - the user's Alexa Developer account/profile;
   - the user's radio Skill ID after the skill has been created.
3. Never place a real endpoint, station name, Skill ID, account email,
   credential, access token, or radio secret in a committed file, log, issue,
   or chat transcript.
4. Never use the repository owner's endpoint, station name, Skill ID, ASK
   profile, AWS account, or deployment credentials.
5. Deploy only `skill-metadata` to the user's development skill. Do not
   publish, certify, or deploy `skill-infrastructure` for this package.
6. Preserve unrelated working-tree changes. Do not reset, clean, or delete
   files merely to make the package build.
7. Treat `CancelRequestIntent` and `ReplaceRequestIntent` as state-changing
   tests. Ask for confirmation before running them against a real pending
   request.
8. Treat reminder consent as a two-stage Alexa workflow. After the user agrees
   to the skill's reminder question, Alexa asks for permission to update
   reminders; the successful test response is “I approve”, not a second generic
   “yes”.

If a command requests AWS or Lambda credentials even though the user is using
the external HTTPS endpoint in this package, stop and ask the user. Do not
enter unrelated credentials just to get through an interactive prompt.

## What this package contains

The package supplies:

- a neutral `skill.json` template;
- three localized Custom Skill interaction models;
- an external HTTPS endpoint configuration;
- no Lambda function;
- no station-specific values;
- no Skill ID or Alexa credentials.

The generated files are local and ignored by Git. The tracked files use
`.template` suffixes and neutral replacement tokens. The user's backend must
already provide the Alexa endpoint and radio behavior.

## Prerequisites

The user needs all of the following before the agent starts deployment:

- an Amazon account with access to the [Alexa Developer Console][console];
- a public, reachable HTTPS deployment of the radio backend;
- a valid TLS certificate accepted by Alexa;
- the backend Alexa route, normally the user's own `/api/alexa` URL;
- access to the radio's Admin → Connect → Alexa configuration;
- an Alexa device registered in the Alexa app;
- the Alexa app/device signed in to the same Amazon account used for the
  development skill;
- Node.js and npm;
- Git, if the user is obtaining this package from the repository.

This package does not require AWS Lambda. It points Alexa directly at the
user's external HTTPS endpoint. The endpoint must be configured before Alexa
can complete a meaningful request.

## 1. Install and authenticate ASK CLI

Run these commands in a terminal. The global installation may require the
user's normal npm permission setup.

```bash
node --version
npm --version
npm install --global ask-cli
ask --version
```

Create a named ASK CLI profile for the user's own Amazon Developer account:

```bash
ask configure --profile my-radio
```

The normal flow opens a browser for Amazon Developer authentication. If the
agent is working on a headless machine, use:

```bash
ask configure --no-browser --profile my-radio
```

ASK CLI prints a URL and a code. The user opens the URL in a browser, signs in
to the intended Amazon Developer account, approves the request, and returns to
the terminal. Keep the profile name private and do not paste credentials or
tokens into the repository.

The account used here matters: a development skill is normally visible to
Alexa devices signed in to the same Amazon account. If the user authenticates
ASK CLI with account A but the device's Alexa app uses account B, the device
will generally not show or launch the development skill.

Useful command help for the installed ASK CLI version is:

```bash
ask configure --help
ask init --help
ask deploy --help
```

Do not assume that commands from old ASK CLI tutorials exist. In particular,
check the installed version's help before using any dialog or SMAPI command.

## 2. Create the user's development skill and find its Skill ID

If the user does not already have a Custom Skill, create one in the [Alexa
Developer Console][console]. Create a Custom Skill for the intended locale;
the package supplies `en-US`, `en-IN`, and `hi-IN` models.

The Skill ID is the identifier that binds the Alexa request to the user's
backend. It looks like:

```text
amzn1.ask.skill.<uuid>
```

Preferred ways to find it:

1. In the Developer Console skill list, use **Copy Skill ID** below the skill
   name.
2. On the skill's Endpoint page, use the **Copy** button beside the Skill ID.
3. As a convenient URL check, inspect the browser URL while the skill is open.
   Many console URLs contain a segment such as
   `/build/custom/amzn1.ask.skill.<uuid>/`. Copy only the exact
   `amzn1.ask.skill.<uuid>` value, without a trailing slash or query string.

The URL layout can change, so the console's **Copy Skill ID** action is the
authoritative method. Do not infer a Skill ID from the skill name.

Initialize the local ASK project from the repository root:

```bash
ask init --profile my-radio
```

When the interactive command asks for values:

- select the user's existing Custom Skill, or enter the user's Skill ID;
- set the skill package path to `./alexa-skill-package`;
- leave the Lambda code path empty because this package uses an external
  endpoint;
- do not replace the tracked templates with an unrelated generated project.

`ask init` writes local project state such as `ask-resources.json`. It is
ignored by this repository and must not be shared as a credential bundle.

## 3. Configure the user's endpoint and generate the package

From the repository root, create the private local configuration:

```bash
cp alexa-skill-package/alexa.env.example alexa-skill-package/alexa.env
$EDITOR alexa-skill-package/alexa.env
```

Use values belonging to the user. A safe shape is:

```dotenv
ALEXA_ENDPOINT_URL=https://your-domain.example/api/alexa
ALEXA_SKILL_NAME=Example Radio
ALEXA_INVOCATION_NAME=example radio
ALEXA_DESCRIPTION=A voice skill for Example Radio.
ALEXA_SUMMARY=Control Example Radio with Alexa.
ALEXA_TESTING_INSTRUCTIONS=Use the example radio invocation to test the development skill.
```

The endpoint must be HTTPS and must not contain credentials, a query string,
or a URL fragment. The generator validates the endpoint and rejects common
invalid invocation names. The invocation name must be lowercase, contain at
least two words, and must not be a launch phrase such as `open`, `play`,
`start`, or `ask`.

Validate first, then generate:

```bash
npm run alexa:prepare -- --check
npm run alexa:prepare
```

The generator creates these ignored files:

```text
alexa-skill-package/skill.json
alexa-skill-package/interactionModels/custom/en-US.json
alexa-skill-package/interactionModels/custom/en-IN.json
alexa-skill-package/interactionModels/custom/hi-IN.json
```

If the user changes the endpoint, name, invocation, or descriptions, run the
generator again. Never hand-edit the generated files as a substitute for
updating `alexa.env`.

## 4. Pair the Skill ID with the radio backend

The Alexa skill and the radio backend must use the same Skill ID.

In the user's radio deployment:

1. Open **Admin → Connect → Alexa**.
2. Enter the exact Skill ID copied from the Developer Console.
3. Confirm that the backend's Alexa endpoint is the same HTTPS URL placed in
   `ALEXA_ENDPOINT_URL`.
4. Configure or select the stream that the Alexa listener should use.
5. Use the page's connection/test controls before enabling the integration.

The backend validates the Skill ID format and uses it to reject requests for a
different skill. A single deployment should not be configured with a
different user's Skill ID. Do not expose listener credentials or signed stream
URLs while collecting setup information.

## 5. Build and deploy the development skill

Run the final local validation and deploy only skill metadata:

```bash
npm run alexa:prepare -- --check
npm run alexa:prepare
ask deploy --profile my-radio --target skill-metadata
```

`skill-metadata` updates the skill manifest and interaction models. It does
not publish the skill and does not certify it. Do not use:

```bash
ask deploy --target skill-infrastructure
```

That target is for infrastructure resources and is outside this package's
external-endpoint setup.

After deployment, use the Developer Console to confirm that all three locale
models are present. If the console reports model validation errors, fix the
locale/model error, regenerate the package, and deploy metadata again.

## 6. Enable and test the development stage

### Developer Console simulator

1. Open the user's skill in the [Alexa Developer Console][console].
2. Open the **Test** tab.
3. Change **Test is disabled** to **Development**.
4. Select the locale being tested.
5. Use the text or voice simulator with the invocation name from
   `ALEXA_INVOCATION_NAME`.

The simulator is the fastest way to test every intent and every locale without
changing the physical device's playback state.

### Alexa app and physical device

For a device test, the Alexa app and the device must use the same Amazon
account that owns the development skill:

1. Open the Alexa app.
2. Go to **More → Skills & Games → Your Skills → Dev**.
3. Select the user's skill and enable or launch it if required.
4. Speak the invocation name followed by the request.

Examples, using a placeholder invocation:

```text
Alexa, open <invocation name>
Alexa, ask <invocation name> to request [a song]
Alexa, ask <invocation name> what is playing
Alexa, ask <invocation name> what show is on now
```

Built-in audio controls may be spoken without the invocation after the skill
has started:

```text
Alexa, pause
Alexa, resume
Alexa, stop
```

If the skill is missing from **Your Skills → Dev**, check the Amazon account,
the locale, and that the Developer Console Test tab is set to Development.
Published-skill discovery is not required for this workflow.

## 7. Complete intent inventory

Each of `en-US`, `en-IN`, and `hi-IN` contains the same supported intent set.
The sample utterances are localized; the names below are the stable intent
names that the backend receives. The source definitions are the locale files
under `interactionModels/custom/`: use the tracked
`en-US.json.template`, `en-IN.json.template`, or `hi-IN.json.template` file to
inspect slots, utterances, and locale-specific wording before preparing or
adapting a model. Generated `.json` files are local output and must not be
shared.

### Custom intents

| Intent | Example test utterance | Notes |
| --- | --- | --- |
| `StartRadioIntent` | “start the radio” | Starts playback using the configured radio endpoint. |
| `PlayRadioIntent` | “play the station” | Starts playback using the configured radio endpoint. |
| `RequestSongIntent` | “request [song] by [artist]” | The general song request intent. Keep title, artist, album, lyrics, language, genre, mood, and energy requests here; do not create duplicate matching intents. Uses `requestText`. |
| `DedicationIntent` | “dedicate [song] to [person or group]” | Collects the song and recipient in separate dialog turns, accepts people, groups, family, friends, and “myself”, then sends the dedication through the normal request pipeline. |
| `RequestReminderIntent` | “remind me about my request” | Offers a reminder only for a queued request with a reliable two-to-thirty-minute estimate; the skill confirmation is followed by Alexa's explicit permission workflow. |
| `RequestStatusIntent` | “what is the status of my request” | Reads the current listener request and its queue status. |
| `CancelRequestIntent` | “cancel my request” | Cancels the listener's waiting request. State-changing; test carefully. |
| `ReplaceRequestIntent` | “replace my request with [song]” | Replaces the waiting request. Uses `requestText`; state-changing. |
| `NowPlayingIntent` | “what is playing right now” | Reports the current track. |
| `WhatIsPlayingIntent` | “tell me what is playing” | Alternate current-playing wording. |
| `CurrentSongIntent` | “tell me the current song” | Current song lookup wording. |
| `PreviousTrackIntent` | “what played before this” | Reports the previous track when history is available. |
| `UpcomingIntent` | “what plays next” | Reports the next/upcoming track. |
| `NextSongIntent` | “tell me the next song” | Alternate next-track wording. |
| `WhatIsNextIntent` | “what comes next on the radio” | Alternate next-track wording. |
| `QueuePreviewIntent` | “what songs are coming up” | Reads a preview of upcoming queue items. |
| `StationStatusIntent` | “is the station online” | Reports station/stream status. |
| `MoreLikeThisIntent` | “play more like this” | Requires a current track; selects a local-library similarity match, excluding the current track and recent history. |
| `AnotherByArtistIntent` | “another song by this artist” | Requires a current track; selects another local-library track by the current artist, excluding the current track and recent history. |
| `RecentTracksIntent` | “what played recently” | Returns recent playback history in deterministic order. |
| `TrackDetailsIntent` | “tell me the album of this song” | Uses the `detailType` slot. Values are `album`, `artist`, `year`, `genre`, `language`, and `all`. Missing metadata must be reported as unavailable, not invented. |
| `CurrentShowIntent` | “what show is on now” | Reports the active show/DJ, or a clear no-active-show response. |

The `requestText` slot is used by `RequestSongIntent` and
`ReplaceRequestIntent`. The `detailType` slot is used only by
`TrackDetailsIntent` and is represented by the localized `AlexaDetailType`
slot type.

Representative Hindi/Hinglish phrases include:

- `abhi kya baj raha hai` — current playback;
- `next gaana batao` — next track;
- `aise hi aur gaane bajao` — more like this;
- `same artist ka ek aur gaana` — another by the artist;
- `recent tracks batao` — recent tracks;
- `song ka genre batao` — track detail;
- `abhi kaunsa show chal raha hai` — current show;
- `मेरी request cancel करो` — cancel request.

### Built-in intents

| Intent | Example | Notes |
| --- | --- | --- |
| `AMAZON.HelpIntent` | “help” | Explains supported radio commands. |
| `AMAZON.StopIntent` | “stop” | Stops the skill/audio session. |
| `AMAZON.CancelIntent` | “cancel” | Cancels the current Alexa interaction; do not confuse it with the custom request cancellation. |
| `AMAZON.PauseIntent` | “pause” | Pauses audio when supported by the active session. |
| `AMAZON.ResumeIntent` | “resume” | Resumes paused audio. |
| `AMAZON.FallbackIntent` | An unrelated phrase | Confirms that the request was not understood and gives a useful recovery prompt. |
| `AMAZON.YesIntent` | “yes” | Context-dependent confirmation. |
| `AMAZON.NoIntent` | “no” | Context-dependent rejection. |
| `AMAZON.NavigateHomeIntent` | “go home” | Returns to the skill's home/entry state when supported. |

`StartRadioIntent` and `PlayRadioIntent` are included in every locale template
as the explicit start/play controls. Keep the endpoint, station name, Skill ID,
and invocation-specific values in the user's ignored local configuration; do
not add them to a tracked model or generated package shared with another user.

The package keeps these built-in intents alongside the custom intent
definitions so the locale model can be prepared as one complete skill model.

## 8. Agent smoke-test matrix

Run the read-only tests first. Use the Developer Console simulator for each
locale and record the response, HTTP result, and backend log correlation.

### Session and built-in controls

- Launch the skill with the user's invocation.
- `AMAZON.HelpIntent`: ask for help.
- `AMAZON.PauseIntent`: pause an active stream.
- `AMAZON.ResumeIntent`: resume it.
- `AMAZON.StopIntent`: stop the session/audio.
- `AMAZON.CancelIntent`: cancel an in-progress Alexa dialogue.
- `AMAZON.FallbackIntent`: send an unrelated phrase.
- `AMAZON.YesIntent` and `AMAZON.NoIntent`: run only where a confirmation prompt
  exists.
- `AMAZON.NavigateHomeIntent`: say “go home” in a session that supports it.

### Playback custom intents

Run both explicit playback commands and verify that Alexa receives the normal
audio response for the user's configured radio:

```text
start the radio
play the station
```

### Read-only custom intents

Run each of these with a station that has known playback and queue data:

```text
what is the status of my request
what is playing right now
tell me what is playing
tell me the current song
what played before this
what plays next
tell me the next song
what comes next on the radio
what songs are coming up
is the station online
what played recently
what is the album of this song
what is the artist of this song
what is the year of this song
what is the genre of this song
what is the language of this song
give me all details about this song
what show is on now
who is the DJ right now
```

For `TrackDetailsIntent`, explicitly exercise every `detailType` value:

```text
album
artist
year
genre
language
all
```

Also test a track with missing album, year, genre, or language metadata. The
expected response says that the value is unavailable; it must not fabricate a
value.

Test the new selection intents in both states:

1. With a current track and known local-library candidates, run “more like
   this” and “another song by this artist”; verify that the selected track is
   not the current track, is not in recent history, and is submitted through
   the normal request/ledger pipeline.
2. With no current track, run both intents; verify the clear no-current-track
   response and verify that no queue or ledger entry is created.
3. With a current track but no eligible match, verify the no-match response and
   verify that no unrelated substitution is queued.
4. Run “what show is on now” while a show is active and when no show is active;
   verify both the normal result and the no-show fallback.

### Request-changing custom intents

Use a disposable test request or the user's explicit approval:

```text
request [a known song]
what is the status of my request
replace my request with [another known song]
cancel my request
```

Verify that:

- the initial request creates the expected queue/ledger record;
- status reports the same request rather than an unrelated request;
- replacement updates the intended waiting request;
- cancellation removes or marks only the intended request;
- Alexa receives a spoken acknowledgement for success and failure;
- backend logs show the same Skill ID and request correlation for each call.

Do not use a real listener's pending request for destructive tests without
confirmation.

### Dedicated-request and reminder flows

Exercise the two-turn dedication flow with both a person and a group:

```text
dedicate a song
<provide a known song>
<provide a person or group>
```

Verify that the recipient is stored as dedication data, is not sent as part of
the song-search prompt, and that the queue item and request ledger carry the
dedication. The backend rejects unsafe or overlong recipient text and refuses
dedications when station voice is disabled.

For reminders, first create a disposable request and wait until it has a
reliable queue estimate. Then test:

```text
remind me about my request
yes
i approve
```

The first `yes` accepts the skill's offer. Alexa then owns the standard
permission prompt; `i approve` grants permission and returns a
`Connections.Response` to the skill. Verify the spoken confirmation, the
one-minute lead time, and the reminder token in the request ledger. Also test
`no` at both prompts, an estimate shorter than two minutes, an estimate longer
than thirty minutes, a still-pending request, and a cancelled/replaced
request. The latter must not leave an active reminder behind.

## 9. Verification checklist

The agent should report each item explicitly rather than saying only “build
passed”:

- `npm run alexa:prepare -- --check` passed;
- `npm run alexa:prepare` generated all three locale models;
- `skill.json` contains the user's endpoint only in the local ignored output;
- the generated models contain the supported custom and built-in intent definitions from the locale templates;
- `ask deploy --target skill-metadata` completed for the user's profile;
- Developer Console Test is set to Development;
- the device and Alexa app use the same Amazon account as ASK CLI;
- the matching Skill ID is configured in the radio backend;
- each supported intent was tested in the relevant locale;
- no-current-track, no-match, missing-metadata, and no-show fallbacks were
  tested;
- request-changing tests were approved and their queue/ledger effects were
  checked;
- no publish, certification, Lambda deployment, or infrastructure deployment
  was performed.

## 10. Troubleshooting

### The skill is not visible on the Alexa device

Confirm that:

- ASK CLI authenticated to the same Amazon account used by the Alexa app;
- the device is registered to that account;
- the Developer Console Test tab is set to **Development**;
- the skill's locale and invocation name match the spoken test;
- the skill metadata deployment finished successfully.

### Alexa reports an endpoint or certificate failure

Confirm that the endpoint:

- is publicly reachable from the internet;
- uses HTTPS on the expected public port;
- presents a valid certificate chain and hostname;
- points to the user's `/api/alexa` route;
- is not a private LAN address, localhost address, or URL with credentials;
- has matching Skill ID configuration in the backend.

Use the Developer Console test result and backend logs to distinguish an Alexa
transport failure from an application response failure. Do not paste tokens or
private request payloads into public issue trackers.

### Skill ID mismatch

Copy the value again from **Copy Skill ID** in the console and compare it with
the backend's Admin → Connect → Alexa value. Remove whitespace and do not copy
the URL's trailing slash or query string. The value must begin with
`amzn1.ask.skill.`.

### NLU selects the wrong intent

Use an utterance close to the model sample, confirm the correct locale is
selected, regenerate the package, redeploy `skill-metadata`, and retest in the
Development stage. Song title, artist, album, lyrics, language, genre, mood,
and energy requests belong to `RequestSongIntent`; do not add a duplicate
intent for one of those request forms.

### ASK CLI says there is no project or package

Run `ask init --profile <profile>` from the repository root and set the skill
package path to `./alexa-skill-package`. Check that the generated local
`ask-resources.json` points at the intended skill. Do not copy another user's
ASK project state into this package.

### Generated values are stale or personal

Update the ignored `alexa-skill-package/alexa.env`, run the prepare command
again, and inspect the generated files locally. If a personal value appears in
a tracked diff, stop and remove it from the diff before committing or sharing.

## Official references

- [Alexa Developer Console][console]
- [ASK CLI quick start][ask-quick-start]
- [ASK CLI overview][ask-overview]
- [ASK CLI command reference][ask-reference]
- [Test and debug a custom skill][test-debug]
- [Test your skill in the Developer Console][console-test]
- [Handle requests sent by Alexa][request-handling]

[console]: https://developer.amazon.com/alexa/console/ask
[ask-quick-start]: https://developer.amazon.com/en-US/docs/alexa/smapi/quick-start-alexa-skills-kit-command-line-interface.html
[ask-overview]: https://developer.amazon.com/en-US/docs/alexa/smapi/ask-cli-intro.html
[ask-reference]: https://developer.amazon.com/en-US/docs/alexa/smapi/ask-cli-command-reference.html
[test-debug]: https://developer.amazon.com/en-US/docs/alexa/custom-skills/test-and-debug-a-custom-skill.html
[console-test]: https://developer.amazon.com/en-US/docs/alexa/devconsole/test-your-skill.html
[request-handling]: https://developer.amazon.com/en-US/docs/alexa/custom-skills/handle-requests-sent-by-alexa.html
