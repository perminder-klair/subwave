# Discord reply drafts

Short replies for the 18 #suggestions threads that are either already delivered or already tracked on GitHub. Copy, paste, post. Status reasoning for all 65 open threads is in [`discord-open-suggestions.md`](discord-open-suggestions.md).

## Shipped, safe to close (6)

Reply, then mark the thread `✅ Implemented` and close it.

### [Dead Air detection](https://discord.com/channels/1514647956333002812/1535268944930406410)

```
Good news, this one is already on air. Dead-air trim shipped in #1470. It gauges the edges against an absolute floor rather than the track's own loud level, so a quiet intro doesn't read as silence and get eaten. Controls are under silenceTrim in settings.
```

### [Skills only fire between songs](https://discord.com/channels/1514647956333002812/1532786327030861974)

```
Shipped. There is now a "talk only between tracks" switch, and it covers every scheduled segment rather than just skills: https://github.com/perminder-klair/subwave/pull/1562
```

### [Tap to tune in](https://discord.com/channels/1514647956333002812/1530029044240748696)

```
This landed a while back. The tune-in overlay is a toggle in the skin settings (#1036), turn it off and the stream starts with the page.
```

### [Enable calling of sound fx through the mcp/manual voice DJ](https://discord.com/channels/1514647956333002812/1522442941442953216)

```
Both halves of this are live now. MCP has subwave_list_sfx and subwave_play_sfx (#901), and manual jingles air at full level and any length (#1468), so your weather warning agent has a way in.
```

### [Show "Specials"](https://discord.com/channels/1514647956333002812/1520424657537335296)

```
This works today. Anchor the show to a Navidrome playlist and it plays only from that set (#701), and /admin/playlists will build the hand-picked list for you.
```

### [Release Notes](https://discord.com/channels/1514647956333002812/1524463064953655326)

```
Covered now. Releases carry generated notes, and the docs have an update procedure with a rollback path for a bad upgrade.
```

## Tracked on GitHub (12)

Reply with the link and leave the thread open, or close it if the reporter is happy following the issue.

### [Lyric support](https://discord.com/channels/1514647956333002812/1542233745703182457)

```
Tracked on GitHub as https://github.com/perminder-klair/subwave/issues/1167. Following there is the best way to catch it moving.
```

### [Block talking over requests or favorites](https://discord.com/channels/1514647956333002812/1541421789576560640)

```
The talking-over problem is tracked as https://github.com/perminder-klair/subwave/issues/551. Worth knowing that half of your ask already shipped: a listener request now gets front-padded with a bed instead of the DJ talking over the intro (#1465).
```

### [Force play longer audio files via an API](https://discord.com/channels/1514647956333002812/1534964810930847824)

```
There is an open proposal for exactly this, airing a pre-rendered clip on the voice channel with no length cap: https://github.com/perminder-klair/subwave/issues/1424. In the meantime manual jingles now play at any length (#1468).
```

### [Beds Per-Show/Persona](https://discord.com/channels/1514647956333002812/1530758168098115604)

```
Tracked as https://github.com/perminder-klair/subwave/issues/1188, per-persona and per-show bed overrides.
```

### [Skills enhancement suggestions: trigger cohost banter](https://discord.com/channels/1514647956333002812/1529983567461875723)

```
This is open on GitHub as https://github.com/perminder-klair/subwave/issues/1400, aiming banter with a skill. Multi-persona co-hosted skills already shipped in #1524 if that helps in the meantime.
```

### [world.md?](https://discord.com/channels/1514647956333002812/1527683829253279885)

```
Lovely idea, and it has a home: https://github.com/perminder-klair/subwave/issues/1401 covers recurring storylines and narrative context for the DJs. The decay side, so the callbacks don't collapse into the same few obsessions, was handled in #1479.
```

### [Album queue option](https://discord.com/channels/1514647956333002812/1526711910790332507)

```
Tracked as FR 4 on https://github.com/perminder-klair/subwave/issues/1485. It needs an explicit operator-block flag first, since a queued album is exactly what the pair-drain and artist guard exist to prevent.
```

### [Skills that trigger guest DJ Banter](https://discord.com/channels/1514647956333002812/1526186268063694928)

```
Same home as the other banter thread: https://github.com/perminder-klair/subwave/issues/1400.
```

### [Skin SDK + standalone skin kit](https://discord.com/channels/1514647956333002812/1525916662459666553)

```
Carried on https://github.com/perminder-klair/subwave/issues/1485 as the runtime-loadable skins item. Themes already load at runtime, skins are compile-time by design, and that issue is where the decision to change it lives.
```

### [Audiomuse AI integration](https://discord.com/channels/1514647956333002812/1524343336528379945)

```
Tracked as https://github.com/perminder-klair/subwave/issues/707.
```

### [Android Auto App](https://discord.com/channels/1514647956333002812/1522405176852611193)

```
Brilliant, thank you. Android Auto and CarPlay are tracked together as https://github.com/perminder-klair/subwave/issues/1486, which is about unblocking and shipping PR #1229.
```

### [Android Auto](https://discord.com/channels/1514647956333002812/1521090597824495687)

```
Tracked as https://github.com/perminder-klair/subwave/issues/1486, CarPlay and Android Auto together.
```

