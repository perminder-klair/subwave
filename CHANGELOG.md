# Changelog

## [0.35.0](https://github.com/perminder-klair/subwave/compare/v0.34.1...v0.35.0) (2026-07-03)


### Features

* **admin/shows:** Any mood option + unified Strict filter toggle ([#766](https://github.com/perminder-klair/subwave/issues/766)) ([4b4f1dc](https://github.com/perminder-klair/subwave/commit/4b4f1dc6d006c2d89cb0a2547a12baa7402e857b))
* **audio:** configurable loudness target + peak-aware asymmetric gain clamp ([#758](https://github.com/perminder-klair/subwave/issues/758)) ([1b10331](https://github.com/perminder-klair/subwave/commit/1b10331b7da45b219d9fc9b38efafaca1bf37133))
* **broadcast:** DJ-mode transition effects — filter sweep + echo washout ([#606](https://github.com/perminder-klair/subwave/issues/606)) ([a919386](https://github.com/perminder-klair/subwave/commit/a919386b9785f8ce24f14402f1d036dc4e6961fa))
* **dj:** on-air persona handoff at show boundaries ([#762](https://github.com/perminder-klair/subwave/issues/762)) ([da3ba9d](https://github.com/perminder-klair/subwave/commit/da3ba9da84820335d755f5e0ba9e44c137bf60ae))
* **library:** Reset tab — wipe all tagging data and start fresh ([#753](https://github.com/perminder-klair/subwave/issues/753)) ([a1eef42](https://github.com/perminder-klair/subwave/commit/a1eef428168d50a60c870e46eae6c1174291c154))
* **tagger:** embedding quality — weighted KNN voting, task prefixes, audio fusion, self-check ([#750](https://github.com/perminder-klair/subwave/issues/750)) ([a0ab345](https://github.com/perminder-klair/subwave/commit/a0ab345bfac37abe30256cd6288ed81592979dc1))


### Bug Fixes

* **admin/library:** disable Re-analyse acoustics when no analysis engine is running ([#767](https://github.com/perminder-klair/subwave/issues/767)) ([2cc6b1f](https://github.com/perminder-klair/subwave/commit/2cc6b1f4908746ab43b2adc2d27bf1477bd38ca8))
* **admin/library:** hide Backfill buttons on a virgin library, drop the Analyze label flip ([#756](https://github.com/perminder-klair/subwave/issues/756)) ([6b70475](https://github.com/perminder-klair/subwave/commit/6b7047525b82cec2dc3251e9f7ff7212397d3354))
* **admin/library:** vocal-activity modal checkboxes appear immediately on enable ([#755](https://github.com/perminder-klair/subwave/issues/755)) ([992feed](https://github.com/perminder-klair/subwave/commit/992feed3cc61d1bb694609534a2d419933a94213))
* **admin/shows:** alphabetize genre lean autocomplete options ([#770](https://github.com/perminder-klair/subwave/issues/770)) ([9a02313](https://github.com/perminder-klair/subwave/commit/9a023135bc31186fe9ceb06c92869499052597b9))
* **admin/shows:** touch-safe schedule painting — long-press to paint, tap to toggle, swipe scrolls ([#757](https://github.com/perminder-klair/subwave/issues/757)) ([8ec26bf](https://github.com/perminder-klair/subwave/commit/8ec26bf70045960ae1d0fdfae207aa1478fc502d))
* **app:** send URL basic-auth as a header so iOS AVPlayer can stream ([#764](https://github.com/perminder-klair/subwave/issues/764)) ([#772](https://github.com/perminder-klair/subwave/issues/772)) ([68c3c3a](https://github.com/perminder-klair/subwave/commit/68c3c3a5f709d7a2420b9c0de6d52f4a5c263814))
* **broadcast:** stop hourly archive when station is taken off air ([#768](https://github.com/perminder-klair/subwave/issues/768)) ([aa414dd](https://github.com/perminder-klair/subwave/commit/aa414ddfe7ce8db2f551ce23e22db6cbf93172e7))
* **broadcast:** stop shipping mis-targeted DJ adaptive-blend length ([#749](https://github.com/perminder-klair/subwave/issues/749)) ([#760](https://github.com/perminder-klair/subwave/issues/760)) ([3347249](https://github.com/perminder-klair/subwave/commit/334724915bd2b56301d37903bc7d74578c36bc86))
* **controller/library:** stop post-analysis UI slowdown from fat acoustic rows ([#723](https://github.com/perminder-klair/subwave/issues/723)) ([#771](https://github.com/perminder-klair/subwave/issues/771)) ([0b94f41](https://github.com/perminder-klair/subwave/commit/0b94f41729f8b990e8ee157dcf6908ff7c460fa2))
* **dj-agent:** salvage unknown-id picks and make empty tool results teach ([#763](https://github.com/perminder-klair/subwave/issues/763)) ([c2e4260](https://github.com/perminder-klair/subwave/commit/c2e4260155984522e101a44bac1eac952097ac54))
* **dj-agent:** stop coaching transition effects the persona can't use ([#754](https://github.com/perminder-klair/subwave/issues/754)) ([69c80ff](https://github.com/perminder-klair/subwave/commit/69c80ff10b4c82017d02b9cf460536c666bfce11))
* **dj:** hemisphere-correct season + surface day/night, so the DJ stops describing summer heat in a southern-hemisphere winter ([#765](https://github.com/perminder-klair/subwave/issues/765)) ([1b1b35a](https://github.com/perminder-klair/subwave/commit/1b1b35a0f36e98ba0eccca19a8e00585cb55d6b6))
* **tts:** surface silent engine fallbacks + guide operators to matching-language voices ([#691](https://github.com/perminder-klair/subwave/issues/691), [#725](https://github.com/perminder-klair/subwave/issues/725)) ([#761](https://github.com/perminder-klair/subwave/issues/761)) ([4feca91](https://github.com/perminder-klair/subwave/commit/4feca91f05aeb2750ed008ba09dda95231c538f9))


### Documentation

* **unraid:** explain switching the one-click AIO install to the heavy image ([#747](https://github.com/perminder-klair/subwave/issues/747)) ([40a095f](https://github.com/perminder-klair/subwave/commit/40a095ff8e7aae3965b3f9301f6310a16b0a56dc))

## [0.34.1](https://github.com/perminder-klair/subwave/compare/v0.34.0...v0.34.1) (2026-07-02)


### Bug Fixes

* **aio:** install python3-dev for the diffq sdist build in heavy AIO image ([#744](https://github.com/perminder-klair/subwave/issues/744)) ([a31b2b7](https://github.com/perminder-klair/subwave/commit/a31b2b7620f9b1752df2d98daf3cc643db8e28cb))

## [0.34.0](https://github.com/perminder-klair/subwave/compare/v0.33.0...v0.34.0) (2026-07-02)


### Features

* **admin:** library tagging & embedding-config UX for new operators ([#730](https://github.com/perminder-klair/subwave/issues/730)) ([583ef82](https://github.com/perminder-klair/subwave/commit/583ef82927326fa0abd34869f2305c984df6fd93))
* **analyzer:** split acoustic analyzer into a default-on standalone sidecar image ([#717](https://github.com/perminder-klair/subwave/issues/717)) ([1f790aa](https://github.com/perminder-klair/subwave/commit/1f790aaca5fdd42415cd14b50c5467a1defe6e8d))
* **llm:** add configurable per-call max output tokens ([#712](https://github.com/perminder-klair/subwave/issues/712)) ([#719](https://github.com/perminder-klair/subwave/issues/719)) ([9d72caa](https://github.com/perminder-klair/subwave/commit/9d72caa3e640a8d3f977eb371cc1a0ce7a223bf8))
* **personas:** expand persona limits — soul 400→1000, roster 12→24 ([#722](https://github.com/perminder-klair/subwave/issues/722)) ([#728](https://github.com/perminder-klair/subwave/issues/728)) ([513bfe8](https://github.com/perminder-klair/subwave/commit/513bfe8e70e37a42651de7dd6adc9ae46559e7c3))
* **stations:** add ClippyZone FM ([#733](https://github.com/perminder-klair/subwave/issues/733)) ([a84e78e](https://github.com/perminder-klair/subwave/commit/a84e78e45eaaeb7803541e49219068e8b73ffd8f))


### Bug Fixes

* **admin:** restore Save button when editing the system prompt ([#724](https://github.com/perminder-klair/subwave/issues/724)) ([#729](https://github.com/perminder-klair/subwave/issues/729)) ([d483318](https://github.com/perminder-klair/subwave/commit/d4833186a2fb62e7a07dbc8f24f6af6465455187))
* **analyzer:** lend gcc to the diffq sdist build in heavy images ([#737](https://github.com/perminder-klair/subwave/issues/737)) ([51dc493](https://github.com/perminder-klair/subwave/commit/51dc493ea82df2519f57b90303d56bf23aa4639e))
* **analyzer:** pass HF_TOKEN through to the analyzer sidecar ([#739](https://github.com/perminder-klair/subwave/issues/739)) ([1bc8983](https://github.com/perminder-klair/subwave/commit/1bc89831908799976a84b651a17e8bbda38072d9))
* **embeddings:** make embedding-model changes actually work (fresh + populated) ([#721](https://github.com/perminder-klair/subwave/issues/721)) ([aadd954](https://github.com/perminder-klair/subwave/commit/aadd954479d6fc2f820f9d4fe5d5f97539778575))
* **picker:** skip mood-name playlist match when a show pins playlists ([#718](https://github.com/perminder-klair/subwave/issues/718)) ([9cda732](https://github.com/perminder-klair/subwave/commit/9cda732ab864f2282eff2ddc930c368d07f10a15))
* **queue:** replace _autoMisses heuristic with Liquidsoap telnet sync… ([#637](https://github.com/perminder-klair/subwave/issues/637)) ([b0e3936](https://github.com/perminder-klair/subwave/commit/b0e39364fc788e07a1bc5f083ce4057f9be8e09a))
* **tagger:** mute raw-debug stderr mirror in the standalone tagger ([#740](https://github.com/perminder-klair/subwave/issues/740)) ([b7d6c0c](https://github.com/perminder-klair/subwave/commit/b7d6c0caa4188c25eac206a08206f9f7e6ba16ec))

## [0.33.0](https://github.com/perminder-klair/subwave/compare/v0.32.0...v0.33.0) (2026-06-30)


### Features

* **admin:** full-screen editor dialog + unified list cards ([#708](https://github.com/perminder-klair/subwave/issues/708)) ([d0ebf16](https://github.com/perminder-klair/subwave/commit/d0ebf16ce26941dead52e5c61661689c0c6efa1c))
* **boardcast:** configurable stream bitrate ([#676](https://github.com/perminder-klair/subwave/issues/676)) ([85a9d18](https://github.com/perminder-klair/subwave/commit/85a9d18626f66ffe057089c62b0cdb539bd16a54))
* **shows:** anchor shows to Navidrome playlists ([#701](https://github.com/perminder-klair/subwave/issues/701)) ([56da727](https://github.com/perminder-klair/subwave/commit/56da7276a4b135eefc7133a99d46ef8987d91eae))
* **shows:** in-page show editor with save/delete confirms ([#694](https://github.com/perminder-klair/subwave/issues/694)) ([8d04b1d](https://github.com/perminder-klair/subwave/commit/8d04b1d491fe2ba2e29ed6ecfe5736e59ee4007a))
* **skills:** create, edit & delete skills from the admin UI ([#695](https://github.com/perminder-klair/subwave/issues/695)) ([b5ac6ff](https://github.com/perminder-klair/subwave/commit/b5ac6fffa6c741c51dd88787f5a3430c5ddf3574))
* **skills:** unify built-in & custom skills on one loader + services API ([#698](https://github.com/perminder-klair/subwave/issues/698)) ([1974d03](https://github.com/perminder-klair/subwave/commit/1974d0313aa02aa6b6174e51e0da924b05fdf238))
* **stream:** configurable stream outputs — FLAC mount, Opus bitrate, AAC-LC mount ([#699](https://github.com/perminder-klair/subwave/issues/699)) ([e821086](https://github.com/perminder-klair/subwave/commit/e82108644127830ab38d6f25b809b7b5e9f79a42))
* **tts:** add remote TTS engine for self-hosted HTTP endpoints ([#672](https://github.com/perminder-klair/subwave/issues/672)) ([6d4621d](https://github.com/perminder-klair/subwave/commit/6d4621dab3ea48817a03e4c3d398cd881ba26816))


### Bug Fixes

* **admin:** stop native basic-auth popup on skill edit ([#709](https://github.com/perminder-klair/subwave/issues/709)) ([78b7bdc](https://github.com/perminder-klair/subwave/commit/78b7bdc4bee067c286eb6eee1614282cba59b624))
* **stats:** scroll the pick-source list + reliably wire the docker-socket-proxy ([#693](https://github.com/perminder-klair/subwave/issues/693)) ([ba06f94](https://github.com/perminder-klair/subwave/commit/ba06f94d0be18455a4a962290af9ea7712a8c5a9))

## [0.32.0](https://github.com/perminder-klair/subwave/compare/v0.31.0...v0.32.0) (2026-06-29)


### Features

* **api:** /listen.pls + /listen.m3u tune-in endpoints + now-playing stream block ([#670](https://github.com/perminder-klair/subwave/issues/670)) ([0b1f48f](https://github.com/perminder-klair/subwave/commit/0b1f48f10f622a130cf9310ac641fff06f9d7244))
* **scrobble:** in-admin "Connect to Last.fm", drop the CLI session-key step ([#686](https://github.com/perminder-klair/subwave/issues/686)) ([590eb32](https://github.com/perminder-klair/subwave/commit/590eb32e21797856c1d86290894d2125c13465bc))
* **web:** lite mode to drop blur + animations on low-power devices ([#661](https://github.com/perminder-klair/subwave/issues/661)) ([e77b72c](https://github.com/perminder-klair/subwave/commit/e77b72c69eaf41338b969861dc13525229a35791))
* **web:** visual show editor with genre, persona & theme pickers ([#674](https://github.com/perminder-klair/subwave/issues/674)) ([1d33de6](https://github.com/perminder-klair/subwave/commit/1d33de6242e90ce78792ed6094726198be731d10))


### Bug Fixes

* **app:** clamp DJ thinking line so long scripts don't overlap the waveform ([#668](https://github.com/perminder-klair/subwave/issues/668)) ([0cf58fa](https://github.com/perminder-klair/subwave/commit/0cf58faee5c58be840dce154352707159ea95820))
* **broadcast:** forward-looking DJ links so a request can't make the DJ name a stale track ([#675](https://github.com/perminder-klair/subwave/issues/675)) ([1f9d38d](https://github.com/perminder-klair/subwave/commit/1f9d38d8b2f85e98b5eab07d27297dc7acb8da9a))
* **broadcast:** remove blank.skip that busy-loops at 100% CPU on empty library ([#660](https://github.com/perminder-klair/subwave/issues/660)) ([#665](https://github.com/perminder-klair/subwave/issues/665)) ([643248f](https://github.com/perminder-klair/subwave/commit/643248f2d307799c316b0eeb29984aefbfe5ca9e))
* **broadcast:** rotate jingles on the raw music source so they keep firing ([#687](https://github.com/perminder-klair/subwave/issues/687)) ([f1372ba](https://github.com/perminder-klair/subwave/commit/f1372ba1daf55b8a6f657182b2bf63ca5ae1a48b))
* **build:** copy controller/.npmrc into image so npm install gets legacy-peer-deps ([#678](https://github.com/perminder-klair/subwave/issues/678)) ([c16516c](https://github.com/perminder-klair/subwave/commit/c16516c268d86dd1c9f97c5f28b212a294c6f368))
* **build:** stamp deployed version into images so the admin footer isn't a release behind ([#663](https://github.com/perminder-klair/subwave/issues/663)) ([854f82e](https://github.com/perminder-klair/subwave/commit/854f82e017d276d79f868f712cc4ac483c6d2f5b))
* **caddy:** route /listen.pls + /listen.m3u to the controller ([#689](https://github.com/perminder-klair/subwave/issues/689)) ([d739d95](https://github.com/perminder-klair/subwave/commit/d739d953c86bd8d6e6e96c819c33c29fe805cd3a))
* **llm:** fail over to fallback model on upstream-overload errors ([#671](https://github.com/perminder-klair/subwave/issues/671)) ([#684](https://github.com/perminder-klair/subwave/issues/684)) ([40d57ae](https://github.com/perminder-klair/subwave/commit/40d57ae500faa1e519bf0c262188a2ac8e7ce6d8))
* **llm:** namespace inline API keys per-provider ([#657](https://github.com/perminder-klair/subwave/issues/657)) ([#664](https://github.com/perminder-klair/subwave/issues/664)) ([932f3a6](https://github.com/perminder-klair/subwave/commit/932f3a6d26f16d0ad6cb79530a72bae6653902b5))
* **onboarding:** surface errors and bound timeouts on the Test buttons ([#682](https://github.com/perminder-klair/subwave/issues/682)) ([#683](https://github.com/perminder-klair/subwave/issues/683)) ([66590ba](https://github.com/perminder-klair/subwave/commit/66590baab9e32447fae254a52b9a7ac5fc21c472))
* **tts:** run Chatterbox on RTX 50-series (Blackwell) GPUs ([#685](https://github.com/perminder-klair/subwave/issues/685)) ([53a4751](https://github.com/perminder-klair/subwave/commit/53a4751888491324e3317c7c42adf4e24ebef302))
* **web:** don't false-flag raw LLM-request dumps as warnings in tagging log ([#679](https://github.com/perminder-klair/subwave/issues/679)) ([bc9e562](https://github.com/perminder-klair/subwave/commit/bc9e5621f09a87ad019065e45b9e8eebcefd94af))


### Performance

* **tagger:** parallel enrichment, phase timings, heavy-embedding-model warning ([#662](https://github.com/perminder-klair/subwave/issues/662)) ([7d9f9be](https://github.com/perminder-klair/subwave/commit/7d9f9be211e54e5ec5c20f8449b756f32ec68990))

## [0.31.0](https://github.com/perminder-klair/subwave/compare/v0.30.0...v0.31.0) (2026-06-27)


### Features

* **admin:** add icons + light inactive bg to settings sidebar tabs ([#653](https://github.com/perminder-klair/subwave/issues/653)) ([a8b51f7](https://github.com/perminder-klair/subwave/commit/a8b51f7b16c54ea078888a7c724c809531288843))
* **admin:** card-grid embedding provider picker for the library tagger ([#649](https://github.com/perminder-klair/subwave/issues/649)) ([a61ed6b](https://github.com/perminder-klair/subwave/commit/a61ed6b572fd2539072b34e3d36fb5fde0168b63))
* **admin:** card-grid LLM provider & TTS engine pickers + onboarding model dropdown ([#645](https://github.com/perminder-klair/subwave/issues/645)) ([df052e7](https://github.com/perminder-klair/subwave/commit/df052e7ad528599f25c275f6a3069fe33bdc9e25))
* **admin:** city-search location picker with auto timezone ([#656](https://github.com/perminder-klair/subwave/issues/656)) ([c325995](https://github.com/perminder-klair/subwave/commit/c325995ee5097b05bac66c62d68c141c9bfb709d))
* **admin:** clear-archive button + DELETE /archives endpoint ([#648](https://github.com/perminder-klair/subwave/issues/648)) ([189fe77](https://github.com/perminder-klair/subwave/commit/189fe77fc9bf01ccef48a149511e64396f1698ce))
* **admin:** radio-card TTS engine picker + voice preview ([#151](https://github.com/perminder-klair/subwave/issues/151)) ([#640](https://github.com/perminder-klair/subwave/issues/640)) ([96b4116](https://github.com/perminder-klair/subwave/commit/96b41160bc14d85d67199e518990beec751c0881))
* **admin:** reorder theme tab, left-align create button, add theme removal ([#651](https://github.com/perminder-klair/subwave/issues/651)) ([6d85600](https://github.com/perminder-klair/subwave/commit/6d856001e344394916bcd99bc72878f886b34579))
* **admin:** searchable model discovery dropdown for all providers ([#615](https://github.com/perminder-klair/subwave/issues/615)) ([9936a4b](https://github.com/perminder-klair/subwave/commit/9936a4b5338429fdfca984134b0dbd3703dd9061))
* **tts:** per-engine and per-persona speech-speed multipliers ([#639](https://github.com/perminder-klair/subwave/issues/639)) ([fd5857a](https://github.com/perminder-klair/subwave/commit/fd5857a99c551e4d2d2f3517191ee2a2c93f8d55)), closes [#626](https://github.com/perminder-klair/subwave/issues/626)


### Bug Fixes

* **admin:** reflow theme buttons + reorder archive cards ([#654](https://github.com/perminder-klair/subwave/issues/654)) ([5238a23](https://github.com/perminder-klair/subwave/commit/5238a23cc084e2b1407c7c69563b4da3831919a4))
* **backup:** restore from state/ to bypass proxy upload caps ([#612](https://github.com/perminder-klair/subwave/issues/612)) ([#633](https://github.com/perminder-klair/subwave/issues/633)) ([8ad7862](https://github.com/perminder-klair/subwave/commit/8ad7862c1bc82f0892e1b58d780e2dd4f2e9eda9))
* **broadcast:** enforce max-track-length as a hard on-air cut ([#447](https://github.com/perminder-klair/subwave/issues/447)) ([#636](https://github.com/perminder-klair/subwave/issues/636)) ([01e1606](https://github.com/perminder-klair/subwave/commit/01e160668f3d81eaee12137b74af1078a2e63519))
* **picker:** guard artist/title requests to searchLibrary; disambiguate identifyRequestedTrack from searchByLyrics ([#631](https://github.com/perminder-klair/subwave/issues/631)) ([5237a0b](https://github.com/perminder-klair/subwave/commit/5237a0b5676f8eb1ae47fa9c4cf88624dbe3f61f))
* **picker:** let agent identify songs from pasted lyrics via web search ([#617](https://github.com/perminder-klair/subwave/issues/617)) ([bb3b4e6](https://github.com/perminder-klair/subwave/commit/bb3b4e6cd477d528bdad6b09d253d710d6971103))
* **picker:** non-relaxable count-based no-repeat guard + recent-plays dedup ([#638](https://github.com/perminder-klair/subwave/issues/638)) ([1533c23](https://github.com/perminder-klair/subwave/commit/1533c237de66399f8ad7621190f1e70443558c7e))
* **request:** dedup concurrent listener requests for the same track ([#619](https://github.com/perminder-klair/subwave/issues/619)) ([#635](https://github.com/perminder-klair/subwave/issues/635)) ([9c2abe4](https://github.com/perminder-klair/subwave/commit/9c2abe4bf8e75774955338e8639f7075ace498d7))
* **scheduler:** respect active show genre/era/energy on the fallback playlist ([#629](https://github.com/perminder-klair/subwave/issues/629)) ([#634](https://github.com/perminder-klair/subwave/issues/634)) ([0d3efae](https://github.com/perminder-klair/subwave/commit/0d3efaecbdd100cb8f3486a2734c9528f83daed2))
* **tts:** existsSync Kokoro model/voices in isAvailable() ([#655](https://github.com/perminder-klair/subwave/issues/655)) ([297eb55](https://github.com/perminder-klair/subwave/commit/297eb55071da566c5f57bd87cd35740726e325ab))
* **web:** gate backup tab's disk-list fetch on auth hydration ([#404](https://github.com/perminder-klair/subwave/issues/404)) ([#647](https://github.com/perminder-klair/subwave/issues/647)) ([c8dd8ae](https://github.com/perminder-klair/subwave/commit/c8dd8ae262095663f6d97f67a48981587d8901e1))
* **web:** make the volume knob touch-friendly with a relative vertical drag ([#641](https://github.com/perminder-klair/subwave/issues/641)) ([bc6a526](https://github.com/perminder-klair/subwave/commit/bc6a5267c7383cbc8f6dfa664a3ccabd59a60271)), closes [#627](https://github.com/perminder-klair/subwave/issues/627)
* **web:** reduce admin/doctor horizontal padding on mobile ([#644](https://github.com/perminder-klair/subwave/issues/644)) ([f5c93b5](https://github.com/perminder-klair/subwave/commit/f5c93b5bf34175b495004a33c589f0037ebfca3a))


### Refactors

* **admin:** move hourly archive card from danger zone to archives tab ([#650](https://github.com/perminder-klair/subwave/issues/650)) ([22b6d6e](https://github.com/perminder-klair/subwave/commit/22b6d6e3b89c6dfd8fea0fb07624015acf09f3db))
* **admin:** move jingle & sfx create/import into modals behind buttons ([#652](https://github.com/perminder-klair/subwave/issues/652)) ([dcff131](https://github.com/perminder-klair/subwave/commit/dcff1316d5cb19794841e70de3e994206cc956d0))

## [0.30.0](https://github.com/perminder-klair/subwave/compare/v0.29.0...v0.30.0) (2026-06-26)


### Features

* cap max track length for autonomous picks ([#447](https://github.com/perminder-klair/subwave/issues/447)) ([#601](https://github.com/perminder-klair/subwave/issues/601)) ([edab50d](https://github.com/perminder-klair/subwave/commit/edab50d8895e180cc1618f401c884e495128140b))
* **llm:** daily token usage cap with graceful degradation ([#599](https://github.com/perminder-klair/subwave/issues/599)) ([b9dbeb7](https://github.com/perminder-klair/subwave/commit/b9dbeb740753e46afdee09a2329322f4c5478289)), closes [#552](https://github.com/perminder-klair/subwave/issues/552)
* **picker:** surface moods, energy, duration, instrumental to DJ agent candidates ([#605](https://github.com/perminder-klair/subwave/issues/605)) ([c263b2d](https://github.com/perminder-klair/subwave/commit/c263b2df4f12016272fe66e11951e0c5b0aea88a))
* **picker:** tighten DJ-agent selection criteria and clean its session window ([#608](https://github.com/perminder-klair/subwave/issues/608)) ([63d2aff](https://github.com/perminder-klair/subwave/commit/63d2aff67861fb5bde74035b1a139dc02f4e271a))
* **web:** express max track length cap in seconds, not minutes ([#604](https://github.com/perminder-klair/subwave/issues/604)) ([c59c4d4](https://github.com/perminder-klair/subwave/commit/c59c4d4db5aefacc46579d5c2f793d0dbf196e3b))
* **web:** show app version in admin console footer ([#596](https://github.com/perminder-klair/subwave/issues/596)) ([ca360cd](https://github.com/perminder-klair/subwave/commit/ca360cdc68af902be9dea31fd95e4a93d28c8704))


### Bug Fixes

* **dj-agent:** gate mid-run link guidance on wantLink ([#610](https://github.com/perminder-klair/subwave/issues/610)) ([c5643bf](https://github.com/perminder-klair/subwave/commit/c5643bf8d52defb353643e8da16127ce537aa929))
* **embedding:** stop chat-provider switch from silently breaking vector search ([#607](https://github.com/perminder-klair/subwave/issues/607)) ([b382e18](https://github.com/perminder-klair/subwave/commit/b382e18b7bc4b6786f0712826a0b3e03d276ad1b))
* **picker:** stop artist/track over-repetition from three sources ([#603](https://github.com/perminder-klair/subwave/issues/603)) ([5fbd1cf](https://github.com/perminder-klair/subwave/commit/5fbd1cfa0e8a4e29e6fe55490b8abe689910f355))
* **player:** tie the DJ thinking line to the on-air track ([#546](https://github.com/perminder-klair/subwave/issues/546)) ([#597](https://github.com/perminder-klair/subwave/issues/597)) ([03478d3](https://github.com/perminder-klair/subwave/commit/03478d3dca53682411e51803846d59e6d1f2a78b))
* **sfx:** align under-voice stingers with the DJ's first word ([#609](https://github.com/perminder-klair/subwave/issues/609)) ([69d924d](https://github.com/perminder-klair/subwave/commit/69d924d5762ef0f5853596feda6366f552acf66f))
* **web:** derive manual guide count from GUIDE array ([#600](https://github.com/perminder-klair/subwave/issues/600)) ([babe2ab](https://github.com/perminder-klair/subwave/commit/babe2ab9f7566548403d4604caeda463a7bfc50d))

## [0.29.0](https://github.com/perminder-klair/subwave/compare/v0.28.0...v0.29.0) (2026-06-25)


### Features

* add Requesty as an OpenAI-compatible LLM provider ([#539](https://github.com/perminder-klair/subwave/issues/539)) ([ebd4521](https://github.com/perminder-klair/subwave/commit/ebd4521281cc74dc6789faa3f8f4fccd54291b54))
* **admin:** DJ Doc — station diagnostics + LLM review ([#582](https://github.com/perminder-klair/subwave/issues/582)) ([379ca1d](https://github.com/perminder-klair/subwave/commit/379ca1df1b37beef67543ae2193815a8fe726db0))
* **doctor:** catch weak-model structured-output failures + sharpen DJ Doc UX ([#592](https://github.com/perminder-klair/subwave/issues/592)) ([004bbac](https://github.com/perminder-klair/subwave/commit/004bbac88e057987c323222235f11f2ed23c4607))
* **llm:** opt-in tool_choice knob for forced-tool servers ([#570](https://github.com/perminder-klair/subwave/issues/570)) ([#588](https://github.com/perminder-klair/subwave/issues/588)) ([ec1498f](https://github.com/perminder-klair/subwave/commit/ec1498fe9daf6fbc98b1859121c7fe1a51603b78))
* **stations:** add WHIG, The Hig ([#581](https://github.com/perminder-klair/subwave/issues/581)) ([b40cfea](https://github.com/perminder-klair/subwave/commit/b40cfeaccc00a47b5db7f1305cb0a043c29b3119))
* **stations:** add WHIG, The Hig ([#591](https://github.com/perminder-klair/subwave/issues/591)) ([0461d00](https://github.com/perminder-klair/subwave/commit/0461d001f3121f9a6867966a00ea55c3f3053569))
* **tts:** pass persona soul to OpenAI TTS instructions ([#579](https://github.com/perminder-klair/subwave/issues/579)) ([#586](https://github.com/perminder-klair/subwave/issues/586)) ([0dd5a09](https://github.com/perminder-klair/subwave/commit/0dd5a093f4003d28de8168b8009690f09be5141e))


### Bug Fixes

* **controller:** persist curiosity dedup across restarts ([#577](https://github.com/perminder-klair/subwave/issues/577)) ([#587](https://github.com/perminder-klair/subwave/issues/587)) ([a95c987](https://github.com/perminder-klair/subwave/commit/a95c9871ab74c21f7d8a8cc686afd8ef01533eee))
* **picker:** gate embedding-backed discovery tools when the index is empty ([8f16d20](https://github.com/perminder-klair/subwave/commit/8f16d202a93aa8debc162d60402257d4112972ee))
* **web:** keep the DJ announcement clear of the visualizer ([#576](https://github.com/perminder-klair/subwave/issues/576)) ([#589](https://github.com/perminder-klair/subwave/issues/589)) ([f58abbf](https://github.com/perminder-klair/subwave/commit/f58abbffc8a8a1ddbb1530ccbc404159761d375c))

## [0.28.0](https://github.com/perminder-klair/subwave/compare/v0.27.0...v0.28.0) (2026-06-23)


### Features

* **app:** trust user-installed CAs on Android & clarify TLS failures ([#458](https://github.com/perminder-klair/subwave/issues/458)) ([#550](https://github.com/perminder-klair/subwave/issues/550)) ([1327ec9](https://github.com/perminder-klair/subwave/commit/1327ec99d11b7f19f3a310832f856fc4a758e21a))
* **library:** surface tts-heavy setup docs when the acoustic engine is off ([#559](https://github.com/perminder-klair/subwave/issues/559)) ([9af92cd](https://github.com/perminder-klair/subwave/commit/9af92cde4133dffeaf1aaaf3ba03c689842648e8)), closes [#553](https://github.com/perminder-klair/subwave/issues/553)
* **tts-heavy:** GPU opt-in for Chatterbox + Voices manual page & guide ([#562](https://github.com/perminder-klair/subwave/issues/562)) ([351a46d](https://github.com/perminder-klair/subwave/commit/351a46d01e26ef0b1735971a2311677da34aaeec))
* **web:** Booth Buddy DJ-line mascot with station toggle ([#563](https://github.com/perminder-klair/subwave/issues/563)) ([385a753](https://github.com/perminder-klair/subwave/commit/385a7539c91bbe338bbee508057194a4cdb3dc61))


### Bug Fixes

* **admin:** make AI show/persona generators tolerant of partial model output ([#556](https://github.com/perminder-klair/subwave/issues/556)) ([29bc697](https://github.com/perminder-klair/subwave/commit/29bc6973ec3812eb897be25951120f4fd0cbfcb4))
* **app:** replace gorhom sheet + drop gesture-handler stack to fix Android dead-touch (New Arch) ([#561](https://github.com/perminder-klair/subwave/issues/561)) ([b2d0a4a](https://github.com/perminder-klair/subwave/commit/b2d0a4ae5ce57e834262b06967977f99f560f670))
* **app:** request drawer hangs on "Closing…" after the first request ([#542](https://github.com/perminder-klair/subwave/issues/542)) ([0f7e22d](https://github.com/perminder-klair/subwave/commit/0f7e22d077607999a157bc7abf43ff88ce566d69))
* **dj-agent:** don't record a phantom pick when the dedup guard drops a track ([#548](https://github.com/perminder-klair/subwave/issues/548)) ([a8c8f44](https://github.com/perminder-klair/subwave/commit/a8c8f44027b35134ecfcd43b0d9b243fc131c6e9))
* **dj:** apply persona language to agent segments + cloud TTS ([#558](https://github.com/perminder-klair/subwave/issues/558)) ([#564](https://github.com/perminder-klair/subwave/issues/564)) ([04f3678](https://github.com/perminder-klair/subwave/commit/04f36787569070005a4a3445f5c62f505697238d))
* **embedding:** handle provider-prefixed model names in dim lookup ([ba5ae3e](https://github.com/perminder-klair/subwave/commit/ba5ae3e22507a3f4d537fab219c12b059ae7667e))
* **embedding:** honour EMBEDDING_API_KEY across providers (completes [#535](https://github.com/perminder-klair/subwave/issues/535)) ([#549](https://github.com/perminder-klair/subwave/issues/549)) ([676c9f6](https://github.com/perminder-klair/subwave/commit/676c9f6e2f1fb2dc4a0218957211d1991e52eb04))
* **library:** make Last.fm tag enrichment reachable from every path ([#541](https://github.com/perminder-klair/subwave/issues/541)) ([1b2e0d4](https://github.com/perminder-klair/subwave/commit/1b2e0d4be6d6a9e2497b921c688f71f0b461d817))
* **llm:** keep the DJ from failing loud when gemma ignores the forced done tool ([#555](https://github.com/perminder-klair/subwave/issues/555)) ([#560](https://github.com/perminder-klair/subwave/issues/560)) ([135ef0d](https://github.com/perminder-klair/subwave/commit/135ef0d54c3ef53f3790f9496ecdb7f9cc11920e))
* **personas:** mark "on air" by the effective persona, not the default ([#540](https://github.com/perminder-klair/subwave/issues/540)) ([175751b](https://github.com/perminder-klair/subwave/commit/175751b4ca74ab4a51ae851db70e6a872f0876eb))
* **queue:** deduplicate track pushes to prevent stacking ([#538](https://github.com/perminder-klair/subwave/issues/538)) ([43d3893](https://github.com/perminder-klair/subwave/commit/43d3893d8cf41ade9d7d0a1cd8f493452575753e))

## [0.27.0](https://github.com/perminder-klair/subwave/compare/v0.26.1...v0.27.0) (2026-06-23)


### Features

* **app:** diagnose connection failures and add an HTTP/HTTPS toggle in onboarding ([#458](https://github.com/perminder-klair/subwave/issues/458)) ([#527](https://github.com/perminder-klair/subwave/issues/527)) ([1762793](https://github.com/perminder-klair/subwave/commit/17627933f74e92e1face2cba4dc63171da064b5b))
* **controller:** fetch Last.fm artist tags directly via the Last.fm API ([#514](https://github.com/perminder-klair/subwave/issues/514)) ([ba3696e](https://github.com/perminder-klair/subwave/commit/ba3696ed9ad3685de73af2750807272d9a7fc36e))
* **controller:** persist last 10 raw LLM requests to a rolling log file ([#515](https://github.com/perminder-klair/subwave/issues/515)) ([11ccee0](https://github.com/perminder-klair/subwave/commit/11ccee0269e1b0f73ed618fca49c8829f391837a))
* **personas:** redesign editor — rotary tone dials, LED voice meter, full-width roster ([#526](https://github.com/perminder-klair/subwave/issues/526)) ([ca5ef25](https://github.com/perminder-klair/subwave/commit/ca5ef25036d10595e294dda99f5c10cef4a64dcc))
* **picker:** add per-show strict genre lean (hard-filter the pool, soft fallback) ([#516](https://github.com/perminder-klair/subwave/issues/516)) ([b23b8ff](https://github.com/perminder-klair/subwave/commit/b23b8ff59cd060afa762f84457facf3dca49b3b6))
* **skills:** make traffic brief region-agnostic and sharper ([#509](https://github.com/perminder-klair/subwave/issues/509)) ([7310f5d](https://github.com/perminder-klair/subwave/commit/7310f5dbd96b8de67ea800cfc582bdf5e21319b6))


### Bug Fixes

* **admin:** de-glitch shows add/edit modal + frosted backdrop ([#519](https://github.com/perminder-klair/subwave/issues/519)) ([36f947c](https://github.com/perminder-klair/subwave/commit/36f947c0a281c268a87656284ce080903b443361))
* **auth:** harden admin auth with timing-safe comparison and brute-force lockoutFix/admin auth timing bruteforce ([#491](https://github.com/perminder-klair/subwave/issues/491)) ([83195e5](https://github.com/perminder-klair/subwave/commit/83195e583044c7988ec54d24e456efb4010f9f13))
* **auth:** reset brute-force counter after lockout window expires ([#517](https://github.com/perminder-klair/subwave/issues/517)) ([55f17af](https://github.com/perminder-klair/subwave/commit/55f17af46fe6805282434bcb33a6863a58abc8ca))
* **embeddings:** support OpenRouter as an embedding provider ([#522](https://github.com/perminder-klair/subwave/issues/522)) ([#523](https://github.com/perminder-klair/subwave/issues/523)) ([403b3b8](https://github.com/perminder-klair/subwave/commit/403b3b89969e2bc56f1b632e97f84c8b04f6991b))
* **personas:** give feedback when adding a persona ([#518](https://github.com/perminder-klair/subwave/issues/518)) ([cc899c0](https://github.com/perminder-klair/subwave/commit/cc899c0075f24119ce4c456743f136751ffedd54))
* **unraid:** lowercase CA app name to "subwave" + broaden search terms (discoverability) ([#512](https://github.com/perminder-klair/subwave/issues/512)) ([a1d49c4](https://github.com/perminder-klair/subwave/commit/a1d49c46879956f845a3a19ce3af4f487db749d4))
* **web:** resolve schedule "On now" in station timezone, not browser ([#510](https://github.com/perminder-klair/subwave/issues/510)) ([1033d6f](https://github.com/perminder-klair/subwave/commit/1033d6f4d3dd88a0bca880f12cc034e4ce7cfa88))


### Documentation

* **unraid:** make BYO reverse-proxy (NPM/SWAG/Traefik) guidance front-and-center ([#513](https://github.com/perminder-klair/subwave/issues/513)) ([9793302](https://github.com/perminder-klair/subwave/commit/9793302fab43061d761cc0a973b7d5e7976911e2))
* **unraid:** mark CA listing live, humanize Overview + setup pages, add news dispatch ([#507](https://github.com/perminder-klair/subwave/issues/507)) ([9254956](https://github.com/perminder-klair/subwave/commit/9254956062dd353369f933fceb3c7b181581a00a))

## [0.26.1](https://github.com/perminder-klair/subwave/compare/v0.26.0...v0.26.1) (2026-06-22)


### Bug Fixes

* **build:** publish subwave-aio amd64-only (arm64 webbuild fails under QEMU) ([#503](https://github.com/perminder-klair/subwave/issues/503)) ([e06d7ff](https://github.com/perminder-klair/subwave/commit/e06d7ff65f17741862fbf9eb1f6f4725b5e0c87e))

## [0.26.0](https://github.com/perminder-klair/subwave/compare/v0.25.0...v0.26.0) (2026-06-21)


### Features

* **admin:** AI "describe it → auto-fill" for personas, shows & themes ([#492](https://github.com/perminder-klair/subwave/issues/492)) ([7e77451](https://github.com/perminder-klair/subwave/commit/7e77451d0fcdd56785c478d1a3dedc51394745d4))
* **dj:** per-persona tone dials (humour, local colour, warmth) + anti-cliché ([#470](https://github.com/perminder-klair/subwave/issues/470)) ([1d9e586](https://github.com/perminder-klair/subwave/commit/1d9e58611b0f5a118ce7c3ab45bcc517aa0548f5))
* **unraid:** all-in-one image + Community Applications one-click install ([#499](https://github.com/perminder-klair/subwave/issues/499)) ([29332e0](https://github.com/perminder-klair/subwave/commit/29332e0162f9ede50e6754ceb4150138b8d10abb))


### Bug Fixes

* **onboarding:** redirect unconfigured player to wizard, Punjab default + coords, drop jingles ([#498](https://github.com/perminder-klair/subwave/issues/498)) ([1fde280](https://github.com/perminder-klair/subwave/commit/1fde2807eda4697fe1614e1c18bc48d6b19745fa))
* **tagger:** hide chat-only providers from the embedding picker ([#493](https://github.com/perminder-klair/subwave/issues/493)) ([#497](https://github.com/perminder-klair/subwave/issues/497)) ([678bf7f](https://github.com/perminder-klair/subwave/commit/678bf7f9bb9f472f4fed69f0ff1aadddd916a79f))
* **web:** clamp DJ thinking line so long scripts don't shove artwork under the header ([#486](https://github.com/perminder-klair/subwave/issues/486)) ([2540fc3](https://github.com/perminder-klair/subwave/commit/2540fc3095b675fc170cd6442b253fb66f1f5763))


### Documentation

* **news:** dispatch on running Chatterbox on an nvidia GPU ([#487](https://github.com/perminder-klair/subwave/issues/487)) ([aebfa7f](https://github.com/perminder-klair/subwave/commit/aebfa7f50a03f0eea06a1d5c70265438bc481e32))

## [0.25.0](https://github.com/perminder-klair/subwave/compare/v0.24.0...v0.25.0) (2026-06-21)


### Features

* **app:** support HTTP (cleartext) stations on iOS and Android ([#464](https://github.com/perminder-klair/subwave/issues/464)) ([dfe8fbf](https://github.com/perminder-klair/subwave/commit/dfe8fbf2de5491fdfb3a4fc7610f8a2cfd05db42))
* **dj:** per-skill context allow-lists; stop weather dominating DJ patter ([#471](https://github.com/perminder-klair/subwave/issues/471)) ([#482](https://github.com/perminder-klair/subwave/issues/482)) ([53abe6e](https://github.com/perminder-klair/subwave/commit/53abe6e0a24defe2530c3b33760ab4cdff3bad5b))
* import operator-supplied jingles and sound effects ([#468](https://github.com/perminder-klair/subwave/issues/468)) ([2511119](https://github.com/perminder-klair/subwave/commit/25111193a69b0bf23cd0b3c48b25d4a8621bc5bf))
* **stats:** scrollable Stats lists + per-container system resources ([#480](https://github.com/perminder-klair/subwave/issues/480)) ([8570932](https://github.com/perminder-klair/subwave/commit/8570932828c8acfc46f19287ca50ed18071a6e13))
* **tools:** Jamendo CC-track bulk-pull for demo library ([#465](https://github.com/perminder-klair/subwave/issues/465)) ([7b59324](https://github.com/perminder-klair/subwave/commit/7b593242b5dee6691fbbb445e9ff576eb6a99818))
* **tts:** per-engine + per-persona DJ voice gain dial ([#473](https://github.com/perminder-klair/subwave/issues/473)) ([bd3b203](https://github.com/perminder-klair/subwave/commit/bd3b203be9b7a84c8f9c92725ac9ba15c8b2c264))


### Bug Fixes

* **app:** consent before silent https→http downgrade in onboarding ([#472](https://github.com/perminder-klair/subwave/issues/472)) ([01cfaea](https://github.com/perminder-klair/subwave/commit/01cfaea65886b01109b1cb008687f8a863f3fb6b))
* **app:** remove Android Auto declaration rejected by Google Play ([#477](https://github.com/perminder-klair/subwave/issues/477)) ([468ff36](https://github.com/perminder-klair/subwave/commit/468ff3634963ce6d97c1174378997d9e8d65ad7d))
* **controller/llm:** route locca picker through done-tool, not native ([#467](https://github.com/perminder-klair/subwave/issues/467)) ([1a6ec25](https://github.com/perminder-klair/subwave/commit/1a6ec25e907543bab361c88fe50c72cfe7e8670e))
* **controller/llm:** route openai-compatible picker through done-tool, not native ([#474](https://github.com/perminder-klair/subwave/issues/474)) ([353c974](https://github.com/perminder-klair/subwave/commit/353c9742232bb6e4e2971607659a4b97bedee195))
* **stats:** read container metrics via docker-socket-proxy, not the raw socket ([#481](https://github.com/perminder-klair/subwave/issues/481)) ([7a4abbb](https://github.com/perminder-klair/subwave/commit/7a4abbbed7640099b089cd1d423c5893afc54456))
* transient stream-status no longer tears down playback ([#463](https://github.com/perminder-klair/subwave/issues/463), rebased to develop) ([#466](https://github.com/perminder-klair/subwave/issues/466)) ([8910200](https://github.com/perminder-klair/subwave/commit/891020024d4e8c9b07fe4996b984934eceb3ece2))

## [0.24.0](https://github.com/perminder-klair/subwave/compare/v0.23.0...v0.24.0) (2026-06-20)


### Features

* **app:** surface Now-Playing on CarPlay & Android Auto ([#444](https://github.com/perminder-klair/subwave/issues/444)) ([59da3a4](https://github.com/perminder-klair/subwave/commit/59da3a409ec0c4ac7d5242767dd9eada308bff3e))
* **shows:** steer per-show music by genre, decade, and energy ([#453](https://github.com/perminder-klair/subwave/issues/453)) ([422f888](https://github.com/perminder-klair/subwave/commit/422f8882930347a8a7913ad3f7ccd03a7a06896c))
* **stats:** show audience sources (referrers, geo, sessions) on admin Stats ([#456](https://github.com/perminder-klair/subwave/issues/456)) ([7e730d1](https://github.com/perminder-klair/subwave/commit/7e730d1d2f6b831b90b621bfffbe582dfcf32ae2))


### Bug Fixes

* **requests:** honest intro/ack when requested artist isn't in the library ([#455](https://github.com/perminder-klair/subwave/issues/455)) ([1c9b188](https://github.com/perminder-klair/subwave/commit/1c9b188c87a8099c24aa39bd9aa96af30134101a))
* **settings:** accept Kokoro voice ids under piper so seed personas save ([#454](https://github.com/perminder-klair/subwave/issues/454)) ([#457](https://github.com/perminder-klair/subwave/issues/457)) ([cd24673](https://github.com/perminder-klair/subwave/commit/cd2467332c25ef36ae22983b7103de679da9212c))


### Documentation

* music licensing disclaimer, FAQ, Terms page + private-station guide ([#452](https://github.com/perminder-klair/subwave/issues/452)) ([e2e48cf](https://github.com/perminder-klair/subwave/commit/e2e48cf917206f961b21241e005216adafc1bebd))

## [0.23.0](https://github.com/perminder-klair/subwave/compare/v0.22.0...v0.23.0) (2026-06-19)


### Features

* **player:** show cumulative LLM token count by the now-playing time ([#449](https://github.com/perminder-klair/subwave/issues/449)) ([b222b79](https://github.com/perminder-klair/subwave/commit/b222b7998a5c97944ebabc376af84e76475d458a))


### Bug Fixes

* **library:** show real tag status in Recently-added & Search tabs ([#448](https://github.com/perminder-klair/subwave/issues/448)) ([a9b313b](https://github.com/perminder-klair/subwave/commit/a9b313b5cba86b96d56e12089e7cc05e9bb42402))
* **listeners:** count distinct listeners behind a reverse proxy ([#445](https://github.com/perminder-klair/subwave/issues/445)) ([a16f641](https://github.com/perminder-klair/subwave/commit/a16f641c026d773112b8ca23cf04e9274432a1cf))
* **requests:** sanitize listener request text against prompt injection ([#446](https://github.com/perminder-klair/subwave/issues/446)) ([6a57792](https://github.com/perminder-klair/subwave/commit/6a577923f4e3286ceb2063d0cc8ddacdb958fb76))

## [0.22.0](https://github.com/perminder-klair/subwave/compare/v0.21.0...v0.22.0) (2026-06-18)


### Features

* **stations:** add 2618 Home Radio to the directory ([#435](https://github.com/perminder-klair/subwave/issues/435)) ([753a13e](https://github.com/perminder-klair/subwave/commit/753a13e4530fea721bd323e6ef5a79a6709a2b3a))
* **stations:** add Millennial FM ([#416](https://github.com/perminder-klair/subwave/issues/416)) ([17b9c49](https://github.com/perminder-klair/subwave/commit/17b9c4996e4b1df39cb54ce4d658725bcb4c79e7))


### Bug Fixes

* **admin:** make "Custom voice id…" selectable for cloud TTS voices ([#437](https://github.com/perminder-klair/subwave/issues/437)) ([a9618c1](https://github.com/perminder-klair/subwave/commit/a9618c150f8d8b0e7444609b0c81e6e8df324d89))
* **listeners:** dedupe Safari's double Icecast connection in counts + admin table ([#434](https://github.com/perminder-klair/subwave/issues/434)) ([24e0d49](https://github.com/perminder-klair/subwave/commit/24e0d494f2f74aa26b87ea7aa53592103ab0f075))
* **llm:** fail over on quota/usage-limit/auth errors, not just host-down ([#438](https://github.com/perminder-klair/subwave/issues/438)) ([#440](https://github.com/perminder-klair/subwave/issues/440)) ([beb4e95](https://github.com/perminder-klair/subwave/commit/beb4e95ddf3dea183f3a1f391d73f8cfe76a9070))
* **stations:** plot 2618 Home Radio + correct Millennial FM pin ([#436](https://github.com/perminder-klair/subwave/issues/436)) ([79afa90](https://github.com/perminder-klair/subwave/commit/79afa90accdb7c7609dcf11b04a0895ee62cae3a))


### Documentation

* **manual:** document locca + embeddings, link admin sections to the manual ([#433](https://github.com/perminder-klair/subwave/issues/433)) ([1fbc368](https://github.com/perminder-klair/subwave/commit/1fbc3683d843ebe8507e888e289d8cffa93771d9))
* **manual:** recommend Gemma 4 12B as the local sweet spot ([#439](https://github.com/perminder-klair/subwave/issues/439)) ([6ee69dd](https://github.com/perminder-klair/subwave/commit/6ee69dde0d498aa837de9f1b25a4a95ce2a0a2c9))

## [0.21.0](https://github.com/perminder-klair/subwave/compare/v0.20.0...v0.21.0) (2026-06-18)


### Features

* **admin:** add "Reconcile with Navidrome" to prune deleted tracks from the library ([#424](https://github.com/perminder-klair/subwave/issues/424)) ([fe50bd4](https://github.com/perminder-klair/subwave/commit/fe50bd4b5419570905cb2927d4071654a22ab9fb))
* **admin:** enrich Stats page — listener trend chart, cost, request analytics ([#427](https://github.com/perminder-klair/subwave/issues/427)) ([0652d78](https://github.com/perminder-klair/subwave/commit/0652d7841b5735247fcac9515fec9035dcf4257f))
* **dj:** cover 'latest song' + 'more like this' requests ([#428](https://github.com/perminder-klair/subwave/issues/428)) ([e418c30](https://github.com/perminder-klair/subwave/commit/e418c30d139de41d241cd7b47411ba5b2a7b1edc))
* **dj:** resolve described track requests via web search (request agent only) ([#425](https://github.com/perminder-klair/subwave/issues/425)) ([a9714dd](https://github.com/perminder-klair/subwave/commit/a9714ddf7cb70696f6f08bccaecc5c1ef800c477))
* **llm:** first-class locca provider + constrained pool picks ([#429](https://github.com/perminder-klair/subwave/issues/429)) ([9765425](https://github.com/perminder-klair/subwave/commit/9765425f41f1415a7c70964d6a2db7d11c181115))


### Refactors

* **admin:** slim Stats page — drop duplicate KPI strip + cost displays ([#431](https://github.com/perminder-klair/subwave/issues/431)) ([da3dab2](https://github.com/perminder-klair/subwave/commit/da3dab29bd00001bf71dc28382ed1b9cffa58621))

## [0.20.0](https://github.com/perminder-klair/subwave/compare/v0.19.0...v0.20.0) (2026-06-17)


### Features

* **admin:** fold Archives/Webhooks/Backup into Settings + tighten app links ([#420](https://github.com/perminder-klair/subwave/issues/420)) ([92695df](https://github.com/perminder-klair/subwave/commit/92695df82de73272103e7a057454a7f7f91f46af))


### Bug Fixes

* **ui:** render on-air timestamps in the station timezone, not the viewer's ([#418](https://github.com/perminder-klair/subwave/issues/418)) ([#421](https://github.com/perminder-klair/subwave/issues/421)) ([bbb6081](https://github.com/perminder-klair/subwave/commit/bbb6081768111e65938f46772110770dae59bf5d))


### Refactors

* **llm:** split sdk.ts into internal/** modules with data-driven provider capabilities ([#414](https://github.com/perminder-klair/subwave/issues/414)) ([3fba6bf](https://github.com/perminder-klair/subwave/commit/3fba6bf9591627da24011be1c869212874c1ba3f))

## [0.19.0](https://github.com/perminder-klair/subwave/compare/v0.18.0...v0.19.0) (2026-06-16)


### Features

* **admin:** add Manual link to bottom of admin sidebar ([#408](https://github.com/perminder-klair/subwave/issues/408)) ([1b7b9d1](https://github.com/perminder-klair/subwave/commit/1b7b9d13f5227b358d5ae4e257c457e24df60f74))
* **admin:** backup/restore station config + tag DB to a zip ([#410](https://github.com/perminder-klair/subwave/issues/410)) ([26b2ca0](https://github.com/perminder-klair/subwave/commit/26b2ca0142bc6d373fdc3b5b41ad645b37f923cf))
* **player:** show per-track genre/BPM/key/mood strip in now-playing ([#401](https://github.com/perminder-klair/subwave/issues/401)) ([bfbe763](https://github.com/perminder-klair/subwave/commit/bfbe7632eb2c7f67295773c02e1760cf29882cdd))


### Bug Fixes

* **broadcast:** bump MP3 stream 128 → 192 kbps ([#406](https://github.com/perminder-klair/subwave/issues/406)) ([6b2260a](https://github.com/perminder-klair/subwave/commit/6b2260a306cc44d2fdbd9ed7776a64f8cbd69259))
* **controller:** fuzzy-resolve requested artists + log near-misses ([#403](https://github.com/perminder-klair/subwave/issues/403)) ([6cacc02](https://github.com/perminder-klair/subwave/commit/6cacc029ccfb23cf01f41995d35d67f9b3912ef7))
* **llm:** reliable DJ picker across providers — native-first output, thinking-safe forced tools, SDK bump ([#407](https://github.com/perminder-klair/subwave/issues/407)) ([fcf94b0](https://github.com/perminder-klair/subwave/commit/fcf94b0100538d69d365fb5d2d59ceeba9a89d78))
* **release:** bump embedded CLI_VERSION via release-please generic updater ([#400](https://github.com/perminder-klair/subwave/issues/400)) ([0a5c51e](https://github.com/perminder-klair/subwave/commit/0a5c51e8419505bf1677b983afa76867665ce47d))


### Documentation

* **readme:** embed showreel video ([#409](https://github.com/perminder-klair/subwave/issues/409)) ([5ce070c](https://github.com/perminder-klair/subwave/commit/5ce070cefe5be689080e419003e9731060bfb678))

## [0.18.0](https://github.com/perminder-klair/subwave/compare/v0.17.0...v0.18.0) (2026-06-14)


### Features

* **tts-heavy:** bake CLAP + Demucs into the published image ([#393](https://github.com/perminder-klair/subwave/issues/393)) ([#395](https://github.com/perminder-klair/subwave/issues/395)) ([22f3dc8](https://github.com/perminder-klair/subwave/commit/22f3dc8f6a7ca256fdfb9b05100e348713478bba))

## [0.17.0](https://github.com/perminder-klair/subwave/compare/v0.16.0...v0.17.0) (2026-06-14)


### Features

* **admin:** anchor the dash latency redline to the DJ-agent deadline ([#392](https://github.com/perminder-klair/subwave/issues/392)) ([b110954](https://github.com/perminder-klair/subwave/commit/b1109547b6d4e1b641866c49329dfede2825d225))
* **admin:** show listener requests + DJ responses on dashboard ([#386](https://github.com/perminder-klair/subwave/issues/386)) ([95fb395](https://github.com/perminder-klair/subwave/commit/95fb39504ba71d24a83031c81647e41a16c4d159))
* **app:** show Discover stations on first-load onboarding ([#389](https://github.com/perminder-klair/subwave/issues/389)) ([dde8d9b](https://github.com/perminder-klair/subwave/commit/dde8d9b22c8af6858ce9af2993408f9f912fbff4))
* **web:** app store links on the landing Coda CTA ([#387](https://github.com/perminder-klair/subwave/issues/387)) ([d163796](https://github.com/perminder-klair/subwave/commit/d163796b1ce9fd1b30393d8be6ab776c55bc2d6c))
* **web:** showcase the Library Observatory on the landing page ([#385](https://github.com/perminder-klair/subwave/issues/385)) ([f9e5f2c](https://github.com/perminder-klair/subwave/commit/f9e5f2c7f26b1a1d9ba4ca697ee466a09a85cae2))
* **web:** station health strip on the admin dash header ([#388](https://github.com/perminder-klair/subwave/issues/388)) ([de5b071](https://github.com/perminder-klair/subwave/commit/de5b071a39c4969144ee5a21a0e20a6cc78382c2))


### Bug Fixes

* **broadcast:** fix crossfade buffer/fade mismatch causing gaps ([b0eb5b7](https://github.com/perminder-klair/subwave/commit/b0eb5b7fe9af05a7813ef346bdb191123f5b930b))
* **broadcast:** fix crossfade buffer/fade mismatch causing gaps ([579915a](https://github.com/perminder-klair/subwave/commit/579915a3d8f88e184f3667d0b95b1f7f382de9ea))

## [0.16.0](https://github.com/perminder-klair/subwave/compare/v0.15.0...v0.16.0) (2026-06-13)


### Features

* **analysis:** richer acoustic analysis (phases 1–6) ([#372](https://github.com/perminder-klair/subwave/issues/372)) ([300d0de](https://github.com/perminder-klair/subwave/commit/300d0deae43905fabc136e1d1588f9410ebdf6d5))
* **app:** browse community stations in the Discover list ([#375](https://github.com/perminder-klair/subwave/issues/375)) ([f718390](https://github.com/perminder-klair/subwave/commit/f71839037dd1fc8829f5db8b8f11e9f868a9c159))
* **app:** glassy frosted transport bar ([#376](https://github.com/perminder-klair/subwave/issues/376)) ([ab33346](https://github.com/perminder-klair/subwave/commit/ab33346e1937bd8f309389eb479155a60051d5fb))
* **observatory:** Library Observatory — data-art view of the DJ's library ([#373](https://github.com/perminder-klair/subwave/issues/373)) ([eb194e8](https://github.com/perminder-klair/subwave/commit/eb194e80ccf1e95d0dad854c9da73bc2fb6eed96))
* **web:** station tabs on the landing demo player ([#342](https://github.com/perminder-klair/subwave/issues/342)) ([defdecc](https://github.com/perminder-klair/subwave/commit/defdeccd4e8fd5144d6cfe55d875d58bddc8d445))


### Bug Fixes

* **broadcast:** soften heavy voice duck from 15% to 22% ([#382](https://github.com/perminder-klair/subwave/issues/382)) ([fcb025b](https://github.com/perminder-klair/subwave/commit/fcb025b0ebfc0cbc95368d1dcf4825ae98943a52))


### Documentation

* **app:** mark iOS app live on the App Store ([#374](https://github.com/perminder-klair/subwave/issues/374)) ([d502cd9](https://github.com/perminder-klair/subwave/commit/d502cd9483de9b1a333989d953d849f0867f6a80))
* **skills:** capture the live-app version-bump rule ([#379](https://github.com/perminder-klair/subwave/issues/379)) ([884bda7](https://github.com/perminder-klair/subwave/commit/884bda7df4fa289d3ea19461430bb3a5651c153b))
* **skills:** update app release skills for live store status ([#377](https://github.com/perminder-klair/subwave/issues/377)) ([e6fae20](https://github.com/perminder-klair/subwave/commit/e6fae2077ee58efcc3ffb76f0bdaf1854a0cb043))

## [0.15.0](https://github.com/perminder-klair/subwave/compare/v0.14.0...v0.15.0) (2026-06-12)


### Features

* **app:** dock player bar across all screens + slim live now-playing ([#366](https://github.com/perminder-klair/subwave/issues/366)) ([f330155](https://github.com/perminder-klair/subwave/commit/f3301554f36b153e6e0d9c4435531848145dc92c))
* **library:** CLAP capability warning + fix analyzer download hang ([#367](https://github.com/perminder-klair/subwave/issues/367)) ([7afdf95](https://github.com/perminder-klair/subwave/commit/7afdf95dfb5d10a38db97a1205190db1b336f3f0))
* **library:** simplify tagging panel + structured live tagger progress ([#363](https://github.com/perminder-klair/subwave/issues/363)) ([8decd10](https://github.com/perminder-klair/subwave/commit/8decd10214fdd6876e8e66777b509e316934c9e0))


### Documentation

* **web:** announce mobile apps live + copy cleanup ([#364](https://github.com/perminder-klair/subwave/issues/364)) ([60ddd5a](https://github.com/perminder-klair/subwave/commit/60ddd5afeea83f7a0a71138d40089f72bc88aa7e))

## [0.14.0](https://github.com/perminder-klair/subwave/compare/v0.13.0...v0.14.0) (2026-06-12)


### Features

* **admin:** station timezone setting driving the DJ clock ([#357](https://github.com/perminder-klair/subwave/issues/357)) ([dcabaf0](https://github.com/perminder-klair/subwave/commit/dcabaf0a1cf47ede174a9220c7e2de09fffd889e)), closes [#353](https://github.com/perminder-klair/subwave/issues/353)
* **app:** production-readiness — resilience UX, OTA, store config + docs ([#345](https://github.com/perminder-klair/subwave/issues/345)) ([3622940](https://github.com/perminder-klair/subwave/commit/3622940e024c43e935870806cc48d2935793c3cc))
* **controller:** operator-configurable DJ-agent deadline (default 45s) ([#354](https://github.com/perminder-klair/subwave/issues/354)) ([3ee80b8](https://github.com/perminder-klair/subwave/commit/3ee80b83b3978ed5ceb4501685af4b33f9bee5da))
* **dj:** per-persona on-air language + language-aware requests ([#350](https://github.com/perminder-klair/subwave/issues/350)) ([81cc896](https://github.com/perminder-klair/subwave/commit/81cc8965b1aac0744aa893bd5d2bc54cd99f4f3b))
* journey-steered agent picks + admin toggle for sounds-like analysis ([#351](https://github.com/perminder-klair/subwave/issues/351)) ([da779c1](https://github.com/perminder-klair/subwave/commit/da779c1e1def5be27574217ffac07f76f18795bd))
* **library:** manual mood/energy tagging for tracks and albums ([#336](https://github.com/perminder-klair/subwave/issues/336)) ([#355](https://github.com/perminder-klair/subwave/issues/355)) ([d5b10ac](https://github.com/perminder-klair/subwave/commit/d5b10ac64de6377c216d702450c131e45b434c53))
* parallel dual-LLM library tagging + num_ctx debug visibility ([#356](https://github.com/perminder-klair/subwave/issues/356)) ([64bb56f](https://github.com/perminder-klair/subwave/commit/64bb56fc1daa8ab0755436cab46650791fe236f7))
* true-audio (CLAP) embeddings + sonic journeys ([#337](https://github.com/perminder-klair/subwave/issues/337)) ([6b427f8](https://github.com/perminder-klair/subwave/commit/6b427f8251aac5fa0c0f7ee211c91034d51fad8c))


### Bug Fixes

* **controller:** enforce agent deadline + circuit-break failing agent picks ([#352](https://github.com/perminder-klair/subwave/issues/352)) ([5553606](https://github.com/perminder-klair/subwave/commit/5553606d9c0fa7d285a3c52a4e2c625ed0756e2a))
* **web:** restore Select dropdown height clamp under Tailwind v4 ([#360](https://github.com/perminder-klair/subwave/issues/360)) ([c4a9255](https://github.com/perminder-klair/subwave/commit/c4a92557161b340f1e5ece824eaad5637db8f1d9))
* **web:** tune out abandoned player tabs + back off reconnects ([#348](https://github.com/perminder-klair/subwave/issues/348)) ([f848fe3](https://github.com/perminder-klair/subwave/commit/f848fe367fd849da8ff09ef2c97167999dd40afb))


### Documentation

* add Discord invite to README and landing footer ([#347](https://github.com/perminder-klair/subwave/issues/347)) ([44a5796](https://github.com/perminder-klair/subwave/commit/44a5796e3c24f979aa3420a789339df3e9881d83))

## [0.13.0](https://github.com/perminder-klair/subwave/compare/v0.12.0...v0.13.0) (2026-06-10)


### Features

* **app:** native iOS/Android player app (Expo + React Native) ([#331](https://github.com/perminder-klair/subwave/issues/331)) ([e7e2db8](https://github.com/perminder-klair/subwave/commit/e7e2db84a327fae80eda83f8561224a2c33f9bd4))
* **picker:** add OpenSubsonic sonicSimilarity as an optional track source ([#332](https://github.com/perminder-klair/subwave/issues/332)) ([483116b](https://github.com/perminder-klair/subwave/commit/483116b24ddbdce46b540d3ff813e19fdd39932a))


### Bug Fixes

* **controller:** keep show brief in picker prompts + drop no-op KNN callback in tagger ([#338](https://github.com/perminder-klair/subwave/issues/338)) ([ef11882](https://github.com/perminder-klair/subwave/commit/ef1188251acb17f37bbc7df261fed992d7ff4047))


### Performance

* reduce re-renders, cache hot paths, trim stream overhead ([#339](https://github.com/perminder-klair/subwave/issues/339)) ([36aacc0](https://github.com/perminder-klair/subwave/commit/36aacc0972b4336f217bcf049ac526049b52b5ab))

## [0.12.0](https://github.com/perminder-klair/subwave/compare/v0.11.0...v0.12.0) (2026-06-08)


### Features

* **llm:** primary→fallback LLM with automatic failover ([#326](https://github.com/perminder-klair/subwave/issues/326)) ([27f6521](https://github.com/perminder-klair/subwave/commit/27f6521db57d1e5088940a25728324779be0d744))
* **stations:** add RoboRadio + The Ninth House ([#321](https://github.com/perminder-klair/subwave/issues/321), [#322](https://github.com/perminder-klair/subwave/issues/322)) ([#324](https://github.com/perminder-klair/subwave/issues/324)) ([3226cd2](https://github.com/perminder-klair/subwave/commit/3226cd2497c3a8df5711b9ddb51c1a66c6f78c52))
* **web:** live listener connections table in admin ([#318](https://github.com/perminder-klair/subwave/issues/318)) ([#328](https://github.com/perminder-klair/subwave/issues/328)) ([06326a9](https://github.com/perminder-klair/subwave/commit/06326a9f93e425e844a23e39b09babb8f41bc73b))


### Bug Fixes

* **controller:** probe-based embedding dim + clearer preflight errors ([#319](https://github.com/perminder-klair/subwave/issues/319)) ([#327](https://github.com/perminder-klair/subwave/issues/327)) ([fb789ba](https://github.com/perminder-klair/subwave/commit/fb789baf71ea6b8ba9e1e7de583fce40a1dd38a8))
* **controller:** salvage failed tag batches + prune orphaned library rows ([#323](https://github.com/perminder-klair/subwave/issues/323)) ([#325](https://github.com/perminder-klair/subwave/issues/325)) ([648d3bb](https://github.com/perminder-klair/subwave/commit/648d3bb9e3189d03ca4ed5876c43204c5f82f336))

## [0.11.0](https://github.com/perminder-klair/subwave/compare/v0.10.0...v0.11.0) (2026-06-06)


### Features

* **skills:** editable built-in skills + swappable news feed ([#313](https://github.com/perminder-klair/subwave/issues/313)) ([f654e43](https://github.com/perminder-klair/subwave/commit/f654e4335983f0785cf65e0530ea673dceccdd07))
* **stations:** no-fork station submissions via issue form ([#296](https://github.com/perminder-klair/subwave/issues/296)) ([#311](https://github.com/perminder-klair/subwave/issues/311)) ([8376a5d](https://github.com/perminder-klair/subwave/commit/8376a5dc23339e311b956b7c4e379bda2d06b589))
* **web:** redesign library page + fix tag-library reseed ([#307](https://github.com/perminder-klair/subwave/issues/307)) ([#315](https://github.com/perminder-klair/subwave/issues/315)) ([d7062dc](https://github.com/perminder-klair/subwave/commit/d7062dc14e3742f7edcebca9e3c460f281410ea7))


### Bug Fixes

* **controller:** stop DJ voice segments overlapping ([#310](https://github.com/perminder-klair/subwave/issues/310)) ([#312](https://github.com/perminder-klair/subwave/issues/312)) ([938c6f5](https://github.com/perminder-klair/subwave/commit/938c6f51d11aab0e82fdf02887271af0266db4a3))
* **web:** widen session-chat kind column to fit longest label ([#309](https://github.com/perminder-klair/subwave/issues/309)) ([9deaaf3](https://github.com/perminder-klair/subwave/commit/9deaaf3edc1288514651d230d03124ac625c60d5))

## [0.10.0](https://github.com/perminder-klair/subwave/compare/v0.9.0...v0.10.0) (2026-06-05)


### Features

* **web:** /stations community directory with live now-playing world map ([#290](https://github.com/perminder-klair/subwave/issues/290)) ([c7e7296](https://github.com/perminder-klair/subwave/commit/c7e72961a4a3a2d5a51219c2f71083bd8e0f245d))
* **web:** render /stations map as dotted continent silhouette ([#295](https://github.com/perminder-klair/subwave/issues/295)) ([0c2bd0e](https://github.com/perminder-klair/subwave/commit/0c2bd0e1f47f3b3ac3900ed2921a444bde8bdffb))


### Bug Fixes

* **cli:** sync embedded CLI_VERSION to package version (0.9.0) ([#305](https://github.com/perminder-klair/subwave/issues/305)) ([dd01016](https://github.com/perminder-klair/subwave/commit/dd0101652cc8d2f2f1bc9c10c6435a8d0c70ba7f))
* **controller:** emit picker output via done-tool on non-Ollama providers ([#301](https://github.com/perminder-klair/subwave/issues/301)) ([50a9d8b](https://github.com/perminder-klair/subwave/commit/50a9d8be62f25f19df5b8fb0824931b761cfe962))
* **controller:** relax picker recency for small libraries ([#299](https://github.com/perminder-klair/subwave/issues/299)) ([00bfb93](https://github.com/perminder-klair/subwave/commit/00bfb93f59366cfdb3d1452905142ef6ff828443))
* **controller:** set Ollama num_ctx so the DJ agent stops truncating its prompt ([#293](https://github.com/perminder-klair/subwave/issues/293)) ([d61bf14](https://github.com/perminder-klair/subwave/commit/d61bf143ea342e3c091f6ce9d0d6d29f4d604ebb)), closes [#291](https://github.com/perminder-klair/subwave/issues/291)
* **tts-heavy:** stop baking models at build, persist HF cache across recreates ([#294](https://github.com/perminder-klair/subwave/issues/294)) ([bde0ce7](https://github.com/perminder-klair/subwave/commit/bde0ce7b4a90dc0f8fc072aec76db1066179019f))
* **web:** disable PWA service worker in dev ([#304](https://github.com/perminder-klair/subwave/issues/304)) ([27b1b7e](https://github.com/perminder-klair/subwave/commit/27b1b7e7496b650313e6ddcf0862736ec8a21456))
* **web:** make visualizer & volume usable on iOS Safari ([#298](https://github.com/perminder-klair/subwave/issues/298)) ([#302](https://github.com/perminder-klair/subwave/issues/302)) ([131934c](https://github.com/perminder-klair/subwave/commit/131934cda9c4344c1aabf60b7ffee22a203d3b5f))
* **web:** shrink & lighten the mobile topbar's second line ([#292](https://github.com/perminder-klair/subwave/issues/292)) ([f785f1c](https://github.com/perminder-klair/subwave/commit/f785f1c58239e8f9243bad857c92990a355971bb))


### Documentation

* **web:** add /news dispatch announcing the stations directory ([#297](https://github.com/perminder-klair/subwave/issues/297)) ([48abb38](https://github.com/perminder-klair/subwave/commit/48abb3849ca01356ee69054161d2f1e5b15df390))

## [0.9.0](https://github.com/perminder-klair/subwave/compare/v0.8.0...v0.9.0) (2026-06-03)


### Features

* **web:** redesign player footer as a console deck with live signal meter ([#281](https://github.com/perminder-klair/subwave/issues/281)) ([2d07fd2](https://github.com/perminder-klair/subwave/commit/2d07fd27c89c5fcff70af7ebcfe28b821c064b35))

## [0.8.0](https://github.com/perminder-klair/subwave/compare/v0.7.0...v0.8.0) (2026-06-03)


### Features

* **web:** animated link component for landing, nav & news ([#274](https://github.com/perminder-klair/subwave/issues/274)) ([74b7ef6](https://github.com/perminder-klair/subwave/commit/74b7ef661b62289544eace3425e5a970f336ff79))
* **web:** reactive cover art — hover glitch, art-derived ambient wash ([#276](https://github.com/perminder-klair/subwave/issues/276)) ([2bad515](https://github.com/perminder-klair/subwave/commit/2bad515bd6bb4deabebaeebbf8cdeed84bf687e7))
* **web:** redesign request drawer as an on-air request slip ([#275](https://github.com/perminder-klair/subwave/issues/275)) ([70803d8](https://github.com/perminder-klair/subwave/commit/70803d83777968c8396f9a094f5a446bca5a9810))


### Bug Fixes

* **controller:** keep station archive recordings out of the library & DJ ([#277](https://github.com/perminder-klair/subwave/issues/277)) ([bdf0665](https://github.com/perminder-klair/subwave/commit/bdf0665cb80e40732fb2980593b9c24203ce506c)), closes [#273](https://github.com/perminder-klair/subwave/issues/273)
* **web:** personalise homepage link-preview with the operator's station name ([#272](https://github.com/perminder-klair/subwave/issues/272)) ([#278](https://github.com/perminder-klair/subwave/issues/278)) ([4e83988](https://github.com/perminder-klair/subwave/commit/4e83988d70018eb20e57fc9daff62f482bf23c37))

## [0.7.0](https://github.com/perminder-klair/subwave/compare/v0.6.0...v0.7.0) (2026-06-02)


### Features

* **web:** add 'The Stack' landing section on swappable LLMs, TTS & voice cloning ([#260](https://github.com/perminder-klair/subwave/issues/260)) ([f4c94d1](https://github.com/perminder-klair/subwave/commit/f4c94d14d991227b58ae5bbbfa309fd312a5ab4f))
* **web:** add payload & recipe examples to the webhooks admin page ([#266](https://github.com/perminder-klair/subwave/issues/266)) ([106a23c](https://github.com/perminder-klair/subwave/commit/106a23c29d2f776e7edc4e85aa9e41a71be46031))
* **web:** make admin header Listen button open /listen in a new tab ([#263](https://github.com/perminder-klair/subwave/issues/263)) ([0efd06b](https://github.com/perminder-klair/subwave/commit/0efd06bc7bf0bc967cf4e6fe8149e988a749b7fd))
* **web:** punch up landing feature strip with real capabilities ([#258](https://github.com/perminder-klair/subwave/issues/258)) ([ead5450](https://github.com/perminder-klair/subwave/commit/ead54503d420bd3caf1644e6cf0b79e60d715d84))
* **web:** render admin/debug DJ context as a human-friendly summary ([#265](https://github.com/perminder-klair/subwave/issues/265)) ([aaf462f](https://github.com/perminder-klair/subwave/commit/aaf462f0a3b501f17dc831006bc52ce28f5a6b55))


### Bug Fixes

* **controller:** give picker agent the current track id so similarSongs/tracksLikeThis stop failing ([#267](https://github.com/perminder-klair/subwave/issues/267)) ([d33cd6e](https://github.com/perminder-klair/subwave/commit/d33cd6ef9e1fbea119381638711253aebabfd772))
* **controller:** stop DJ tools returning empty for titles & vibe queries ([#268](https://github.com/perminder-klair/subwave/issues/268)) ([2411337](https://github.com/perminder-klair/subwave/commit/24113372af09d105a281c92c6527aadb54ff78ba))
* **docker:** retry controller model/binary downloads to survive transient HF/GitHub 5xx ([#257](https://github.com/perminder-klair/subwave/issues/257)) ([db66817](https://github.com/perminder-klair/subwave/commit/db6681708b787f231b8c292fc1c66d64ac695ac2))
* **web:** authenticate admin archive downloads ([#264](https://github.com/perminder-klair/subwave/issues/264)) ([683ff1d](https://github.com/perminder-klair/subwave/commit/683ff1de8b7a24fe0e95b2ca60d5e742f6367a52))
* **web:** keep masthead nav on one row on mobile ([#261](https://github.com/perminder-klair/subwave/issues/261)) ([0f130e2](https://github.com/perminder-klair/subwave/commit/0f130e286b4555faca1ce77a77fddf3dee0c69cc))

## [0.6.0](https://github.com/perminder-klair/subwave/compare/v0.5.0...v0.6.0) (2026-06-02)


### Features

* **web:** Fraunces player wordmark + article-head CTAs ([#254](https://github.com/perminder-klair/subwave/issues/254)) ([d075bdd](https://github.com/perminder-klair/subwave/commit/d075bdd05b9e21ffe0674ea78c610ec13ae79d15))
* **web:** full library re-scan + advanced passes in admin ([#248](https://github.com/perminder-klair/subwave/issues/248)) ([830327f](https://github.com/perminder-klair/subwave/commit/830327f45d2d1ae094abe7cd670452272acc6f70))
* **web:** refine player header, track meta, and DJ booth text ([#249](https://github.com/perminder-klair/subwave/issues/249)) ([9cfd947](https://github.com/perminder-klair/subwave/commit/9cfd9478cf352603c9c6bb1cadf0cdb022d4171c))
* **web:** switch type to Fraunces + Plus Jakarta Sans for a softer, premium feel ([#252](https://github.com/perminder-klair/subwave/issues/252)) ([1be1f9d](https://github.com/perminder-klair/subwave/commit/1be1f9d2ce1548133323f2fefc7c2fb4e6e99e58))


### Bug Fixes

* **web:** make all public pages SEO-friendly ([#251](https://github.com/perminder-klair/subwave/issues/251)) ([9afbdab](https://github.com/perminder-klair/subwave/commit/9afbdabf6eec4b3d829f7e0ed9dceea43902465a))


### Documentation

* **web:** remove Architecture section from README ([#253](https://github.com/perminder-klair/subwave/issues/253)) ([76461bd](https://github.com/perminder-klair/subwave/commit/76461bd2ae998771aa0a559d96745a58837fcfde))

## [0.5.0](https://github.com/perminder-klair/subwave/compare/v0.4.0...v0.5.0) (2026-06-01)


### Features

* **broadcast:** make the Opus mount optional + graceful client fallback ([#236](https://github.com/perminder-klair/subwave/issues/236)) ([a763c52](https://github.com/perminder-klair/subwave/commit/a763c52c7f66a8e9bf13ec78fdc76d3ff900a145))
* **web:** add Re-seed embeddings button to admin Library tab ([#239](https://github.com/perminder-klair/subwave/issues/239)) ([710fd30](https://github.com/perminder-klair/subwave/commit/710fd30484bbcb75b6cd7972d23087f1903a21d9)), closes [#237](https://github.com/perminder-klair/subwave/issues/237)
* **web:** show 'engine off' on acoustic analysis meter when no DSP backend ([#235](https://github.com/perminder-klair/subwave/issues/235)) ([9751fc5](https://github.com/perminder-klair/subwave/commit/9751fc52412365c7e43a9542956b3af1925bc0ce))


### Bug Fixes

* **cli:** point TUI download at a real release tag ([#242](https://github.com/perminder-klair/subwave/issues/242)) ([67e4c68](https://github.com/perminder-klair/subwave/commit/67e4c68db00c1541c37306b4a8ff813145ff475b))
* **tts:** make PocketTTS voice cloning work + surface when it can't ([#238](https://github.com/perminder-klair/subwave/issues/238)) ([#240](https://github.com/perminder-klair/subwave/issues/240)) ([2ebbec8](https://github.com/perminder-klair/subwave/commit/2ebbec8c9ff0b2c1789d52545ec7707dcb31e559))
* **web:** order news newest-first with human-friendly dates ([#241](https://github.com/perminder-klair/subwave/issues/241)) ([9a62423](https://github.com/perminder-klair/subwave/commit/9a6242350922ad876f0532cb883688e2be11be76))


### Documentation

* **claude:** trim CLAUDE.md under the 40k perf threshold ([#243](https://github.com/perminder-klair/subwave/issues/243)) ([79869a2](https://github.com/perminder-klair/subwave/commit/79869a238b72aedfccd1124a65a6f6890cc1c153))

## [0.4.0](https://github.com/perminder-klair/subwave/compare/v0.3.0...v0.4.0) (2026-06-01)


### Features

* AI DJ capabilities — daypart energy, cross-hour memory, DJ mode + track analysis ([#216](https://github.com/perminder-klair/subwave/issues/216)) ([#228](https://github.com/perminder-klair/subwave/issues/228)) ([ba79a53](https://github.com/perminder-klair/subwave/commit/ba79a5398c890f5e4d10bfdde278347cf9fa62d7))
* **tts:** per-persona custom Piper voices via drop-in .onnx files ([#232](https://github.com/perminder-klair/subwave/issues/232)) ([865c3e9](https://github.com/perminder-klair/subwave/commit/865c3e9c95ea025ec20a5baabdd293e1e8e9bf77)), closes [#230](https://github.com/perminder-klair/subwave/issues/230)


### Bug Fixes

* **web:** allow saving PocketTTS personas with a cloned .wav voice ([#231](https://github.com/perminder-klair/subwave/issues/231)) ([51a2423](https://github.com/perminder-klair/subwave/commit/51a242369b093636a60c4c2e6ec6e422e5c5b969))

## [0.3.0](https://github.com/perminder-klair/subwave/compare/v0.2.0...v0.3.0) (2026-05-31)


### Features

* **web:** add news "Dispatches" page with markdown articles ([#223](https://github.com/perminder-klair/subwave/issues/223)) ([4a221f0](https://github.com/perminder-klair/subwave/commit/4a221f085d40a0de88617116f6898ff79925659b))


### Bug Fixes

* **broadcast:** fatten Icecast burst + queue buffers to cut mobile stalls ([#224](https://github.com/perminder-klair/subwave/issues/224)) ([e421fe4](https://github.com/perminder-klair/subwave/commit/e421fe433f761b8725033babee489817abf86144))

## [0.2.0](https://github.com/perminder-klair/subwave/compare/v0.1.30...v0.2.0) (2026-05-31)


### Features

* **cli:** subwave uninstall + version-mismatch warning ([#211](https://github.com/perminder-klair/subwave/issues/211)) ([f8dd506](https://github.com/perminder-klair/subwave/commit/f8dd5062952fd8fe000d9ec88684636cb5e85c9b))
* **skills:** operator-pluggable custom skills via state/skills ([#210](https://github.com/perminder-klair/subwave/issues/210)) ([dc193f3](https://github.com/perminder-klair/subwave/commit/dc193f3171c3676c49974bd30f496db2835fbab8))
* **tts:** shared voice folder + PocketTTS cloning + scrollable voice select ([#213](https://github.com/perminder-klair/subwave/issues/213)) ([#217](https://github.com/perminder-klair/subwave/issues/217)) ([c4dcac4](https://github.com/perminder-klair/subwave/commit/c4dcac47ecbd22233c77f467604946489c00f0cf))
* **web:** prominent setup guide for uninstalled heavy TTS engines ([#220](https://github.com/perminder-klair/subwave/issues/220)) ([d8a3b60](https://github.com/perminder-klair/subwave/commit/d8a3b6083623d4b387aa9f5718bc389cee185d9b))
* **web:** reorder admin settings sidebar with Station first ([#219](https://github.com/perminder-klair/subwave/issues/219)) ([75ae565](https://github.com/perminder-klair/subwave/commit/75ae565c72f986401122f0c814aef38118eecdb3))


### Bug Fixes

* **setup:** auto-detect host timezone on fresh installs ([#205](https://github.com/perminder-klair/subwave/issues/205)) ([#214](https://github.com/perminder-klair/subwave/issues/214)) ([96defbd](https://github.com/perminder-klair/subwave/commit/96defbdadf37380244aa2e1f05d0c76906a68095))
* **web:** keep Firefox on MP3 mount (Opus goes silent on track change) ([#215](https://github.com/perminder-klair/subwave/issues/215)) ([8fdb0c9](https://github.com/perminder-klair/subwave/commit/8fdb0c93b5b9410840730b25846dd389d3d66e3b)), closes [#212](https://github.com/perminder-klair/subwave/issues/212)


### Documentation

* **skill:** add back-merge step to subwave-release-pr skill ([#209](https://github.com/perminder-klair/subwave/issues/209)) ([11030ba](https://github.com/perminder-klair/subwave/commit/11030ba043a1c73deca45d06f6fd09858221f2f3))

## [0.1.30](https://github.com/perminder-klair/subwave/compare/v0.1.29...v0.1.30) (2026-05-29)


### Bug Fixes

* macOS curl|sh installer hang + publish multi-arch (arm64) images ([#206](https://github.com/perminder-klair/subwave/issues/206)) ([e782ca0](https://github.com/perminder-klair/subwave/commit/e782ca0058df53b02dd54fcb29e1ebed99dbc047))
* **web:** split bundled command copy boxes, strip box comments ([#204](https://github.com/perminder-klair/subwave/issues/204)) ([02531af](https://github.com/perminder-klair/subwave/commit/02531af41f17825dadd559e63c3a5fc7d2d301e2))
* **web:** tighten landing hero spacing, single-rule credits strip ([#203](https://github.com/perminder-klair/subwave/issues/203)) ([da03123](https://github.com/perminder-klair/subwave/commit/da031236acaa520fe8f1d4a389a9cc3a39df75cc))

## [0.1.29](https://github.com/perminder-klair/subwave/compare/v0.1.28...v0.1.29) (2026-05-28)


### Bug Fixes

* **controller:** dj-agent recovery returns valid ids + pick.rejected observability ([#199](https://github.com/perminder-klair/subwave/issues/199)) ([ff4c22e](https://github.com/perminder-klair/subwave/commit/ff4c22e152088e380914bdabb311c93ab578bafb))
* **web:** drop dead T theme shortcut, document 4 → Schedule in player help ([#198](https://github.com/perminder-klair/subwave/issues/198)) ([c7df977](https://github.com/perminder-klair/subwave/commit/c7df9776b665d3e36d221921aea51d3f3675f121))


### Documentation

* **web:** thin em-dash density in manual and setup pages ([#200](https://github.com/perminder-klair/subwave/issues/200)) ([34b3b78](https://github.com/perminder-klair/subwave/commit/34b3b782a5789c7f0c3a8ce98a1ad1c1c0701419))

## [0.1.28](https://github.com/perminder-klair/subwave/compare/v0.1.27...v0.1.28) (2026-05-28)


### Features

* **personas:** Generate button — random DiceBear avatar in admin ([#186](https://github.com/perminder-klair/subwave/issues/186)) ([53373ca](https://github.com/perminder-klair/subwave/commit/53373ca66e1090d2aed16910cc4a1888e16bf910))
* **web:** per-listener theme switcher in player + admin headers ([#188](https://github.com/perminder-klair/subwave/issues/188)) ([22cc7d9](https://github.com/perminder-klair/subwave/commit/22cc7d9b436a6c1f9ecc55afc8721b836b6e2098))
* **web:** show station time and location on Schedule tab ([#187](https://github.com/perminder-klair/subwave/issues/187)) ([5a4ca33](https://github.com/perminder-klair/subwave/commit/5a4ca330e69a6f7f680a91b61221cf02b949165b))


### Bug Fixes

* **controller:** air DJ intros/links when their track starts, not one early ([#189](https://github.com/perminder-klair/subwave/issues/189)) ([#191](https://github.com/perminder-klair/subwave/issues/191)) ([63055f2](https://github.com/perminder-klair/subwave/commit/63055f200794c1deb3feadbfc0c40ee25d41001e))
* **web:** admin UI polish — Library default tab + tagger strip, Dash & Personas layout ([#195](https://github.com/perminder-klair/subwave/issues/195)) ([bbe69c8](https://github.com/perminder-klair/subwave/commit/bbe69c8efa011548b0dc8cd2663442c27f479b7b))
* **web:** compress persona avatar to WebP so normal images upload ([#190](https://github.com/perminder-klair/subwave/issues/190)) ([b433a1a](https://github.com/perminder-klair/subwave/commit/b433a1a94f25a5ea747bd6fc9f8e3f3f2ce84d68))
* **web:** drop 'newsprint v3' line from admin console footer ([#196](https://github.com/perminder-klair/subwave/issues/196)) ([41159ae](https://github.com/perminder-klair/subwave/commit/41159aee2f1ec860f74173c9246e7ed44ab8ab32))
* **web:** theme picker opacity + schedule time/location in autonomous mode ([#194](https://github.com/perminder-klair/subwave/issues/194)) ([e7fce92](https://github.com/perminder-klair/subwave/commit/e7fce9244ffa476c2879b9567dcdcff1c454bbc7))

## [0.1.27](https://github.com/perminder-klair/subwave/compare/v0.1.26...v0.1.27) (2026-05-28)


### Features

* **controller:** support imperial weather units ([6fb24e2](https://github.com/perminder-klair/subwave/commit/6fb24e243c3ea05609a8566cdebfc82174e16239)), closes [#173](https://github.com/perminder-klair/subwave/issues/173)
* **controller:** support imperial weather units (closes [#173](https://github.com/perminder-klair/subwave/issues/173)) ([efba9dc](https://github.com/perminder-klair/subwave/commit/efba9dcaab371592033c791011c2635c5707c3f0))
* **personas+player:** persona avatars + listener Schedule drawer ([a219fd9](https://github.com/perminder-klair/subwave/commit/a219fd9e7f6df6104ae71471dba71f821a4a924a))
* **personas+player:** persona avatars + listener Schedule drawer ([40701a2](https://github.com/perminder-klair/subwave/commit/40701a24f11768f0d7a1c2eb2ea1543710234608))
* **player:** per-show theme override + manual page ([3ff52bb](https://github.com/perminder-klair/subwave/commit/3ff52bbb3df4448e3eff4676d359560dac93dc95))
* **player:** station-wide visual themes ([433ab98](https://github.com/perminder-klair/subwave/commit/433ab98aaca50bebc3454cf60b643c6e92a421e5))
* **player:** station-wide visual themes ([5967bef](https://github.com/perminder-klair/subwave/commit/5967befa33cc83d9f6fb76a0dc5221ccd71ba5ce))


### Bug Fixes

* **broadcast:** expand strftime in hourly archive path ([358cb94](https://github.com/perminder-klair/subwave/commit/358cb9481ea6f6c05651a720f7443011fc0d835c))
* **broadcast:** expand strftime in hourly archive path ([bc00d5c](https://github.com/perminder-klair/subwave/commit/bc00d5cf63793a853815e5b8c76c1cc4e3e4bcf3))
* **controller:** include station in /now-playing dj block so player header shows it ([d1a1b01](https://github.com/perminder-klair/subwave/commit/d1a1b014e316d55b846d017c052cfba276067997))
* **controller:** raise global JSON body limit so persona avatar uploads work ([f7f809f](https://github.com/perminder-klair/subwave/commit/f7f809f2921f605de1c3a372e807bf6a73f34511))
* **controller:** raise global JSON body limit so persona avatar uploads work ([09ddbd0](https://github.com/perminder-klair/subwave/commit/09ddbd014ecd9169e9352fd0997b2cda76ee3c6e))
* honour configured station name in DJ speech + Icecast mounts ([317aec8](https://github.com/perminder-klair/subwave/commit/317aec87a12a17cbd9ca34f0fdf9523b4742b78e))
* honour configured station name in DJ speech + Icecast mounts ([098b98c](https://github.com/perminder-klair/subwave/commit/098b98ca75d8a0ef59c7d30eb6ca7ba919aab735))
* **player:** show configured station name + lead DotRail with Schedule ([ad8474a](https://github.com/perminder-klair/subwave/commit/ad8474ac16ad82416959ee8120ff03281108f2d3))
* **tagger:** friendly preflight + auto-pull for embedding failures ([d980f9d](https://github.com/perminder-klair/subwave/commit/d980f9d79f068b924c7d5237cbed35b724cf020c))
* **tagger:** friendly preflight + auto-pull for embedding failures ([3721b1b](https://github.com/perminder-klair/subwave/commit/3721b1ba37338a950206483fa3fa65974014e0f9))
* **web:** keep Safari iOS on MP3 and auto-reconnect stalled &lt;audio&gt; ([861b68f](https://github.com/perminder-klair/subwave/commit/861b68fd946e559dcdcdb97a646eae3079be073f))
* **web:** keep Safari iOS on MP3 and auto-reconnect stalled audio ([2c1a439](https://github.com/perminder-klair/subwave/commit/2c1a439b2ec486d269774ab043233934c985791a))
* **web:** mobile layout regressions in admin panels ([c03fc33](https://github.com/perminder-klair/subwave/commit/c03fc33dde1eecc15430180a41aea675cbfb75a7))
* **web:** mobile layout regressions in admin panels ([d210b1e](https://github.com/perminder-klair/subwave/commit/d210b1ef863f44b7511ab0ebfea86d5d6f1f2b33))
* **web:** move Schedule above Timeline in the player DotRail ([e99d581](https://github.com/perminder-klair/subwave/commit/e99d58125da8523a5909c325a24fca179ab04756))
* **web:** wrap long DJ thinking line on narrow screens ([22fc061](https://github.com/perminder-klair/subwave/commit/22fc0619d8e6f490fb9825ff9ffa28cbd2722764))
* **web:** wrap long DJ thinking line on narrow screens ([20e6af6](https://github.com/perminder-klair/subwave/commit/20e6af67edf54b03d1d0e72b0be2387b8e6a0b09))

## [0.1.26](https://github.com/perminder-klair/subwave/compare/v0.1.25...v0.1.26) (2026-05-27)


### Features

* **controller:** embedding-propagated library tagger (SQLite + sqlite-vec) ([#157](https://github.com/perminder-klair/subwave/issues/157)) ([ec406b7](https://github.com/perminder-klair/subwave/commit/ec406b79d9b4600272440ce49ef47b5bfbb312ba))
* **tts:** tts-heavy sidecar for Chatterbox + PocketTTS ([#110](https://github.com/perminder-klair/subwave/issues/110)) ([419c25d](https://github.com/perminder-klair/subwave/commit/419c25d1ca937a6a48943ff6979bd1d2146cc132))


### Bug Fixes

* **cli:** bypass Bun's broken macOS stdin in curl|sh flow ([#165](https://github.com/perminder-klair/subwave/issues/165)) ([6bb5bb5](https://github.com/perminder-klair/subwave/commit/6bb5bb58473341d709fcde51b7b6a6abac23d468))
* **cli:** single-quote .env values + docker-group hint ([#156](https://github.com/perminder-klair/subwave/issues/156)) ([10c115d](https://github.com/perminder-klair/subwave/commit/10c115d04712138265e03055aec6bf1e425982c1))


### Refactors

* **settings:** split shows + schedule into state/schedule.json ([#162](https://github.com/perminder-klair/subwave/issues/162)) ([c5e454e](https://github.com/perminder-klair/subwave/commit/c5e454ec0cd27f2ab33e4e4342ec7c24c47b1487))

## [0.1.25](https://github.com/perminder-klair/subwave/compare/v0.1.24...v0.1.25) (2026-05-26)


### Documentation

* **readme:** humanize prose, add Features section, fix stale facts ([0b4256a](https://github.com/perminder-klair/subwave/commit/0b4256a4b27b88a98932d6c491ec8335741aa6ca))
* **readme:** humanize prose, add Features section, fix stale facts ([afda8ff](https://github.com/perminder-klair/subwave/commit/afda8ffa816fd53a07b69f46000184bc188196c3))

## [0.1.24](https://github.com/perminder-klair/subwave/compare/v0.1.23...v0.1.24) (2026-05-25)


### Bug Fixes

* **caddy:** use named matcher for multi-path stream handle ([9ae0471](https://github.com/perminder-klair/subwave/commit/9ae0471a90dde7aad79bd22d4923a99ef893faf8))
* **caddy:** use named matcher for multi-path stream handle ([bdb98d8](https://github.com/perminder-klair/subwave/commit/bdb98d8912cdb7733be2de57dd71721bae406de7))

## [0.1.23](https://github.com/perminder-klair/subwave/compare/v0.1.22...v0.1.23) (2026-05-25)


### Features

* **admin:** audio preview for jingles and sound effects ([#141](https://github.com/perminder-klair/subwave/issues/141)) ([005983b](https://github.com/perminder-klair/subwave/commit/005983bbc7e29d5c751a48c9a72b3cc9e6670900))
* **broadcast:** add Ogg-Opus stream alongside MP3 ([#142](https://github.com/perminder-klair/subwave/issues/142)) ([c542285](https://github.com/perminder-klair/subwave/commit/c542285c6eb619c0e7f563ff03bcdc93c67d764b))
* **controller:** add curiosity, album-anniversary, library-deep-cut skills ([3999f63](https://github.com/perminder-klair/subwave/commit/3999f636335c1397a59676dbb3bf09bb28118089))
* **controller:** add curiosity, album-anniversary, library-deep-cut skills ([aa3913e](https://github.com/perminder-klair/subwave/commit/aa3913e19f2ac324d3ea52c03c9f992284aab2c0))
* **web:** haptic feedback on drawer open/close ([345d6f8](https://github.com/perminder-klair/subwave/commit/345d6f851566c924e4a8a3d28b9b3f89e04e3e2a))
* **web:** haptic feedback on drawer open/close ([bab87c0](https://github.com/perminder-klair/subwave/commit/bab87c0893fe2fc592b31256d9f5273203f45165))


### Bug Fixes

* **ci:** pin release-please target-branch to main ([9138de0](https://github.com/perminder-klair/subwave/commit/9138de0cd8cb064270f91aa8a7972fbfc2b6a3a6))
* **ci:** pin release-please target-branch to main + restore conventional history ([db33b3b](https://github.com/perminder-klair/subwave/commit/db33b3beaa2464ec3160b59491a19d6c8f471c06))
* **controller:** harden DJ segments against transient LLM/IPC failures ([#140](https://github.com/perminder-klair/subwave/issues/140)) ([#145](https://github.com/perminder-klair/subwave/issues/145)) ([6a560c9](https://github.com/perminder-klair/subwave/commit/6a560c962f374b5747954cd3da68540362c03b8e))
* **skill:** worktree-dev prep mirrors operator's declarative state ([f433bb5](https://github.com/perminder-klair/subwave/commit/f433bb583a99b86584d47ac2a2e9769a54749878))


### Performance

* **broadcast:** drop log verbosity and make hourly archive toggleable ([#139](https://github.com/perminder-klair/subwave/issues/139)) ([d642d84](https://github.com/perminder-klair/subwave/commit/d642d84b6cd56e605d6e0d66c37def80e9a3f3e4))

## [0.1.22](https://github.com/perminder-klair/subwave/compare/v0.1.21...v0.1.22) (2026-05-25)


### Bug Fixes

* **web:** unblock image build — ripple.tsx tailwind order + inline-style lint ([b5b4dea](https://github.com/perminder-klair/subwave/commit/b5b4dea523689b95831317bf818ad4cc4e3bae7e))

## [0.1.21](https://github.com/perminder-klair/subwave/compare/v0.1.20...v0.1.21) (2026-05-25)


### Features

* scrobble to Last.fm and ListenBrainz ([#121](https://github.com/perminder-klair/subwave/issues/121)) ([#126](https://github.com/perminder-klair/subwave/issues/126)) ([fb76507](https://github.com/perminder-klair/subwave/commit/fb765078890d336a6ee0caa831f75f0f2e45c7d8))
* **web:** ripple effect behind now-playing artwork ([#129](https://github.com/perminder-klair/subwave/issues/129)) ([d4e3819](https://github.com/perminder-klair/subwave/commit/d4e38199f938d0f626370ed33bca211585fdfc9e))


### Bug Fixes

* **skill:** worktree-dev prep skips onboarding and follows root compose layout ([#127](https://github.com/perminder-klair/subwave/issues/127)) ([b59d41e](https://github.com/perminder-klair/subwave/commit/b59d41e6337d41a7fe2a86bcaa93bacd885e70b5))
* **tagger:** load wizard config in tag-library CLI ([#123](https://github.com/perminder-klair/subwave/issues/123)) ([b974eb9](https://github.com/perminder-klair/subwave/commit/b974eb96485a367b45541b984190fdb4222ea805)), closes [#122](https://github.com/perminder-klair/subwave/issues/122)


### Documentation

* **setup:** align with merged broadcast container ([#125](https://github.com/perminder-klair/subwave/issues/125)) ([ccd44d7](https://github.com/perminder-klair/subwave/commit/ccd44d77da4c07901c0afb823096b393823850c8))
* **skill:** warn against squash-merging release PRs ([8777cd0](https://github.com/perminder-klair/subwave/commit/8777cd0502d20e9b35ad5287a26fc293cf1cc7c5))


### Refactors

* **admin:** rename Mixer section to Station, move Crossfade to Danger zone ([#128](https://github.com/perminder-klair/subwave/issues/128)) ([56b1135](https://github.com/perminder-klair/subwave/commit/56b11351a7cec688c5832d003465f542156b2c8b))

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
