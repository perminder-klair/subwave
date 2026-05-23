# Changelog

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
