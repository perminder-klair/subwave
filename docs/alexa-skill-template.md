# Shareable Alexa skill template

This directory contains a shareable Alexa skill template. The tracked Alexa
package does not commit a deployment endpoint, station name, invocation name,
Skill ID, or Alexa account credentials.

The template is stacked on the self-hosted Alexa connection from PR #2048. A
user deploying it supplies their own HTTPS Alexa endpoint and their own skill
identity. The resulting skill stays in their Amazon developer account's
development stage until they choose to publish it.

## Prepare a local package

Copy the example configuration and replace every value with the user's own
deployment details:

```bash
cp alexa-skill-package/alexa.env.example alexa-skill-package/alexa.env
$EDITOR alexa-skill-package/alexa.env
npm run alexa:prepare -- --check
npm run alexa:prepare
```

The script generates these files locally:

- `alexa-skill-package/skill.json`
- `alexa-skill-package/interactionModels/custom/en-US.json`
- `alexa-skill-package/interactionModels/custom/en-IN.json`
- `alexa-skill-package/interactionModels/custom/hi-IN.json`

The generated files and `alexa-skill-package/alexa.env` are ignored by Git. The
tracked `.template` files contain only neutral tokens.

The preparation script checks the endpoint format and common Alexa invocation
name restrictions before generating JSON. Alexa/ASK validation remains the
final authority for locale-specific naming rules.

## Deploy to a personal Amazon account

Configure ASK CLI with the user's own profile, initialize the local project,
and deploy only the skill metadata to the development stage:

```bash
ask configure --profile my-radio
ask init --profile my-radio
ask deploy --profile my-radio --target skill-metadata
```

`ask init` is interactive. Select the custom skill package and skip any Lambda
or hosted-backend setup; this template supplies skill metadata and an endpoint,
not an AWS Lambda function.

The user must configure the matching Alexa Skill ID in their own radio backend.
The endpoint in `ALEXA_ENDPOINT_URL` must be publicly reachable over HTTPS and
must point to that user's radio deployment.

The model includes listener dedications and request reminders. A dedication
collects the requested song and recipient in separate turns. A reminder is
offered only when the backend has a reliable queue estimate and requires both
confirmation and Alexa reminder permission. These flows use the same request
ledger as ordinary song requests.

The skill can then be tested with the Alexa Developer Console or ASK CLI
simulation tools. No publishing or certification step is required.

## Sharing checklist

Share the Alexa package or a source archive only after confirming that the
shareable package contains no:

- Real endpoint URL
- Station name
- Alexa Skill ID
- `alexa-skill-package/alexa.env`
- Generated `alexa-skill-package/*.json` files
- ASK CLI project state or credentials
- AWS credentials or access tokens

The recipient should generate their package locally from the templates before
running ASK CLI deployment.
