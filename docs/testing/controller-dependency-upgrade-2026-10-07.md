# Controller dependency upgrade verification

Live checks ran on 7 October 2026 using the upgraded worktree and Node 22.23.3.
The installed AI SDK was 7.0.130 and the OpenRouter adapter was 3.1.0.
Credentials came from the reference checkout and an operator-supplied bearer
key. Every run used a temporary state directory and disabled fallback. The
station's settings, broadcast queue and logs were not changed.

## Live SDK checks

All 23 checks passed after supplying the compatible endpoint's required key.

| Route | Checks |
| --- | --- |
| OpenAI-compatible `gpt-6-luna`, hosted mode | Text, native structured output, discovery tool and streaming |
| OpenAI-compatible `gpt-6-luna`, local mode | Text, forced-tool structured output, discovery plus done tool and streaming |
| OpenRouter `google/gemini-2.5-flash` | Text, structured output, discovery tool, streaming and embeddings |
| Google `gemini-2.5-flash` | Text, structured output, discovery tool, streaming and embeddings |
| DeepSeek `deepseek-flash` | Text, structured output, discovery tool and streaming |
| ElevenLabs `eleven_flash_v2_5` | Speech generation through the controller's cloud speech function |

The discovery checks require execution of a real tool and selection of its
randomly generated candidate ID. Reports include the actual strategy and token
usage. OpenRouter embeddings returned 1,536 finite components using
`openai/text-embedding-3-small`; Google returned 3,072 using
`gemini-embedding-001`. ElevenLabs returned 33,898 audio bytes. Voice listing
returned 401, while speech generation succeeded.

The SDK warned that `gpt-6-luna` ignores temperature/top-p and that DeepSeek
implements JSON schema output by injecting the schema into the system prompt.
These calls completed successfully.

## Station prompt benchmark

The existing `llm-bench` ran all 16 call kinds and 32 scenarios per model, once
per scenario, with reasoning off. It uses the station's actual prompts and
schemas with fixture library and world data. Both pool and agent modes ran.
All 128 scenarios completed without transport or SDK exceptions. Content
checks passed in 115 scenarios and failed in 13.

| Provider and model | Passed | Content failures | Exceptions |
| --- | ---: | ---: | ---: |
| `openai-compatible:gpt-6-luna` | 32 | 0 | 0 |
| `openrouter:google/gemini-2.5-flash` | 28 | 4 | 0 |
| `google:gemini-2.5-flash` | 29 | 3 | 0 |
| `deepseek:deepseek-flash` | 26 | 6 | 0 |

The failures below are model-output rule violations. A successful SDK call
does not establish that its output is safe to air. This run did not compare
these failures against the previous dependency versions, so it does not
establish whether the upgrade changed their frequency.

| Provider and model | Scenario | Failed rule |
| --- | --- | --- |
| `openrouter:google/gemini-2.5-flash` | `generateLink/normal` | stage-direction:asterisks |
| `openrouter:google/gemini-2.5-flash` | `generateLink/with-openers` | stage-direction:asterisks |
| `openrouter:google/gemini-2.5-flash` | `generateProgrammePlan/3-hour-show` | unoffered-feature-kind |
| `openrouter:google/gemini-2.5-flash` | `generateProgrammeExchange/outro-beat` | over-length:3-sentences |
| `google:gemini-2.5-flash` | `generateLink/normal` | stage-direction:asterisks |
| `google:gemini-2.5-flash` | `generateLink/with-openers` | stage-direction:asterisks |
| `google:gemini-2.5-flash` | `generateProgrammeExchange/outro-beat` | banned-phrase:coming-up-next |
| `deepseek:deepseek-flash` | `djAgentPick/short-context` | hallucinated-id |
| `deepseek:deepseek-flash` | `djAgentPick/long-context` | hallucinated-id |
| `deepseek:deepseek-flash` | `generateHourlyTime/evening` | banned-phrase:and-now |
| `deepseek:deepseek-flash` | `generateProgrammePlan/2-hour-show` | unoffered-feature-kind |
| `deepseek:deepseek-flash` | `generateProgrammeOutro/with-plan` | over-length:5-sentences |
| `deepseek:deepseek-flash` | `generateProgrammeExchange/intro-beat` | over-length:3-sentences |

## Remaining coverage

Ollama was unreachable at the reference checkout's Docker-internal address and
at localhost:11434. No native Anthropic, native OpenAI or AI Gateway credential
was available. The OpenAI adapter was exercised through the compatible chat
endpoint and OpenRouter embeddings, but native OpenAI speech was not tested.
The live tool-refusal recovery path was not deliberately forced; its regression
coverage uses the real SDK with mocked model responses.

These checks establish live API compatibility for the tested routes. A single
benchmark iteration does not establish long-term reliability, and these runs
do not exercise an on-air broadcast.

## Repeating the smoke checks

`scripts/live-provider-smoke.ts` is opt-in and makes billable calls. It is not
registered with `npm test`. It reads only provider credential variables from
`--env-dir`, with existing environment variables taking precedence, and
removes its temporary state after the run. Reports redact credential values.
Use a private environment file for `OPENAI_COMPATIBLE_API_KEY` and set
`LLM_BASE_URL` to the intended compatible endpoint.

```sh
cd controller
node --env-file=/path/to/private-provider.env --import tsx \
  scripts/live-provider-smoke.ts \
  --env-dir /path/to/reference-checkout \
  --models openai-compatible:gpt-6-luna,openrouter:google/gemini-2.5-flash,google:gemini-2.5-flash,deepseek:deepseek-flash \
  --base-url "$LLM_BASE_URL" \
  --out /tmp/provider-results.json
```

Run again with `--compatible-mode local` to exercise forced-tool output.
The longer benchmark used `npm run llm-bench` with the same four model specs,
`--iterations 1 --reasoning off`, and temporary settings containing hosted
compatible mode and its inline key. Keep that state separate from the live
station when repeating it.
