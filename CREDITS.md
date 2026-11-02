# Credits

SUB/WAVE is built on open-source software, open models, and public data
services. This page credits the projects it depends on, at runtime and during
development.

Licences are as each project declares them for the version SUB/WAVE uses.
Each project's own licence file is the authoritative text. Versions are pinned
in the `package.json` files, lockfiles, and `docker/Dockerfile.*`, not here.

## Broadcast and infrastructure

| Project | Used for | Licence |
| --- | --- | --- |
| [Liquidsoap](https://www.liquidsoap.info) | The mixer: request queue, crossfades, ducking, limiter, encoders (`liquidsoap/radio.liq`) | GPL-2.0 |
| [Icecast-KH](https://github.com/karlheyes/icecast-kh) | The stream server every listener connects to. Packaged by [deb-multimedia.org](https://www.deb-multimedia.org) | GPL-2.0 |
| [Caddy](https://caddyserver.com) | The edge reverse proxy in the default compose stack and the all-in-one image | Apache-2.0 |
| [Node.js](https://nodejs.org) | Runtime for the controller, web UI, CLI, and MCP server | MIT |
| [Python](https://www.python.org) | Runtime for the analyzer and the TTS workers | PSF-2.0 |
| [FFmpeg](https://ffmpeg.org) | Jingle and SFX import transcoding, analyzer decoding | LGPL-2.1+ / GPL-2.0+ |
| [libsndfile](https://libsndfile.github.io/libsndfile/) | WAV reading and writing for TTS and analysis | LGPL-2.1 |
| [SQLite](https://sqlite.org) | The library database, through `better-sqlite3` | Public domain |
| [uv](https://github.com/astral-sh/uv) | Provisions Python 3.12 for the Kokoro venv in the all-in-one image | MIT / Apache-2.0 |
| [docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy) (Tecnativa) | Read-only Docker access for the admin Stats panel | Apache-2.0 |
| [Docker](https://www.docker.com) and Docker Compose | Packaging and orchestration for every deployment shape | Apache-2.0 |

### The music library

| Project | Used for | Licence |
| --- | --- | --- |
| [Navidrome](https://www.navidrome.org) | The operator's music server. SUB/WAVE reads it over the [Subsonic API](https://www.subsonic.org/pages/api.jsp) and does not bundle it | GPL-3.0 |
| [Jamendo](https://www.jamendo.com) | Source of Creative Commons tracks for demo libraries (`tools/jamendo`) | Per-track CC licences |

## Speech (text-to-speech)

### Engines and models

| Project | Used for | Licence |
| --- | --- | --- |
| [Piper](https://github.com/rhasspy/piper) (Rhasspy) | Default local TTS engine | MIT |
| [Piper voices](https://huggingface.co/rhasspy/piper-voices): `en_GB-alan-medium` | The bundled default voice | MIT |
| [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) (hexgrad) | Multilingual local TTS model | Apache-2.0 |
| [kokoro-onnx](https://github.com/thewh1teagle/kokoro-onnx) | ONNX runtime wrapper and model files for Kokoro | MIT |
| [Chatterbox Turbo](https://github.com/resemble-ai/chatterbox) (Resemble AI) | Zero-shot voice cloning in the `tts-heavy` sidecar | MIT |
| [Pocket TTS](https://github.com/kyutai-labs/pocket-tts) (Kyutai) | Fast CPU TTS in the `tts-heavy` sidecar | Code MIT, [weights](https://huggingface.co/kyutai/pocket-tts) CC-BY-4.0 |

### Phonemisation and text processing

| Project | Used for | Licence |
| --- | --- | --- |
| [misaki](https://github.com/hexgrad/misaki) | Grapheme-to-phoneme front end for Kokoro | Apache-2.0 |
| [eSpeak NG](https://github.com/espeak-ng/espeak-ng) | Phonemiser behind misaki | GPL-3.0 |
| [pyopenjtalk-plus](https://pypi.org/project/pyopenjtalk-plus/) | Japanese phonemisation | MIT |
| [jieba](https://github.com/fxsjy/jieba), [pypinyin](https://github.com/mozillazg/python-pinyin), pypinyin-dict, [cn2an](https://github.com/Ailln/cn2an) | Chinese segmentation, pinyin, and number reading | MIT |
| [ordered-set](https://pypi.org/project/ordered-set/) | misaki dependency | MIT |
| [soundfile](https://github.com/bastibe/python-soundfile) | WAV output from the Python workers | BSD-3-Clause |

## Audio analysis and machine learning

| Project | Used for | Licence |
| --- | --- | --- |
| [librosa](https://librosa.org) | BPM, key, onsets, endings, and silence measurement | ISC |
| [pyloudnorm](https://github.com/csteinmetz1/pyloudnorm) | LUFS loudness measurement | MIT |
| [NumPy](https://numpy.org) and [SciPy](https://scipy.org) | Numerical work in the analyzer and TTS workers | BSD-3-Clause |
| [PyTorch](https://pytorch.org) and torchaudio | Model runtime for CLAP, Demucs, Chatterbox, and Pocket TTS | BSD-3-Clause |
| [Hugging Face Transformers](https://github.com/huggingface/transformers) | Loads the CLAP model | Apache-2.0 |
| [ONNX Runtime](https://onnxruntime.ai) | Runs Kokoro and custom CLAP exports | MIT |
| [CLAP](https://github.com/LAION-AI/CLAP) (LAION): [`laion/clap-htsat-unfused`](https://huggingface.co/laion/clap-htsat-unfused) | Audio embeddings for mood tagging (heavy analyzer tier) | Apache-2.0 |
| [Demucs](https://github.com/facebookresearch/demucs) (Meta AI): `htdemucs` | Vocal detection and stem blends (heavy analyzer tier) | MIT |
| [diffq](https://github.com/facebookresearch/diffq) (Meta AI) | Decompresses Demucs' quantised checkpoints (heavy analyzer tier) | CC BY-NC 4.0 |
| [FastAPI](https://fastapi.tiangolo.com), [Uvicorn](https://www.uvicorn.org), [Pydantic](https://docs.pydantic.dev) | HTTP front of the analyzer and `tts-heavy` sidecars | MIT / BSD-3-Clause / MIT |
| [Cython](https://cython.org) | Build-time only, for Chatterbox's dependencies | Apache-2.0 |

## Controller (`controller/`)

| Package | Used for | Licence |
| --- | --- | --- |
| [AI SDK](https://ai-sdk.dev) (`ai`) by Vercel | LLM calls, tool loops, structured output | Apache-2.0 |
| `@ai-sdk/anthropic`, `@ai-sdk/deepseek`, `@ai-sdk/elevenlabs`, `@ai-sdk/google`, `@ai-sdk/openai` | Provider adapters | Apache-2.0 |
| [`@openrouter/ai-sdk-provider`](https://github.com/OpenRouterTeam/ai-sdk-provider) | OpenRouter adapter | Apache-2.0 |
| [`ai-sdk-ollama`](https://github.com/jagreehal/ai-sdk-ollama) | Ollama adapter | MIT |
| [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) | The built-in MCP server | MIT |
| [Express](https://expressjs.com) | HTTP API | MIT |
| [Helmet](https://helmetjs.github.io) | Security headers | MIT |
| [Multer](https://github.com/expressjs/multer) | Audio and backup uploads | MIT |
| [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) | Library database driver | MIT |
| [sqlite-vec](https://github.com/asg017/sqlite-vec) | Vector search inside SQLite | MIT / Apache-2.0 |
| [umap-js](https://github.com/PAIR-code/umap-js) | Library Observatory map projection | MIT |
| [Zod](https://zod.dev) | Schema validation, mirrored to the web UI | MIT |
| [node-cron](https://github.com/node-cron/node-cron) | The talk and maintenance schedulers | ISC |
| [liqe](https://github.com/gajus/liqe) | Library search query language | BSD-3-Clause |
| [re2js](https://github.com/le0pard/re2js) | Linear-time regex for operator search patterns | MIT |
| [fast-xml-parser](https://github.com/NaturalIntelligence/fast-xml-parser) | RSS feeds for news skills | MIT |
| [yaml](https://eemeli.org/yaml/) | Skill files | ISC |
| [adm-zip](https://github.com/cthackers/adm-zip) | Backups and persona bundles | MIT |
| [mmdb-lib](https://github.com/runk/mmdb-lib) | Offline GeoIP lookups (operator-supplied database) | MIT |
| [dotenv](https://github.com/motdotla/dotenv) | `.env` loading | BSD-2-Clause |

## Web UI (`web/`)

| Package | Used for | Licence |
| --- | --- | --- |
| [Next.js](https://nextjs.org) and `@next/third-parties` | The web app | MIT |
| [React](https://react.dev) and React DOM | UI | MIT |
| [Tailwind CSS](https://tailwindcss.com), `@tailwindcss/postcss`, [PostCSS](https://postcss.org) | Styling | MIT |
| [tw-animate-css](https://github.com/Wombosvideo/tw-animate-css), [tailwind-merge](https://github.com/dcastil/tailwind-merge), [clsx](https://github.com/lukeed/clsx), [class-variance-authority](https://cva.style) | Class composition and animation utilities | MIT / MIT / MIT / Apache-2.0 |
| [Radix UI primitives](https://www.radix-ui.com) (`@radix-ui/react-*`) | Dialogs, menus, selects, switches, tooltips, and other accessible primitives | MIT |
| [TanStack Query](https://tanstack.com/query) | Admin data fetching and caching | MIT |
| [React Hook Form](https://react-hook-form.com) and `@hookform/resolvers` | Admin forms | MIT |
| [dnd kit](https://dndkit.com) (`@dnd-kit/*`) | Drag and drop for playlists and the schedule | MIT |
| [Motion](https://motion.dev) | Animation | MIT |
| [@use-gesture/react](https://use-gesture.netlify.app) | Sheet drag gestures | MIT |
| [three.js](https://threejs.org) | The Observatory's 3D galaxy view | MIT |
| [Lucide](https://lucide.dev) (`lucide-react`) | Icons | ISC |
| [cmdk](https://cmdk.paco.me) | Command palette | MIT |
| [Sonner](https://sonner.emilkowal.ski) | Toasts | MIT |
| [Streamdown](https://streamdown.ai) and `@streamdown/*` | Streaming Markdown, code, maths, Mermaid, and CJK rendering | Apache-2.0 |
| [Shiki](https://shiki.style) | Syntax highlighting | MIT |
| [marked](https://marked.js.org), [gray-matter](https://github.com/jonschlinkert/gray-matter), [js-yaml](https://github.com/nodeca/js-yaml) | News posts and Markdown content | MIT |
| [Media Chrome](https://www.media-chrome.org) | Audio player controls | MIT |
| [ansi-to-react](https://github.com/nteract/ansi-to-react) | Terminal output rendering | BSD-3-Clause |
| [use-stick-to-bottom](https://github.com/stackblitz-labs/use-stick-to-bottom), [usehooks-ts](https://usehooks-ts.com), [nanoid](https://github.com/ai/nanoid) | Hooks and ids | MIT |
| [piri](https://github.com/thejessewinton/piri) | Dotted world map on the stations page, based on [dotted-map](https://github.com/NTag/dotted-map) | MIT |
| [Zod](https://zod.dev) | Schema validation | MIT |

### Component sources

| Source | Used for | Licence |
| --- | --- | --- |
| [shadcn/ui](https://ui.shadcn.com) | Base for `web/components/ui` | MIT |
| [AI Elements](https://github.com/vercel/ai-elements) (Vercel) | Base for `web/components/ai-elements` | Apache-2.0 |
| [Magic UI](https://magicui.design) | DottedMap stagger maths in the stations map | MIT |

### Fonts

Served through [Google Fonts](https://fonts.google.com) with `next/font`, all
under the [SIL Open Font License 1.1](https://openfontlicense.org):

Anton, Bricolage Grotesque, Chakra Petch, Courier Prime, DM Mono, Doto, Fira
Code, Fraunces, IBM Plex Mono, Instrument Serif, JetBrains Mono, Overpass Mono,
Plus Jakarta Sans, Saira Stencil, Space Grotesk, Space Mono, VT323.

## Native app (`app/`)

| Package | Used for | Licence |
| --- | --- | --- |
| [Expo](https://expo.dev) SDK and `expo-*` modules | App framework, router, updates, fonts, images, haptics, secure storage | MIT |
| [React Native](https://reactnative.dev) | Native UI runtime | MIT |
| [React Native Track Player](https://rntp.dev) | Background audio and lock-screen controls | Apache-2.0 |
| [react-native-google-cast](https://github.com/react-native-google-cast/react-native-google-cast) | Chromecast | MIT |
| [React Native Skia](https://shopify.github.io/react-native-skia/) (Shopify) | Drawing and visuals | MIT |
| [Reanimated](https://docs.swmansion.com/react-native-reanimated/) and [Worklets](https://docs.swmansion.com/react-native-worklets/) (Software Mansion) | Animation | MIT |
| [react-native-screens](https://github.com/software-mansion/react-native-screens), [react-native-safe-area-context](https://github.com/AppAndFlow/react-native-safe-area-context), [react-native-svg](https://github.com/software-mansion/react-native-svg) | Navigation, layout, and SVG | MIT |
| [NativeWind](https://www.nativewind.dev) and Tailwind CSS 3 | Styling | MIT |
| [lucide-react-native](https://lucide.dev) | Icons | ISC |
| [react-native-image-colors](https://github.com/osamaqarem/react-native-image-colors) | Artwork colour extraction | MIT |
| [Async Storage](https://react-native-async-storage.github.io/async-storage/) and [NetInfo](https://github.com/react-native-netinfo/react-native-netinfo) | Persistence and connectivity | MIT |
| [@bacons/apple-targets](https://github.com/EvanBacon/expo-apple-targets) | iOS extension targets | MIT |
| `@expo-google-fonts/*` | Fraunces, JetBrains Mono, Plus Jakarta Sans | MIT (fonts OFL-1.1) |

## CLI, MCP server, and tools

| Package | Used for | Licence |
| --- | --- | --- |
| [@clack/prompts](https://github.com/bombshell-dev/clack) | The `subwave` CLI and setup wizard | MIT |
| [picocolors](https://github.com/alexeyraspopov/picocolors) | Terminal colours | ISC |
| [Bun](https://bun.sh) | Compiles the standalone `subwave` CLI binary | MIT |
| [node-id3](https://github.com/Zazama/node-id3) | ID3 tagging in `tools/jamendo` | MIT |

## External services and data

SUB/WAVE calls these services only when the operator configures them, or
when a skill or feature they enable needs them.

**Language models.** [Ollama](https://ollama.com), [Anthropic](https://www.anthropic.com),
[OpenAI](https://openai.com), [Google Gemini](https://ai.google.dev),
[DeepSeek](https://www.deepseek.com), [OpenRouter](https://openrouter.ai),
[Requesty](https://www.requesty.ai), [Vercel AI Gateway](https://vercel.com/ai-gateway),
and any OpenAI-compatible server.

**Cloud speech.** [OpenAI](https://platform.openai.com/docs/guides/text-to-speech),
[ElevenLabs](https://elevenlabs.io), and [Google Gemini](https://ai.google.dev).

**Weather.** [Open-Meteo](https://open-meteo.com) forecasts and geocoding.

**News.** [BBC News](https://www.bbc.co.uk/news) RSS is the default feed for the news skill.

**Music metadata and scrobbling.** [MusicBrainz](https://musicbrainz.org),
[Last.fm](https://www.last.fm), and [ListenBrainz](https://listenbrainz.org).

**Search and reference.** [Brave Search](https://brave.com/search/api/),
[Tavily](https://tavily.com), [DuckDuckGo](https://duckduckgo.com),
[Keenable](https://keenable.ai), [SearXNG](https://github.com/searxng/searxng),
[Firecrawl](https://www.firecrawl.dev), and [Wikimedia](https://api.wikimedia.org).

**Edge and distribution.** [Cloudflare](https://www.cloudflare.com) for TLS in
the documented deployment and Workers for the CLI installer,
[GitHub Container Registry](https://ghcr.io) for images, and
[Expo Application Services](https://expo.dev/eas) for app builds and over-the-air updates.

## Development and CI

| Tool | Used for | Licence |
| --- | --- | --- |
| [TypeScript](https://www.typescriptlang.org) | Type checking across every package | Apache-2.0 |
| [tsx](https://tsx.is) | Running TypeScript directly, plus the test runners | MIT |
| [ESLint](https://eslint.org) and [typescript-eslint](https://typescript-eslint.io) | Linting, the merge gate | MIT |
| `eslint-config-next`, `eslint-config-expo`, `eslint-plugin-react`, `eslint-plugin-better-tailwindcss` | Framework lint rules | MIT |
| [DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped) (`@types/*`) | Type definitions | MIT |
| `babel-preset-expo` | App build transform | MIT |
| [patch-package](https://github.com/ds300/patch-package) | Patches to app dependencies (`app/patches/`) | MIT |
| [Playwright](https://playwright.dev) | Browser checks in `web/scripts/verify-*.py` | Apache-2.0 |
| [deepsec](https://www.npmjs.com/package/deepsec) | Security scanning (`.deepsec/`) | Apache-2.0 |
| [GitHub Actions](https://github.com/features/actions): `actions/checkout`, `actions/setup-node`, `actions/upload-artifact`, `actions/download-artifact` | CI | MIT |
| [Docker build actions](https://github.com/docker): `setup-buildx-action`, `setup-qemu-action`, `metadata-action`, `login-action`, `build-push-action` | Multi-arch image publishing | Apache-2.0 |
| [release-please](https://github.com/googleapis/release-please-action) | Versioning and changelog | Apache-2.0 |
| [Trivy](https://github.com/aquasecurity/trivy-action) and [CodeQL's SARIF upload](https://github.com/github/codeql-action) | Image vulnerability scanning | Apache-2.0 / MIT |
| [action-gh-release](https://github.com/softprops/action-gh-release) | Release asset uploads | MIT |
| [setup-bun](https://github.com/oven-sh/setup-bun) | CLI binary builds | MIT |
| [wrangler-action](https://github.com/cloudflare/wrangler-action) | CLI installer deploys | Apache-2.0 |

## Licence notes

- Liquidsoap, Icecast-KH, and Navidrome are GPL programs that run as separate
  processes. SUB/WAVE talks to them over files, telnet, and HTTP.
- eSpeak NG (GPL-3.0) is loaded by the Kokoro worker, a separate Python
  process the controller spawns.
- diffq is licensed for non-commercial use only. It ships only in the heavy
  analyzer images (`ANALYZER_HEAVY=1`, `subwave-aio-heavy`, `subwave-aio-cuda`),
  not in the default build.
- Pocket TTS model weights are CC-BY-4.0, which requires attribution to Kyutai.
- Tracks pulled with `tools/jamendo` carry their own Creative Commons licences.
  The tool writes a separate attribution file for them.
