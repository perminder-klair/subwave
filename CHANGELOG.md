# Changelog

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
