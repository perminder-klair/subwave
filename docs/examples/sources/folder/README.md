# Music folder — an example source plugin

Plays audio files straight from a folder, with no music server. It is the worked example for [`docs/music-source-plugins.md`](../../../music-source-plugins.md): one dependency-free ES module, about 200 lines.

## Layout it reads

```
/music/
  Artist/
    Album/
      01 Song title.flac
      02 Another.mp3
      cover.jpg
```

Artist and album come from the folder names, track number and title from the file name. No tags are read, so there are no genres or years, and durations are measured by the station's analyzer rather than reported up front.

## Install

1. Copy this folder to `state/router/plugins/folder/`.
2. Mount your music into the router container, read-only — in `docker-compose.yml`, under the `router` service:

   ```yaml
   volumes:
     - ${STATE_DIR:-./state}/router:/var/sub-wave-router
     - /path/to/your/music:/music:ro
   ```

   then `docker compose up -d router`.
3. Admin → Music sources → Plugins → **Rescan plugins**, then on the Sources tab pick **Music folder** (as the source, or added beside Navidrome), set *Folder* to `/music`, **Test connection**, save.

## Check it

```bash
npm --prefix router run conformance -- docs/examples/sources/folder --config path=/path/to/your/music
```

The router's own test suite runs exactly this against a generated folder.
