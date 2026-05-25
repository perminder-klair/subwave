# Changelog

## [0.1.20](https://github.com/perminder-klair/subwave/compare/v0.1.19...v0.1.20) (2026-05-25)


### Features

* admin archives, listener history, outbound webhooks ([#119](https://github.com/perminder-klair/subwave/issues/119)) ([f0389e5](https://github.com/perminder-klair/subwave/commit/f0389e599c1150af243472af9e16e1301a4a7948))

## [0.1.19](https://github.com/perminder-klair/subwave/compare/v0.1.18...v0.1.19) (2026-05-24)


### Features

* **admin/library:** tidy KPI grid and slim tracks table ([4e7d376](https://github.com/perminder-klair/subwave/commit/4e7d376d897379951cdada316b89fa7cf85163fa))
* **web/player:** tactile press + haptics on transport controls ([7779424](https://github.com/perminder-klair/subwave/commit/77794248626b2e8e7e9f497165122e75d719ab91))


### Bug Fixes

* **web/landing:** stop mobile horizontal scroll from rotating DJ glyph ([c129c82](https://github.com/perminder-klair/subwave/commit/c129c823d6bfcd55b2011b3ac8e9fcd1e8d960bc))

## [0.1.18](https://github.com/perminder-klair/subwave/compare/v0.1.17...v0.1.18) (2026-05-24)


### Documentation

* plan to swap Ollama provider to ai-sdk-ollama ([30e27b8](https://github.com/perminder-klair/subwave/commit/30e27b8ebfa209e4dcaded7203633a63a6ed37dd))

## [0.1.17](https://github.com/perminder-klair/subwave/compare/v0.1.16...v0.1.17) (2026-05-24)


### Features

* **admin:** admin field for station + dashboard/settings polish ([ff1e558](https://github.com/perminder-klair/subwave/commit/ff1e558718f431e02f0c432af984d8407a56b452))


### Bug Fixes

* persist station name from setup wizard ([#102](https://github.com/perminder-klair/subwave/issues/102)) + admin polish ([f089c5b](https://github.com/perminder-klair/subwave/commit/f089c5bf090d49e2c051a3cb50ea0139bb2d9cd2))
* persist station name from setup wizard end-to-end ([f3e1941](https://github.com/perminder-klair/subwave/commit/f3e1941eaf71411ae0afaa278ab88911ce7f2fc9)), closes [#102](https://github.com/perminder-klair/subwave/issues/102)

## [0.1.16](https://github.com/perminder-klair/subwave/compare/v0.1.15...v0.1.16) (2026-05-24)


### Features

* **admin:** redo library page with working filters + coverage ([f7aaa65](https://github.com/perminder-klair/subwave/commit/f7aaa65eba60f0b8bdd1a456600631d7e4baed3f))
* **admin:** redo library page with working filters + coverage ([417b61a](https://github.com/perminder-klair/subwave/commit/417b61a39129a125b5939f164cb307ed3c872ffd))

## [0.1.15](https://github.com/perminder-klair/subwave/compare/v0.1.14...v0.1.15) (2026-05-24)


### Features

* **cli:** fetch TUI binary on demand for standalone installs ([f621d76](https://github.com/perminder-klair/subwave/commit/f621d7669390a1df8b7a3d238fa9f417112dddba))
* **cli:** fetch TUI binary on demand for standalone installs ([960c90d](https://github.com/perminder-klair/subwave/commit/960c90d04d5932b9f80fdc7e6dfc82a43e59eb34))


### Bug Fixes

* **cli:** declare tsx as a devDependency ([2c18532](https://github.com/perminder-klair/subwave/commit/2c185322ebba20a11de89ea7bd65121f24c2d608))

## [0.1.14](https://github.com/perminder-klair/subwave/compare/v0.1.13...v0.1.14) (2026-05-24)


### Bug Fixes

* **admin:** keep /admin/debug expansions from blowing out viewport ([37764b2](https://github.com/perminder-klair/subwave/commit/37764b2f2fa96489fdc6949adffc558471a14962))

## [0.1.13](https://github.com/perminder-klair/subwave/compare/v0.1.12...v0.1.13) (2026-05-24)


### Bug Fixes

* **landing:** tighten masthead nav bottom padding ([6856661](https://github.com/perminder-klair/subwave/commit/685666130a2745103d1c66856557c321b7b7e854))
* **landing:** tighten masthead nav bottom padding ([9c99bd9](https://github.com/perminder-klair/subwave/commit/9c99bd9ac9960c9918c87eabd0b4187706c9fa37))

## [0.1.12](https://github.com/perminder-klair/subwave/compare/v0.1.11...v0.1.12) (2026-05-24)


### Features

* **cli:** full-stack restart option + fix rebuild on standalone installs ([809f835](https://github.com/perminder-klair/subwave/commit/809f835c2cf0919ecc158bc2941b7c17ea759092))
* **cli:** wire `setup` through /onboarding/save + highlight Listen/Admin ([a414840](https://github.com/perminder-klair/subwave/commit/a414840f3358b6d76de9f4b8008429ebec623a3e))


### Bug Fixes

* **onboarding:** retrigger auto-playlist refresh after save ([4544f07](https://github.com/perminder-klair/subwave/commit/4544f07c80f4e86a71eec6b616341856bb3b279e))
* **setup:** drop stale setup-config cache to honour out-of-band writes ([ae64859](https://github.com/perminder-klair/subwave/commit/ae6485947919dd30edb51a6a3b656321025f2a8a))


### Reverts

* **web:** restore pseudo-random waveform fallback for iOS Safari ([4d47925](https://github.com/perminder-klair/subwave/commit/4d4792584ce609ef6cebcd88d27d6b73fe8ae82c))
* **web:** restore pseudo-random waveform fallback for iOS Safari ([3b7b9bd](https://github.com/perminder-klair/subwave/commit/3b7b9bd655803213ed5f8996df15cdbce34963b8))

## [0.1.11](https://github.com/perminder-klair/subwave/compare/v0.1.10...v0.1.11) (2026-05-24)


### Features

* **cli:** surface incomplete setup as a doctor finding ([fee3466](https://github.com/perminder-klair/subwave/commit/fee346651aa1e8f0c0437802ef899f539b85765a))


### Refactors

* **cli:** split init and setup responsibilities cleanly ([c0c1c35](https://github.com/perminder-klair/subwave/commit/c0c1c35823dd92bdc3060b3c5cceeed541f4b423))
* **onboarding:** default Ollama model to glm-5.1:cloud, drop DJ prompt field ([ccd2ac9](https://github.com/perminder-klair/subwave/commit/ccd2ac974d286f5eba62e791b4ffa30bdc007d45))

## [0.1.10](https://github.com/perminder-klair/subwave/compare/v0.1.9...v0.1.10) (2026-05-24)


### Documentation

* reflect the new init → start chaining in the install flow ([a263e7f](https://github.com/perminder-klair/subwave/commit/a263e7f14804537d7420d5f20de5704bd2e81fbc))

## [0.1.9](https://github.com/perminder-klair/subwave/compare/v0.1.8...v0.1.9) (2026-05-24)


### Features

* **cli:** auto-resolve env in `start` and chain init → start from the installer ([8955951](https://github.com/perminder-klair/subwave/commit/8955951a58affca0e8458b26ce08f8e842739bd7))

## [0.1.8](https://github.com/perminder-klair/subwave/compare/v0.1.7...v0.1.8) (2026-05-24)


### Bug Fixes

* **ci:** unblock v0.1.7 web image and CLI binary builds ([72edf43](https://github.com/perminder-klair/subwave/commit/72edf43bfb45807bc59a8edcbe76f733ff3b3213))

## [0.1.7](https://github.com/perminder-klair/subwave/compare/v0.1.6...v0.1.7) (2026-05-24)


### Features

* **cli:** add subwave update + tighten web/setup pages for the CLI ([5e94847](https://github.com/perminder-klair/subwave/commit/5e9484758ccc47e8897a9f97302af37c787fca81))
* **cli:** auto-detect Ollama + loopback-swap for the controller ([5db680c](https://github.com/perminder-klair/subwave/commit/5db680c15d7ad34857a779b72729e7bf40dfa840))
* **cli:** standalone subwave CLI with init, self-update, and curl|sh installer ([80eda73](https://github.com/perminder-klair/subwave/commit/80eda73d237091acda6b9407715d835c039f4b31))
* **dev:** hot-reload controller via bind-mounted src + tsx watch ([9129862](https://github.com/perminder-klair/subwave/commit/9129862346edf698723f82d666bcff114ba8a7bb))
* **docker:** add subwave-caddy image with baked-in Caddyfile ([6a24b15](https://github.com/perminder-klair/subwave/commit/6a24b15ea42c4094677dd5be751d6de2852dc88f))
* **docker:** add subwave-icecast image with auto-generated secrets ([69edcc2](https://github.com/perminder-klair/subwave/commit/69edcc2097eebab54430e91e066466c9aaf792f1))
* **docker:** bake radio.liq + sounds/ into liquidsoap and controller images ([ea31ae3](https://github.com/perminder-klair/subwave/commit/ea31ae3caf62360a37b6fa6e76ac36966ffa084f))
* **infra:** Cloudflare Worker for cli.getsubwave.com installer ([0ea2e3b](https://github.com/perminder-klair/subwave/commit/0ea2e3b21e161d88e91955d1c1592e3a46de8a7b))
* single-compose deploy + first-run web wizard ([0e6f353](https://github.com/perminder-klair/subwave/commit/0e6f353a65dce539c8c879b4fe3e0a87a2e9e839))


### Bug Fixes

* **cli:** auto-recover from root-owned state files via docker chown ([3f1c8f7](https://github.com/perminder-klair/subwave/commit/3f1c8f73fcb5f37cf7b898a71d8f5c9c650adffd))
* **cli:** default Navidrome to localhost, swap to host.docker.internal post-probe ([869360c](https://github.com/perminder-klair/subwave/commit/869360c86af98a6064d41dbdfcdb08d5424dc48d))
* **cli:** show dev as the third setup mode option ([840032f](https://github.com/perminder-klair/subwave/commit/840032f19be000f08eaa0278947a52ef7041ee23))
* **cli:** skip the SITE_URL prompt in dev mode ([d2796e0](https://github.com/perminder-klair/subwave/commit/d2796e0e0626e4b1fb98cba3073aa74b26a1dcdf))
* **setup:** stop infinite recursion from backticks in setup.sh heredoc ([5bbe210](https://github.com/perminder-klair/subwave/commit/5bbe2100338689ef3eef35ef25f90280544f5789))


### Documentation

* **cli:** point installer at cli.getsubwave.com (www.* is the landing page) ([5fcef84](https://github.com/perminder-klair/subwave/commit/5fcef84bc31bd1b21367309937558aab81daae50))
* **setup:** refresh remaining setup pages + use www.getsubwave.com ([6e7f7a7](https://github.com/perminder-klair/subwave/commit/6e7f7a7d06d784479d6e0966ca117c97b87e56f5))
* **web:** harden BYO-proxy guidance, drop it from QuickStart ([eaf538f](https://github.com/perminder-klair/subwave/commit/eaf538fa4c8d08d1447e26af52c05bece84615ab))


### Refactors

* CLI setup for single-compose, wizard at /onboarding ([c8e87c3](https://github.com/perminder-klair/subwave/commit/c8e87c357c77731257d3e718a8ac7a3adbd54437))
* **compose:** rename so prod is the default (docker-compose.yml) ([8ec2102](https://github.com/perminder-klair/subwave/commit/8ec21021618de007b48f7b6225bf2ed380c29508))

## [0.1.6](https://github.com/perminder-klair/subwave/compare/v0.1.5...v0.1.6) (2026-05-23)


### Bug Fixes

* **web:** drop misleading pseudo-random visualiser fallback ([44d4b48](https://github.com/perminder-klair/subwave/commit/44d4b48405b5a1f18ce1ae2038fe88806af19892))
* **web:** drop misleading pseudo-random visualiser fallback ([56cb7a8](https://github.com/perminder-klair/subwave/commit/56cb7a830d90fc5eaa06fd39d1e9dd8291ee916a))

## [0.1.5](https://github.com/perminder-klair/subwave/compare/v0.1.4...v0.1.5) (2026-05-23)


### Features

* **web:** motion pass — player, landing, admin ([d2b2419](https://github.com/perminder-klair/subwave/commit/d2b24199f41ac37f23c050011b1a8dacafcb41af))


### Refactors

* **web:** unify admin notifications through lib/notify ([e2c576f](https://github.com/perminder-klair/subwave/commit/e2c576fd56280317ecd2255ca2a97408110f333d))

## [0.1.4](https://github.com/perminder-klair/subwave/compare/v0.1.3...v0.1.4) (2026-05-23)


### Bug Fixes

* **controller:** make liquidsoap reachable from a natively-run controller ([1493783](https://github.com/perminder-klair/subwave/commit/14937830d9e12086ddcafe80a95d08652027c8b4))
* **controller:** make liquidsoap reachable from a natively-run controller ([c6da0db](https://github.com/perminder-klair/subwave/commit/c6da0db484ee729d32eda89f7043eb40fa4a0759))
* **worktree-dev:** chmod state/ so liquidsoap can write radio.log ([ebc1d0e](https://github.com/perminder-klair/subwave/commit/ebc1d0e4a7cb0a82b25a275b885c542ce0a1b803))
* **worktree-dev:** chmod state/ so liquidsoap can write radio.log ([f05aebb](https://github.com/perminder-klair/subwave/commit/f05aebb1abcfa569d50542c1e2a152734573c3ae))

## [0.1.3](https://github.com/perminder-klair/subwave/compare/v0.1.2...v0.1.3) (2026-05-23)


### Features

* **cli:** default setup mode to prod, reorder choices ([2a53725](https://github.com/perminder-klair/subwave/commit/2a53725bbb27776327070a3918f025992de2f224))
* **web:** default SUBWAVE_HOMEPAGE to player ([f93cbb9](https://github.com/perminder-klair/subwave/commit/f93cbb9bddda90fcfdaddaa82dc56e7cfdac85fe))


### Bug Fixes

* **cli:** pull published images in prod instead of rebuilding from source ([6386899](https://github.com/perminder-klair/subwave/commit/6386899208fc63dedbde27a50716d3225d81270d))
* **docker:** block dev env files from leaking into prod web image ([0024495](https://github.com/perminder-klair/subwave/commit/0024495a43397fcd6c1d8fa4e228afab10b06b10))
* **docker:** unify prod and dev on host port 7700 ([255555a](https://github.com/perminder-klair/subwave/commit/255555af2c4eedcbfe0bd9338bae60bd4ce68d20))

## [0.1.2](https://github.com/perminder-klair/subwave/compare/v0.1.1...v0.1.2) (2026-05-23)


### Features

* **tui:** auto-tune-in on mount ([e7a1466](https://github.com/perminder-klair/subwave/commit/e7a1466d7295b31bbef09acd71bc96a4457b4032))


### Bug Fixes

* **cli:** always build on setup and make port detection Linux-friendly ([7b53c3c](https://github.com/perminder-klair/subwave/commit/7b53c3c0059216cf12c0576dd3da4fd7bb237971))

## [0.1.1](https://github.com/perminder-klair/subwave/compare/v0.1.0...v0.1.1) (2026-05-23)


### Bug Fixes

* actually take the stream off air on stop ([b4416dc](https://github.com/perminder-klair/subwave/commit/b4416dc0c1325da6724068d9d8848b8e93c50ddf))
* **cli:** read radio.log via container when host read is blocked ([55da14f](https://github.com/perminder-klair/subwave/commit/55da14fe72ffcab97db27f488a343552fad0e500))
* don't force a Kokoro voice fallback onto non-Kokoro engines ([99e54a5](https://github.com/perminder-klair/subwave/commit/99e54a59b50d24c03bfe0df1c37590003a630bbc))
* reset persona voice when switching TTS engine ([f060abe](https://github.com/perminder-klair/subwave/commit/f060abef35544f7f0520a6a2fd2adbb8142c8424))
* sanitize persona voice per-engine at save time ([bf4cc91](https://github.com/perminder-klair/subwave/commit/bf4cc918b5b62594dc09a3ec42de6fe27c4dfb7a))
* subshell the cd fallback in health-check repo resolution ([8bfca47](https://github.com/perminder-klair/subwave/commit/8bfca47527868051aa2d4887d53bbd48aab5ce9d))
* subshell the cd fallback in health-check repo resolution ([c59de13](https://github.com/perminder-klair/subwave/commit/c59de13efe48178ff9af188c56c3d095be49a0b3))
* use a sentinel for the Chatterbox built-in-voice Select option ([9c65a32](https://github.com/perminder-klair/subwave/commit/9c65a32171e09b90989fbe22bb44233e0c684a13))
* use the built-in-voice Select sentinel in SettingsPanel too ([b64ea79](https://github.com/perminder-klair/subwave/commit/b64ea79a507217247f4af6e9166def6ac2c40305))


### Documentation

* add live demo links to README ([22198a7](https://github.com/perminder-klair/subwave/commit/22198a7b4ae545691ef6d5aa495b5e5b6c7abc88))
* add live demo links to README ([97c370b](https://github.com/perminder-klair/subwave/commit/97c370b5afd09d4bbbb841c81e20403edc5dc452))
* add operator manual for the admin console ([276b1ec](https://github.com/perminder-klair/subwave/commit/276b1ec20ae0b7528d7b206d9268ceb290822508))
* include Chatterbox wherever the TTS engines are enumerated ([1013ba6](https://github.com/perminder-klair/subwave/commit/1013ba6f50a428ae28ba94949c5c46943993c0e3))
* link setup and manual pages from the README's live-demo list ([24d66ea](https://github.com/perminder-klair/subwave/commit/24d66ea9c8fda2b9f77af08dd22a8a7348f4a48e))
* refresh README for personas, shows, skills, and cloud TTS ([328bab5](https://github.com/perminder-klair/subwave/commit/328bab50cfcbe49930398edc25f6f312e9b5fd30))
* refresh README for personas, shows, skills, and cloud TTS ([26d87d7](https://github.com/perminder-klair/subwave/commit/26d87d76a98db45d757e2623043627918023ba2c))
