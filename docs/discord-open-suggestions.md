# Open suggestion threads (Discord), cross-referenced against GitHub

Every thread in the community [#suggestions forum](https://discord.com/channels/1514647956333002812/1519660466933207223) that is **not** tagged `✅ Implemented`, with the matching GitHub issue and whether the ask has actually landed.

Captured 2026-09-06 — 65 of 125 threads, checked against all 334 issues (28 open) plus `git log` on `develop`. A snapshot, not a live view; the forum and the issue tracker are the sources of truth. Statuses are a judgement call from titles, bodies and commit history — the 🟡 and ⬜ rows are the ones most worth a second look.

## Status at a glance

| Status | Count | Meaning |
| --- | ---: | --- |
| ✅ Shipped | 6 | Delivered on `develop`; the thread can be closed out. |
| 🔨 Tracked | 12 | An **open** GitHub issue covers it. |
| 🟡 Partly covered | 20 | Related work has landed, but the specific ask has not. |
| ⬜ No issue | 27 | Nothing on GitHub — needs filing or an explicit reply. |

Open GitHub issues doing the most work here: [#1485](https://github.com/perminder-klair/subwave/issues/1485) (the follow-up tracker, 5 threads), [#1486](https://github.com/perminder-klair/subwave/issues/1486) (CarPlay + Android Auto, 2 threads) and [#1400](https://github.com/perminder-klair/subwave/issues/1400) (skill-aimed banter, 2 threads).

## 👀 Under Review (4)

### [Block talking over requests or favorites](https://discord.com/channels/1514647956333002812/1541421789576560640)

BrentNorrisKY · 2026-08-24

> I love the DJ doing lead ins for requests, but by the nature of it being something someone wants what if it by default pads the front to do the intro, since it is…

**🔨 Tracked** — #551 is the open issue. Front-padding a request intro with a bed instead of talking over shipped in #1465.

Refs: [#551](https://github.com/perminder-klair/subwave/issues/551) *(open)* · [#1465](https://github.com/perminder-klair/subwave/issues/1465)

### [Genre Leans within shows](https://discord.com/channels/1514647956333002812/1538883985097097246)

KeithyMcC · 2026-08-17

> I'm finding when i'm selecting genres within the genre leans section, i'll type a genre for example "trance" when i click one, it reverts back to the default list,…

**🟡 Partly covered** — The multi-genre-lean feature shipped (#929) and autocomplete was alphabetised (#770). The reported regression — clicking a typed genre reverts the list — has no issue.

Refs: [#929](https://github.com/perminder-klair/subwave/issues/929) · [#770](https://github.com/perminder-klair/subwave/issues/770)

### [Blocking album doesn't work](https://discord.com/channels/1514647956333002812/1534208297459257344)

Solo_mag · 2026-08-04

> All tracks from this album were previously blocked; now the radio is just playing the whole album in a row. =(

**⬜ No issue** — No GitHub issue despite being tagged Under Review on Discord — this one is a bug and needs filing.

### [Listener IP Shows Real IP](https://discord.com/channels/1514647956333002812/1528123266181632160)

Gurthyy · 2026-07-18 · also `💡 New Idea`

> I noticed that the listener section of the dash shows the loopback address (127.0.0.*) instead of their real, external IP (123.45.67.*) - if we could have it show…

**🟡 Partly covered** — The country rollup got a GeoIP fallback for plain reverse proxies (#1561, tracker FR 15). Showing the listener's real IP rather than the loopback address behind a proxy has no issue.

Refs: [#1561](https://github.com/perminder-klair/subwave/issues/1561) · [#1485](https://github.com/perminder-klair/subwave/issues/1485) *(open)*

## ⚪ Open (24)

### [world.md?](https://discord.com/channels/1514647956333002812/1527683829253279885)

BrentNorrisKY · 2026-07-17

> OK so what about if we add a world.md to the system? Let your DJs slowly build a world, where they have callbacks to things that DJs said days ago. This is like one…

**🔨 Tracked** — #1401 is the open issue for recurring storylines and narrative context. The decay mechanism that keeps it from collapsing into attractors was handled in #1479.

Refs: [#1401](https://github.com/perminder-klair/subwave/issues/1401) *(open)* · [#1479](https://github.com/perminder-klair/subwave/issues/1479)

### [Album queue option](https://discord.com/channels/1514647956333002812/1526711910790332507)

Taffy · 2026-07-14 · also `💡 New Idea`

> Feature: An album-queue mode where you pick an album and the station plays it in order as a block. Would be cool and play in the aspect that would enchance subwave as…

**🔨 Tracked** — FR 4 on the #1485 tracker — explicitly still unstarted, and noted as needing an operator-block flag that bypasses pair-drain and the artist guard.

Refs: [#1485](https://github.com/perminder-klair/subwave/issues/1485) *(open)*

### [playlist songs](https://discord.com/channels/1514647956333002812/1526373462355214498)

Sparks · 2026-07-13

> can we add an "on" of "off" button, that when its turned "on" all songs in that playlist have to play once before it can be played again?

**🟡 Partly covered** — playlistStrict shows can now loop correctly (#1480) and there is a playlist builder. An explicit play-every-song-once-before-repeating toggle is not tracked.

Refs: [#1480](https://github.com/perminder-klair/subwave/issues/1480)

### [Skills that trigger guest DJ Banter](https://discord.com/channels/1514647956333002812/1526186268063694928)

Mrain1 · 2026-07-13

> Create the ability for skills to trigger banter between dj's on the specific prompt topic. Example: A skill that lets a DJ asks the guest DJ(s) if they received any…

**🔨 Tracked** — Same open issue as the cohost-banter thread.

Refs: [#1400](https://github.com/perminder-klair/subwave/issues/1400) *(open)* · [#1524](https://github.com/perminder-klair/subwave/issues/1524)

### [Skin SDK + standalone skin kit](https://discord.com/channels/1514647956333002812/1525916662459666553)

perminder.klair · 2026-07-12

> Check for details https://github.com/perminder-klair/subwave/blob/6c6bde79615d89391261525e8c4972fde765b636/docs/skin-sdk-plan.md What's your feedback on this? Should…

**🔨 Tracked** — Carried on the #1485 tracker as the "runtime-loadable skins" small ask, still open. The design lives in docs/skin-sdk-plan.md.

Refs: [#1485](https://github.com/perminder-klair/subwave/issues/1485) *(open)*

### [Connection to Lidarr/Navidrome](https://discord.com/channels/1514647956333002812/1525653293991203017)

BrentNorrisKY · 2026-07-12

> So I love that Sub/Wave is letting me hear all my music. Sadly... some of it really sucks. What if we could link into Lidarr/Navidrome and remove a track? I have been…

**⬜ No issue** — No issue for write-back deletion. #692 (pluggable music sources) is the nearest open work but does not cover it.

Refs: [#692](https://github.com/perminder-klair/subwave/issues/692) *(open)*

### [More info available for djs and show descriptions on front end gui](https://discord.com/channels/1514647956333002812/1525633155581739099)

Mrain1 · 2026-07-11

> Would be nice to be able to double click into some of the show or dj info on the front end. Info is currently truncated, which doesn't allow users to see full show or…

**🟡 Partly covered** — The underlying limits were raised (persona souls #1105, show topic field #722) and the public roster read exposes descriptions. Expanding truncated text on the listener-facing UI is not tracked.

Refs: [#1105](https://github.com/perminder-klair/subwave/issues/1105) · [#722](https://github.com/perminder-klair/subwave/issues/722)

### [Allow disabling the Analyzer package via .env](https://discord.com/channels/1514647956333002812/1525541091116580864)

9acca9 · 2026-07-11

> Since I run the Analyzer on another PC, and the YAML files need updating some times, is it possible to add some syntax to the .env file that would allow me to…

**⬜ No issue** — No issue. The analyzer is a compose service today; remote analysis via ANALYZE_URL is the documented workaround, and #1538 added concurrency control for it.

Refs: [#1538](https://github.com/perminder-klair/subwave/issues/1538)

### [Couple of UI tweaks](https://discord.com/channels/1514647956333002812/1525105702794952825)

Wylie B · 2026-07-10

> When you go to the library page it probably should not check the library unless you want to make that check. Maybe a button to trigger it instead of the auto check.…

**⬜ No issue** — Grab-bag thread, nothing filed.

### [Various suggestions](https://discord.com/channels/1514647956333002812/1524901930755686472)

shinjuku70 · 2026-07-09

> First of all, this is one of the best and most exciting open source projects that I’ve seen in the last few years – kudos to @perminder.klair for creating it and…

**⬜ No issue** — Grab-bag thread, nothing filed.

### [Release Notes](https://discord.com/channels/1514647956333002812/1524463064953655326)

SamSoutherly · 2026-07-08

> I'm running the BYO docker compose and normally do a docker compose pull to do updates. When analyzer was released as a new compose thing it wasn't obvious that I…

**✅ Shipped** — The update procedure and rollback/recovery docs are ticked off on the #1485 tracker, and releases now carry generated notes.

Refs: [#1485](https://github.com/perminder-klair/subwave/issues/1485) *(open)*

### [Audiomuse AI integration](https://discord.com/channels/1514647956333002812/1524343336528379945)

perminder.klair · 2026-07-08

> Let's keep Audiomuse AI integration discussion here

**🔨 Tracked** — Open issue for AudioMuse-AI acoustic analysis / sonic fingerprinting.

Refs: [#707](https://github.com/perminder-klair/subwave/issues/707) *(open)*

### [Consolidate "scene" values](https://discord.com/channels/1514647956333002812/1523778045998268537)

Rones · 2026-07-06

> Maybe there is already a possibility to manage the "scene" values. After analyzing the whole music library there are some scene values which occur multiple times. I…

**⬜ No issue** — Nothing on GitHub for deduplicating scene vocabulary after a library pass.

### [Android Auto App](https://discord.com/channels/1514647956333002812/1522405176852611193)

PlasticFlowers · 2026-07-03

> @perminder.klair I decided to use my Fable 5 credits to build a small native Android app that gets the station into Android Auto. It shows up in the car's app…

**🔨 Tracked** — #1486 is the open issue — unblock and ship the CarPlay + Android Auto PR (#1229).

Refs: [#1486](https://github.com/perminder-klair/subwave/issues/1486) *(open)*

### [Enable calling of sound fx through the mcp/manual voice DJ](https://discord.com/channels/1514647956333002812/1522442941442953216)

Yrtria · 2026-07-03

> I'm trying to make an emergency warning system for weather on my radio. I've got an Hermes agent watching environment canada for warning about my city and area, and…

**✅ Shipped** — MCP gained on-air sound effects (#901: subwave_list_sfx / subwave_play_sfx), and manual jingles now air at full level and any length (#1468).

Refs: [#901](https://github.com/perminder-klair/subwave/issues/901) · [#1468](https://github.com/perminder-klair/subwave/issues/1468)

### [Media key control (including skip when logged in as admin)](https://discord.com/channels/1514647956333002812/1522241529417175080)

alexeiivanovich · 2026-07-02

> I know this potentially goes against the radio aesthetic but it would be great to be able to ask the dj to skip a track without changing app or taking hands off…

**⬜ No issue** — No issue, and note the design constraint: there is deliberately no /skip endpoint — track-end is the only natural transition.

### [Tagging optimization](https://discord.com/channels/1514647956333002812/1521908170119839844)

EveningPill · 2026-07-01

> Currently the propagation settings are very strict. knnNeighbours is set to 5 as default - way too low, there needs to be tagged ones there, so 10-20…

**⬜ No issue** — No issue for raising the knnNeighbours default or loosening propagation thresholds.

### [Configurable loudness normalisation (louder lift for very quiet tracks)](https://discord.com/channels/1514647956333002812/1521450603094474792)

Tim Stans · 2026-06-30

> The per-track loudness normalisation works great, but it's capped at ±6 dB toward the -14 LUFS target. Tracks that are mastered much quieter never catch up. Example…

**⬜ No issue** — ReplayGain support shipped (#705, #998, #1084), but the ±6 dB cap toward -14 LUFS is not operator-configurable and has no issue.

Refs: [#705](https://github.com/perminder-klair/subwave/issues/705) · [#998](https://github.com/perminder-klair/subwave/issues/998) · [#1084](https://github.com/perminder-klair/subwave/issues/1084)

### [Spanish with Kokoro please](https://discord.com/channels/1514647956333002812/1521635171680387072)

9acca9 · 2026-06-30

> Hi. it will be nice for spanish speakers like me... the easy way of just select a voice from Kokoro. And it seems to me that Kokoro is pretty good. My hardware is…

**🟡 Partly covered** — Kokoro's per-language phonemisation has been fixed twice (#1213 French, #1437 Japanese), so the machinery is there. Spanish voice selection is not separately tracked; #1381 is the broad non-English TTS issue.

Refs: [#1213](https://github.com/perminder-klair/subwave/issues/1213) · [#1437](https://github.com/perminder-klair/subwave/issues/1437) · [#1381](https://github.com/perminder-klair/subwave/issues/1381) *(open)*

### [Granular Controls on the Admin Dash](https://discord.com/channels/1514647956333002812/1521563377112191197)

Mrain1 · 2026-06-30

> Be able to more granularly change things in the dash override the scheduele with a show of your choosing, select specific tracks or artists, etc.

**🟡 Partly covered** — The show-pin override shipped (#930, #1543). Selecting specific tracks or artists from the dash is not tracked.

Refs: [#930](https://github.com/perminder-klair/subwave/issues/930) · [#1543](https://github.com/perminder-klair/subwave/issues/1543)

### [Android Auto](https://discord.com/channels/1514647956333002812/1521090597824495687)

Wylie B · 2026-06-29

> It would really be great to have the Android app work as a native app in Android Auto. Currently I'm using VLC and using the mp3 stream. Works ok but having the album…

**🔨 Tracked** — Same open issue as the Android Auto App thread.

Refs: [#1486](https://github.com/perminder-klair/subwave/issues/1486) *(open)*

### [Show "Specials"](https://discord.com/channels/1514647956333002812/1520424657537335296)

PlasticFlowers · 2026-06-27

> Allow the option for a Show to pull from one folder (or a handpicked set of files) instead of the whole library. When set, the Show plays only those tracks, nothing…

**✅ Shipped** — Delivered as playlist-anchored shows (#701) plus the /admin/playlists builder — a show can be pinned to a hand-picked set.

Refs: [#701](https://github.com/perminder-klair/subwave/issues/701)

### [A few changes I made.](https://discord.com/channels/1514647956333002812/1519863574657372160)

PlasticFlowers · 2026-06-26

> See attached - hope these are helpful. Really getting into this project.

**⬜ No issue** — Attachment-based thread, nothing filed.

### [Turn off stream if no listeners](https://discord.com/channels/1514647956333002812/1519773984697090158)

Mrain1 · 2026-06-25

> I know we can turn off the DJ features when no listeners, but would be interested in a feature that would turn off the music streaming as well to lower any resource…

**🟡 Partly covered** — The programme idle-pauses when nobody is listening (#1066, stream.idleAfterMinutes; hardened in #1256). Actually stopping the Icecast stream to free resources is not tracked.

Refs: [#1066](https://github.com/perminder-klair/subwave/issues/1066) · [#1256](https://github.com/perminder-klair/subwave/issues/1256)

## 💡 New Idea (17)

### [Force long tracks to fade out when a show changes](https://discord.com/channels/1514647956333002812/1544691963695988777)

shinjuku70 · 2026-09-02

> Hello! I have quite a few shows on my station that are based on genres that sometimes have very long tracks (20-30 minutes +), like contemporary classical or…

**⬜ No issue** — Max-track-length cut-on-air exists (#447), but fading a long track *at a show boundary* has no issue.

Refs: [#447](https://github.com/perminder-klair/subwave/issues/447)

### [More control on spoken segments](https://discord.com/channels/1514647956333002812/1544677009131573248)

shinjuku70 · 2026-09-02

> Hello! It would be great to have more control on which spoken segments the DJs can use on their shows. Sometimes I would prefer to disable most of them (hourly check,…

**🟡 Partly covered** — Several dials shipped piecemeal — per-skill quips optional (#471), clock switch (#1286, #1380), talk-only-between-tracks (#1562). A per-segment-kind enable/disable for a show is not tracked; vocal-aware timing for announce() is FR 5a, still open.

Refs: [#1485](https://github.com/perminder-klair/subwave/issues/1485) *(open)* · [#471](https://github.com/perminder-klair/subwave/issues/471) · [#1286](https://github.com/perminder-klair/subwave/issues/1286) · [#1380](https://github.com/perminder-klair/subwave/issues/1380) · [#1562](https://github.com/perminder-klair/subwave/issues/1562)

### [Force play longer audio files via an API](https://discord.com/channels/1514647956333002812/1534964810930847824)

m 🪽 · 2026-08-06

> Hi! I'd like an option to force play an audio file via the API. There's currently a way to do that via SFX, but that caps out at 10 seconds. If that cap could be…

**🔨 Tracked** — #1424 is the open proposal (one-shot upload-and-air on the voice channel, skipping TTS); #1423 was closed in its favour. Manual jingles now air at any length (#1468).

Refs: [#1424](https://github.com/perminder-klair/subwave/issues/1424) *(open)* · [#1423](https://github.com/perminder-klair/subwave/issues/1423) · [#1468](https://github.com/perminder-klair/subwave/issues/1468)

### [Request music from Spotify or Youtube](https://discord.com/channels/1514647956333002812/1534902834053517402)

eiriol · 2026-08-06

> Sometimes, I want to play other songs not from my library. Is something like this possible? If I paste a link in the request box, the DJ downloads the song using…

**⬜ No issue** — No issue. Out-of-library sourcing has never been scoped.

### [Blocking an artist doesn't block tracks featuring them.](https://discord.com/channels/1514647956333002812/1534144640520028300)

Solo_mag · 2026-08-04

> I'm not sure what the best way to handle this is, but blocking each track individually doesn't seem like the best option. It might be good to add a feature (also…

**🟡 Partly covered** — Artist-key work covering collaborations and name variants shipped (#1251, #1406), and #1425 is the open follow-up on the agent path — but that is the *repeat guard*, not the blocklist. Blocklist matching on featured artists is untracked.

Refs: [#1251](https://github.com/perminder-klair/subwave/issues/1251) · [#1406](https://github.com/perminder-klair/subwave/issues/1406) · [#1425](https://github.com/perminder-klair/subwave/issues/1425) *(open)*

### [Minimum track length filter](https://discord.com/channels/1514647956333002812/1532717495541174342)

Solo_mag · 2026-07-31

> The settings already include: Danger Zone > Max track length — cut over-length tracks on air. Which is generally reasonable, so that a single track doesn't drag out…

**⬜ No issue** — Only the maximum is settable (#447). No issue for a floor.

Refs: [#447](https://github.com/perminder-klair/subwave/issues/447)

### [Jingles vs The DJ](https://discord.com/channels/1514647956333002812/1532308571126235246)

VYRUS · 2026-07-30

> Right now our station jingles and the DJ's spoken links don't coordinate. Liquidsoap decides on its own when a jingle plays, with no heads up to the controller. The…

**🟡 Partly covered** — The collision guard shipped — jingle-playing.json holds spoken segments, and station IDs no longer talk over the DJ (#997, #1258, #1468). Giving the controller advance notice so it can plan around a jingle is still not tracked.

Refs: [#997](https://github.com/perminder-klair/subwave/issues/997) · [#1258](https://github.com/perminder-klair/subwave/issues/1258) · [#1468](https://github.com/perminder-klair/subwave/issues/1468)

### [Produced Episode Settings](https://discord.com/channels/1514647956333002812/1532126653067694172)

Mrain1 · 2026-07-29

> Hey throwing some ideas out there for the future on Programming settings. Not sure if all make sense or fit directionally but think they can help for some users who…

**🟡 Partly covered** — Scheduled programmes shipped (#557). The rest of the wishlist in this thread has no issue.

Refs: [#557](https://github.com/perminder-klair/subwave/issues/557)

### [Beds Per-Show/Persona](https://discord.com/channels/1514647956333002812/1530758168098115604)

Gurthyy · 2026-07-26

> Since we now have the ability to set beds, can the beds be set to specific channels/personas? that way, I could ahve different vibe beds for different channels to…

**🔨 Tracked** — Open issue for per-persona / per-show bed overrides.

Refs: [#1188](https://github.com/perminder-klair/subwave/issues/1188) *(open)*

### [Be able to assign skill durring its creation](https://discord.com/channels/1514647956333002812/1530780746162372768)

Mrain1 · 2026-07-26

> When you create a new skill you are not able to assign it to dj's from the creation screen. it could streamline the process if you are able to assign it to specific…

**⬜ No issue** — Nothing on GitHub.

### [Tap to tune in](https://discord.com/channels/1514647956333002812/1530029044240748696)

Sparks · 2026-07-24

> Have an option to turn this “on” or “off” so that the steam will automatically start playing when the webpage loads.

**✅ Shipped** — Shipped as the optional tune-in overlay toggle (#1036).

Refs: [#1036](https://github.com/perminder-klair/subwave/issues/1036)

### [Skills enhancement suggestions: trigger cohost banter](https://discord.com/channels/1514647956333002812/1529983567461875723)

Mrain1 · 2026-07-23

> Would be cool to have a skill option to trigger/toggle whether a skill either sometimes or always trigger an interaction with a cohost. For instance if toggled to…

**🔨 Tracked** — #1400 is the open issue for aiming banter with a skill. Multi-persona co-hosted skills shipped in #1524.

Refs: [#1400](https://github.com/perminder-klair/subwave/issues/1400) *(open)* · [#1524](https://github.com/perminder-klair/subwave/issues/1524)

### [Mobile admin page access](https://discord.com/channels/1514647956333002812/1529977487768027329)

Mrain1 · 2026-07-23

> Sometimes I want to tweak something quickly or skip a song, etc and instead of going to the web page for my station in a browser the progressive web app and official…

**⬜ No issue** — No issue for admin in the PWA.

### [Backup DB/Settings on Schedule](https://discord.com/channels/1514647956333002812/1529223933356937369)

Gurthyy · 2026-07-21

> Any way for us to set up regular backups for the DB? I know the UI has a path for doing it manually, but if we could pick daily/weekly/monthly and keep x copies of…

**⬜ No issue** — Backup bugs have been fixed (#612, #917, #1351) but scheduled/rotating backups have no issue.

Refs: [#612](https://github.com/perminder-klair/subwave/issues/612) · [#917](https://github.com/perminder-klair/subwave/issues/917) · [#1351](https://github.com/perminder-klair/subwave/issues/1351)

### [Settings Search](https://discord.com/channels/1514647956333002812/1529175110735495248)

Gurthyy · 2026-07-21

> We have a decent amount of settings across different pages and sometimes I can't remember where they actually live (ADHD is a crazy thing) - was thinking if we had a…

**⬜ No issue** — Nothing on GitHub.

### [Library page for easier search](https://discord.com/channels/1514647956333002812/1529142122589196481)

Mrain1 · 2026-07-21

> Make it easier to find the right song either by filtering by artist, making it easier by sorting the listed items by name. If you have a large library even if you put…

**🟡 Partly covered** — The library page was rebuilt on TanStack Query with server-side filtering (#1363). The specific artist-filter/name-sort ask is not separately tracked; #1236 covers a searchable picker for listener requests.

Refs: [#1363](https://github.com/perminder-klair/subwave/issues/1363) · [#1236](https://github.com/perminder-klair/subwave/issues/1236) *(open)*

### [Apple TV app](https://discord.com/channels/1514647956333002812/1522219585313701928)

Calvin3ztt · 2026-07-02

> Would love to see the iOS app ported to Apple TV so I could tune in during family game night or get togethers.

**⬜ No issue** — No issue. The Apple Watch companion (#1488) is open; tvOS is not.

Refs: [#1488](https://github.com/perminder-klair/subwave/issues/1488) *(open)*

## Untagged (20)

### [Full album show and special artist show](https://discord.com/channels/1514647956333002812/1545685340487024681)

elysium · 2026-09-05

> Hello I'd like to create two shows: a show that plays an entire album chosen by the DJ a show that plays tracks by a single artist chosen by the DJ. The bot tells me…

**🟡 Partly covered** — Single-artist shows already work through playlist-anchored shows (#701, tightened by #1533). Album-as-a-block is FR 4 on the tracker and still unstarted.

Refs: [#1485](https://github.com/perminder-klair/subwave/issues/1485) *(open)* · [#701](https://github.com/perminder-klair/subwave/issues/701) · [#1533](https://github.com/perminder-klair/subwave/issues/1533)

### [Add a toggle to the official Android app for hiding composer metadata](https://discord.com/channels/1514647956333002812/1545613469238435900)

Lyspaere · 2026-09-05

> I noticed something that is irking my neurotic mindset. Instead of displaying the Album Artist and say Artist, it displays Composer data. I may be singular in my…

**⬜ No issue** — Nothing on GitHub. Composer-vs-album-artist display in the app is untracked.

### [Show handover timing/interaction](https://discord.com/channels/1514647956333002812/1544364265060704298)

Marcel · 2026-09-01

> Currently, when one host hands over to the next, that happens about 5 minutes before the show ends. The incoming host speaks immediately after the outgoing host…

**⬜ No issue** — No issue. Jaz666 said in #general (2026-09-03) they are splitting handover-timing work into PRs.

### [Lyric support](https://discord.com/channels/1514647956333002812/1542233745703182457)

Gurthyy · 2026-08-26

> I had mentioned this in a now-archived thread about skins, but figured I’d surface it as a thread. Looking for lyric support for Subwave, so that both timed and…

**🔨 Tracked** — Open issue for lyrics display.

Refs: [#1167](https://github.com/perminder-klair/subwave/issues/1167) *(open)*

### [Platter should really be a 45](https://discord.com/channels/1514647956333002812/1541420557306691645)

BrentNorrisKY · 2026-08-24

> Since it is just a single shouldn't it be a 45 not an lp?

**⬜ No issue** — Skin artwork detail, nothing on GitHub.

### [more granular than "eras"](https://discord.com/channels/1514647956333002812/1536356905742631003)

PwrBlackout · 2026-08-10

> i have a "new music monday" show that i want to only play 2026 music. the API already allows me to manually pass in "fromYear" and "toYear", the UI even shows that…

**🟡 Partly covered** — Era resolution itself was fixed (#842, #1418). Exposing the API's fromYear/toYear as a show-level UI control is not tracked.

Refs: [#842](https://github.com/perminder-klair/subwave/issues/842) · [#1418](https://github.com/perminder-klair/subwave/issues/1418)

### [Skill-blocks, triggered at a specific time](https://discord.com/channels/1514647956333002812/1536054559045062866)

webwurm · 2026-08-09

> I would like to send news/weather/traffic every hour. The perfect would be to group skills together, and inbetween I can trigger e. g. a soundfile - so I have 1st…

**🟡 Partly covered** — Per-skill cron timers shipped (#1379). Grouping several skills into one block with an interstitial sound file is not tracked; #1429 covers scheduled playback of an external audio file.

Refs: [#1379](https://github.com/perminder-klair/subwave/issues/1379) · [#1429](https://github.com/perminder-klair/subwave/issues/1429) *(open)*

### [Shows and personas sorting](https://discord.com/channels/1514647956333002812/1535671834522030080)

shinjuku70 · 2026-08-08

> This project is so awesome that I now have 11 DJs and 44 distinct shows And of course I’m continuously tweaking them… so it would be helpful to be able to choose…

**⬜ No issue** — Nothing on GitHub for sorting/filtering large show and persona rosters.

### [Dead Air detection](https://discord.com/channels/1514647956333002812/1535268944930406410)

K8-Bit · 2026-08-07

> Would be good to have silence/dead-air detection for tracks that have long silence-gaps at the start or finish, and cut away appropriately.

**✅ Shipped** — Delivered as silenceTrim — liq_cue_in/liq_cue_out against an absolute floor (#1470, corrected in a follow-up). Settings live under silenceTrim.*.

Refs: [#1470](https://github.com/perminder-klair/subwave/issues/1470)

### [Unique Listener Profiles](https://discord.com/channels/1514647956333002812/1535427441055502399)

Gurthyy · 2026-08-07

> This would be a long term thinga nd might not even be something anyone is interested in - but I think it'd be pretty neat if as the next itteration of authenticated…

**⬜ No issue** — No issue. Listener identity beyond the beacon has never been scoped.

### [Mood->Speech->Corrections added Feature](https://discord.com/channels/1514647956333002812/1535374779459313664)

Drachenhort · 2026-08-07

> Wouldnt it be great to be able to test the correctional Speech Output without having to wait for the Persona to speak. I think that would be nice especially for…

**⬜ No issue** — Voice preview from the persona page exists (#151), but previewing the *correction* pipeline output does not.

Refs: [#151](https://github.com/perminder-klair/subwave/issues/151)

### [Adding multiple languages to all platforms](https://discord.com/channels/1514647956333002812/1534871903737614336)

Фикс · 2026-08-06

> You can add multiple languages besides English to mobile, desktop, and web apps. (To avoid having to translate everything themselves, the developer can create a…

**🟡 Partly covered** — #1381 covers better non-English TTS plus a French UI translation. Localising the mobile and desktop apps is not covered by it.

Refs: [#1381](https://github.com/perminder-klair/subwave/issues/1381) *(open)* · [#349](https://github.com/perminder-klair/subwave/issues/349)

### [Pass Time Callout to LLM](https://discord.com/channels/1514647956333002812/1534429009717235816)

Gurthyy · 2026-08-05

> So over in ⁠ask-the-bot, @PwrBlackout was asking the bot about the 'Just gone 6pm' type callout that always seems to sound exactly the same, and the bot said: > It's…

**🟡 Partly covered** — The clock's accuracy was fixed repeatedly (#1282, #1314, #1286, #1380). Handing the phrasing to the LLM so it stops sounding identical has no issue.

Refs: [#1282](https://github.com/perminder-klair/subwave/issues/1282) · [#1314](https://github.com/perminder-klair/subwave/issues/1314) · [#1286](https://github.com/perminder-klair/subwave/issues/1286) · [#1380](https://github.com/perminder-klair/subwave/issues/1380)

### [SUB/WAVE Windows Desktop bugs:](https://discord.com/channels/1514647956333002812/1534147745806286879)

Solo_mag · 2026-08-04

> Application icon is not displayed. (first screenshoot) Minimize, maximize, and close buttons flicker. (Video) The top part of the application changes color when…

**⬜ No issue** — No issue. The macOS equivalent (#1537, URL not persisting) is open; the Windows chrome bugs are untracked.

Refs: [#1537](https://github.com/perminder-klair/subwave/issues/1537) *(open)*

### [Can we put a block/heart option on the play history?](https://discord.com/channels/1514647956333002812/1534332709961338890)

BrentNorrisKY · 2026-08-04

> Would make it really easy to go back and mark stuff.

**🟡 Partly covered** — Hearts (#991) and a durable History tab (#1065) both shipped; putting the block/heart controls on the history rows is not tracked.

Refs: [#991](https://github.com/perminder-klair/subwave/issues/991) · [#1065](https://github.com/perminder-klair/subwave/issues/1065)

### [Expose sounds-like search via API/MCP](https://discord.com/channels/1514647956333002812/1533731289167826964)

Mrain1 · 2026-08-03

> Building a call-in agent against the HTTP API and it's working great. Two small asks: Sounds-like search isn't reachable from outside. The admin library has the…

**⬜ No issue** — No issue. Sounds-like search stays admin-only.

### [Takeover Current Show Option](https://discord.com/channels/1514647956333002812/1533571088741699667)

Gurthyy · 2026-08-02

> We have an option to force a takeover for a new show and set how long it will override - can we have an option w/ that that will just set the takeover to end when the…

**🟡 Partly covered** — The dashboard show pin shipped (#930, #1507, #1543) but pins for a fixed number of hours. Ending the takeover when the schedule would have changed anyway is not tracked.

Refs: [#930](https://github.com/perminder-klair/subwave/issues/930) · [#1507](https://github.com/perminder-klair/subwave/issues/1507) · [#1543](https://github.com/perminder-klair/subwave/issues/1543)

### [Skills only fire between songs](https://discord.com/channels/1514647956333002812/1532786327030861974)

PwrBlackout · 2026-07-31

> Skills are great, add an option to make them only fire in between songs, talking over the middle of a song is annoying.

**✅ Shipped** — Shipped as the "talk only between tracks" scheduling constraint, FR 5b on the tracker (#1562).

Refs: [#1562](https://github.com/perminder-klair/subwave/issues/1562) · [#1485](https://github.com/perminder-klair/subwave/issues/1485) *(open)*

### [Sharing DJs/Stations/etc](https://discord.com/channels/1514647956333002812/1532786180947710083)

PwrBlackout · 2026-07-31

> there should be a way to share and import a dj/station in a single file that includes the souls, audio files, etc. maybe a "share" button that downloads a zip file…

**🟡 Partly covered** — The community browser covers install-from-community. A portable export/import bundle is FR 11 (programmatic persona import) on the tracker, still open.

Refs: [#1485](https://github.com/perminder-klair/subwave/issues/1485) *(open)*

### [Optional external broadcast processor on the bus (StereoTool / full DSP chain via Liquidsoap)](https://discord.com/channels/1514647956333002812/1521452105989361785)

Tim Stans · 2026-06-30

> Right now the master bus is just a brick-wall limiter and per-track gain is capped at ±6 dB. That preserves the masters, a fair default, but there's no way to do real…

**⬜ No issue** — Nothing on GitHub. Related to the loudness-cap thread below.

---

References marked *(open)* are still open on GitHub; the rest are closed.
