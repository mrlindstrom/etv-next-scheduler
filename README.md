# etv-next-scheduler

A scheduler and web UI for [ErsatzTV next](https://github.com/ErsatzTV/next). Next
streams channels from playout files you give it; this app builds those playouts
from your media library, along with the TV guide, and runs next for you.

> **Early testing.** It runs 24/7 on the author's server, but it hasn't been used
> much anywhere else yet. Expect rough edges, and please report them.

## What it does

- **Media library**: Plex, Jellyfin and Emby servers, plus local folders. It can
  also import an existing ErsatzTV (legacy) database and its channels.
- **Overlays**: a drag-and-drop designer for watermarks, lower thirds and "up next"
  straps, with show details (title, episode, times, what's next), pictures
  picked by the show (a folder of show logos: `Rugrats.png` appears when Rugrats
  is next), and timing
  (always, every few minutes, or at a set point in each show).
- **Ways to schedule a channel**: a block schedule, a weekly grid, commercial-break
  pods, movie channels, legacy-style YAML, a time-shifted copy of another channel,
  or a relay of a live IPTV stream.
- **The TV feel**: mid-roll breaks at chapter marks, padding to the half hour,
  era-matched commercials, station IDs, dayparts and holiday blocks, "up next"
  cards with themes, and a scrolling guide channel.
- **Runs ErsatzTV next for you**: installs and updates next and ErsatzTV's ffmpeg
  from GitHub, writes its lineup and channel configs, and keeps it running.
- **Plex Live TV & DVR**: acts as an HDHomeRun tuner, so Plex can watch and record
  your channels, with the guide included.
- **Troubleshooting**: watch any channel in the browser, test plays, and check
  your hardware encoder.

## Install

You need [Node.js](https://nodejs.org) 22.5 or newer (24 recommended) and
[git](https://git-scm.com). It's developed on Windows; Linux and macOS should
work but have had less testing.

```bash
git clone https://github.com/mrlindstrom/etv-next-scheduler.git
cd etv-next-scheduler
npm install
npm --prefix web install
npm run build:all
npm run server
```

Then open **http://localhost:8730**. From now on, start it with `npm run server`.

## First run

1. **Settings**: check the time zone.
2. **Streaming → Programs → Update both** downloads ErsatzTV next and ffmpeg into
   `bin/`.
3. **Library**: add your Plex, Jellyfin or Emby server, or a local folder, and
   scan it. (Coming from ErsatzTV legacy? Point Settings at its database and
   import the library and channels instead.)
4. **Channels → + New**: make a channel and pick how it's scheduled.
5. **Build** fills the channel's schedule a few days ahead. Turn on auto-build to
   keep it topped up.
6. **Streaming**: turn on **Keep ErsatzTV next running**, then
   **Troubleshooting → Watch live** to see your channel.

To watch in Plex, Jellyfin, Channels DVR or an IPTV app, add next's playlist and
guide (next listens on port 8409 by default):

- M3U: `http://<this computer>:8409/channels.m3u`
- XMLTV: `http://<this computer>:8409/xmltv.xml`

The Dashboard lists anything that still needs setting up.

## Updating

**Settings → Scheduler updates** pulls the latest version from this repo, builds
it next to the running one, and restarts into it. It can also do this by itself
once a day at a quiet hour. ErsatzTV next and ffmpeg update separately, from
**Streaming → Programs**.

## Your data

Everything you set up stays in folders git ignores: `data/` (settings and the
library index), `channels/` (channel configs), `runtime/` (playouts, guide data,
logos) and `bin/`. Updates never touch them. Back up `data/` and `channels/`.

## More

- [Dayparting](docs/DAYPARTING.md): different programming by day and time.
- [`examples/channels/`](examples/channels): example YAML channels.
- Questions and bug reports: [open an issue](https://github.com/mrlindstrom/etv-next-scheduler/issues), or find us in the ErsatzTV Discord.

## License

[zlib](LICENSE). Not affiliated with the ErsatzTV project.
