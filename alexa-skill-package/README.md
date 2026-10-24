# Set up the Alexa skill manually

This package lets you create and test your own development version of this
radio listener Alexa skill. It uses your Amazon Developer account and
your own radio backend. It does not publish a skill, certify a skill, or deploy
an AWS Lambda function.

The package is safe to share because the tracked files do not contain your
radio URL, station name, Skill ID, or Alexa credentials.

## Before you begin

You need:

- an Amazon account that can access the [Alexa Developer Console][console];
- an Alexa device registered to that same Amazon account;
- Node.js and npm installed on your computer;
- this repository checked out locally;
- a radio backend already deployed at a public HTTPS address;
- the backend's Alexa route, normally ending in `/api/alexa`;
- access to the radio's **Admin → Connect → Alexa** settings.

Alexa must be able to reach the endpoint from the public internet. A localhost,
private LAN address, self-signed certificate, or endpoint requiring basic
authentication will not work.

This package uses an external HTTPS endpoint. You do not need an AWS Lambda
function for it.

## 1. Open a terminal in the repository

Run the remaining commands from the repository root—the directory that
contains `package.json` and `alexa-skill-package`.

```bash
cp alexa-skill-package/alexa.env.example alexa-skill-package/alexa.env
```

Do not commit this new `alexa.env` file. It is intentionally ignored by Git.

## 2. Create or select your Alexa Custom Skill

Open the [Alexa Developer Console][console] and sign in with the Amazon
account you want to use for this skill.

If you are creating the skill for the first time:

1. Choose **Create Skill**.
2. Give it your own skill name.
3. Choose **Custom** as the skill type.
4. If Alexa asks how to host the skill, choose the option for your own
   endpoint, such as **Provision your own**.
5. Create the skill in the locale you want to use. This package supplies
   `en-US`, `en-IN`, and `hi-IN` models.

Do not use somebody else's Skill ID or Developer Console account.

### Find your Skill ID

The Skill ID looks like this:

```text
amzn1.ask.skill.<uuid>
```

The safest way to copy it is to use **Copy Skill ID** below the skill name in
the Developer Console, or the **Copy** button on the skill's Endpoint page.

You can also find it in the browser URL while the skill is open. Many console
URLs contain a section similar to:

```text
/build/custom/amzn1.ask.skill.<uuid>/
```

Copy only the `amzn1.ask.skill.<uuid>` part. Do not copy the trailing slash,
query string, or any other URL text. Console URL formats can change, so use the
console's copy button when the URL does not contain the Skill ID clearly.

Keep this Skill ID private and use it only to connect your own skill to your
own backend.

## 3. Install and authenticate ASK CLI

ASK CLI is Amazon's command-line tool for managing Alexa skills. Install it
globally:

```bash
node --version
npm --version
npm install --global ask-cli
ask --version
```

Create a named profile for the same Amazon Developer account:

```bash
ask configure --profile my-radio
```

ASK CLI normally opens a browser. Sign in to the intended Amazon account,
approve access, and return to the terminal.

On a computer where the browser cannot open automatically, use:

```bash
ask configure --no-browser --profile my-radio
```

ASK CLI will display a URL and a code. Open the URL on another computer,
complete Amazon authentication, and follow the instructions shown in the
terminal.

Do not paste passwords, access tokens, or credential files into this
repository. The profile name `my-radio` is only an example; choose any private
name you like.

## 4. Initialize the local ASK project

From the repository root, run:

```bash
ask init --profile my-radio
```

When ASK CLI asks questions:

- select the Custom Skill you created above, or provide its Skill ID;
- set the skill package path to `./alexa-skill-package`;
- leave the Lambda code path empty;
- do not choose a hosted Lambda or infrastructure deployment for this package.

The command creates local ASK project state such as `ask-resources.json`. Do
not share that file if it contains your account or skill details.

## 5. Fill in your private package settings

Open the file you copied:

```bash
$EDITOR alexa-skill-package/alexa.env
```

Replace the example values with your own values:

```dotenv
ALEXA_ENDPOINT_URL=https://your-domain.example/api/alexa
ALEXA_SKILL_NAME=Example Radio
ALEXA_INVOCATION_NAME=example radio
ALEXA_DESCRIPTION=A voice skill for Example Radio.
ALEXA_SUMMARY=Control Example Radio with Alexa.
ALEXA_TESTING_INSTRUCTIONS=Use the example radio invocation to test the development skill.
```

Use these rules:

- `ALEXA_ENDPOINT_URL` must be your public HTTPS Alexa endpoint.
- Do not include a username, password, query string, or URL fragment in the
  endpoint.
- `ALEXA_SKILL_NAME` is the name shown in your Alexa Developer account.
- `ALEXA_INVOCATION_NAME` must be lowercase, contain at least two words, and
  must not be a launch phrase such as `open`, `play`, `start`, or `ask`.
- Descriptions should describe your own radio, not somebody else's station.

Generate the local manifest and interaction models:

```bash
npm run alexa:prepare -- --check
npm run alexa:prepare
```

The command creates these local files:

```text
alexa-skill-package/skill.json
alexa-skill-package/interactionModels/custom/en-US.json
alexa-skill-package/interactionModels/custom/en-IN.json
alexa-skill-package/interactionModels/custom/hi-IN.json
```

They are generated and ignored by Git. If you change `alexa.env`, run the
prepare command again.

## 6. Connect the Skill ID to your radio backend

The Skill ID in Alexa and the Skill ID in your radio backend must be identical.

In your radio administration page:

1. Open **Admin → Connect → Alexa**.
2. Paste your Skill ID into the Alexa Skill ID field.
3. Confirm that the endpoint in your generated `skill.json` points to the same
   backend you are configuring.
4. Select or configure the stream that Alexa should play.
5. Use the page's test or connection controls before enabling the integration.

Do not enable the integration until the endpoint, interaction model, and Skill
ID are ready. If listener authentication would prevent Alexa from fetching the
stream, follow the warning shown by your backend instead of exposing private
credentials.

## 7. Build the development skill

Regenerate once more, then deploy only the skill metadata:

```bash
npm run alexa:prepare -- --check
npm run alexa:prepare
ask deploy --profile my-radio --target skill-metadata
```

This updates the development skill's manifest and interaction models. It does
not publish or certify the skill.

Do not use `skill-infrastructure` for this package:

```bash
ask deploy --target skill-infrastructure
```

That target is for infrastructure resources and is not part of this external
HTTPS setup.

## 8. Test in development mode

### Test in the Developer Console

1. Open your skill in the [Alexa Developer Console][console].
2. Open the **Test** tab.
3. Change **Test is disabled** to **Development**.
4. Select `en-US`, `en-IN`, or `hi-IN`.
5. Test by typing or speaking an utterance using your invocation name.

The Developer Console simulator is useful for testing all intents without
changing the state of a physical radio device.

### Test on your Alexa device

The Alexa app, Alexa device, ASK CLI profile, and Developer Console skill must
use the same Amazon account for development testing.

In the Alexa app, open **More → Skills & Games → Your Skills → Dev**, select
your skill, and enable or launch it if necessary. Menu names may vary slightly
by app version.

Then try commands such as:

```text
Alexa, open <your invocation name>
Alexa, ask <your invocation name> what is playing
Alexa, ask <your invocation name> what show is on now
```

For the guided listener flows, use:

```text
Alexa, ask <your invocation name> to dedicate a song
Alexa, ask <your invocation name> to remind me about my request
```

The dedication flow asks for the song and then the recipient. The recipient can
be a person, group, family member, friend, or the listener themselves. A request
reminder is offered only when the backend has a reliable queue estimate. After
you agree to the skill's reminder question, Alexa asks for reminder permission;
answer with **“I approve”** to grant it. The skill creates the reminder only
after Alexa sends the permission response.

After the skill has started, audio controls can normally be used directly:

```text
Alexa, pause
Alexa, resume
Alexa, stop
```

If the skill does not appear under **Your Skills → Dev**, first check that the
Alexa app is signed in to the same Amazon account that owns the skill and that
the Developer Console Test tab is set to **Development**.

## Available intents

The supported intent inventory is documented below for people configuring or
testing the skill. Each locale uses the corresponding model in
`interactionModels/custom/`: inspect the tracked
`en-US.json.template`, `en-IN.json.template`, or `hi-IN.json.template` file for
the actual intent names, slots, sample utterances, and localized wording.
Generated `.json` files in that directory are local output and must not be
shared.

### Custom intents

| Intent | Example |
| --- | --- |
| `StartRadioIntent` | “start the radio” |
| `PlayRadioIntent` | “play the station” |
| `RequestSongIntent` | “request a song by title or artist” |
| `DedicationIntent` | “dedicate [song] to [person or group]” |
| `RequestReminderIntent` | “remind me about my request” |
| `RequestStatusIntent` | “what is the status of my request” |
| `CancelRequestIntent` | “cancel my request” |
| `ReplaceRequestIntent` | “replace my request with another song” |
| `NowPlayingIntent` | “what is playing right now” |
| `WhatIsPlayingIntent` | “tell me what is playing” |
| `CurrentSongIntent` | “tell me the current song” |
| `PreviousTrackIntent` | “what played before this” |
| `UpcomingIntent` | “what plays next” |
| `NextSongIntent` | “tell me the next song” |
| `WhatIsNextIntent` | “what comes next on the radio” |
| `QueuePreviewIntent` | “what songs are coming up” |
| `StationStatusIntent` | “is the station online” |
| `MoreLikeThisIntent` | “play more like this” |
| `AnotherByArtistIntent` | “play another song by this artist” |
| `RecentTracksIntent` | “what played recently” |
| `TrackDetailsIntent` | “tell me the album of this song” |
| `CurrentShowIntent` | “what show is on now” |

`RequestSongIntent` handles title, artist, album, lyrics, language, genre,
mood, and energy requests through its `requestText` slot. Do not add separate
intents for those request types.

`ReplaceRequestIntent` also uses a `requestText` slot.

`TrackDetailsIntent` uses a `detailType` slot with these values:

- `album`
- `artist`
- `year`
- `genre`
- `language`
- `all`

If a track does not contain album, year, genre, or language metadata, the skill
reports that the value is unavailable; it does not invent metadata.

`DedicationIntent` collects the song and recipient separately. It accepts
ordinary recipient descriptions such as “for [recipient]”, “for my friends”,
“for the family”, or “for myself”; the recipient is not treated as the song
title.

`RequestReminderIntent` has a two-stage confirmation flow. First answer the
skill's question about setting a reminder. Alexa then asks whether the skill
may update reminders; answer “I approve” or “no”. A reminder is not created
when the permission is denied, unanswered, or the queue estimate is not
reliable.

### Amazon built-in intents

- `AMAZON.HelpIntent`
- `AMAZON.StopIntent`
- `AMAZON.CancelIntent`
- `AMAZON.PauseIntent`
- `AMAZON.ResumeIntent`
- `AMAZON.FallbackIntent`
- `AMAZON.YesIntent`
- `AMAZON.NoIntent`
- `AMAZON.NavigateHomeIntent`

`AMAZON.YesIntent` and `AMAZON.NoIntent` are used when the skill asks for a
confirmation. `AMAZON.CancelIntent` cancels the current Alexa interaction; it
is separate from the custom `CancelRequestIntent`.

`StartRadioIntent` and `PlayRadioIntent` are the explicit custom controls for
starting or playing the radio. They are included in each locale template. Do
not copy a personal generated model into the shared package; set your own
endpoint, invocation name, and skill values in `alexa.env`, then generate the
models locally.

## Safe sharing checklist

Before sending this package to somebody else, confirm that you are not sharing:

- `alexa-skill-package/alexa.env`;
- generated `skill.json` or locale JSON files;
- `ask-resources.json` or ASK CLI project credentials;
- AWS credentials or access tokens;
- a real endpoint URL, station name, or Skill ID.

The recipient should copy `alexa.env.example`, enter their own values, and
generate the package locally.

## Troubleshooting

### The preparation command says a value is missing

Make sure `alexa-skill-package/alexa.env` exists, contains the three required
values, and that you are running the command from the repository root. The
required values are `ALEXA_ENDPOINT_URL`, `ALEXA_SKILL_NAME`, and
`ALEXA_INVOCATION_NAME`.

### Alexa cannot reach the endpoint

Check the public DNS name, TLS certificate, HTTPS port, and `/api/alexa` path.
The endpoint must be reachable from outside your home network. Check the
Developer Console test result and your backend logs for the exact failure.

### The Skill ID does not match

Copy the Skill ID again using **Copy Skill ID** in the Developer Console. Make
sure there is no whitespace and that the backend and skill use the same value.

### A development skill is not visible on the device

Verify the Amazon account, the device registration, the Development test mode,
the selected locale, and the invocation name. A development skill does not
need to be published before the owner account can test it.

## Official documentation

- [Alexa Developer Console][console]
- [ASK CLI quick start][ask-quick-start]
- [ASK CLI command reference][ask-reference]
- [Test and debug a custom skill][test-debug]
- [Test a skill in the Developer Console][console-test]

[console]: https://developer.amazon.com/alexa/console/ask
[ask-quick-start]: https://developer.amazon.com/en-US/docs/alexa/smapi/quick-start-alexa-skills-kit-command-line-interface.html
[ask-reference]: https://developer.amazon.com/en-US/docs/alexa/smapi/ask-cli-command-reference.html
[test-debug]: https://developer.amazon.com/en-US/docs/alexa/custom-skills/test-and-debug-a-custom-skill.html
[console-test]: https://developer.amazon.com/en-US/docs/alexa/devconsole/test-your-skill.html
