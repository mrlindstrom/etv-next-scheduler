# Running in Docker

The image runs the scheduler and its web UI. Everything you set up is kept in
one folder, mounted at `/config`: settings, the library, channels, playouts, the
guide, and the ErsatzTV next and ffmpeg builds it downloads. You can recreate or
update the container without losing anything.

## Quick start (Docker Compose)

```bash
git clone https://github.com/mrlindstrom/etv-next-scheduler.git
cd etv-next-scheduler
cp docker-compose.example.yml docker-compose.yml
# edit docker-compose.yml: your time zone and your media folder
docker compose up -d --build
```

Open **http://\<this computer\>:8730** and follow **First run** in the README.
**Streaming → Programs → Update both** downloads the Linux builds of ErsatzTV
next and ffmpeg into `/config/bin`, where they stay across container updates.

Without Compose:

```bash
docker build -t tv-next-scheduler .
docker run -d --name tv-next-scheduler --network host \
  -e TZ=America/New_York \
  -v "$PWD/config:/config" -v /path/to/media:/media:ro \
  tv-next-scheduler
```

## What goes where

| In the container | What it is |
| --- | --- |
| `/config/data` | settings (`app.sqlite`), the library and its search index |
| `/config/channels` | channel configs |
| `/config/runtime` | ErsatzTV next's lineup, playouts, guide, overlays and logs |
| `/config/bin` | ErsatzTV next and ffmpeg (downloaded from the Streaming page) |
| `/media` (your choice) | your media, read-only is fine |

Library folders are added in the web UI by their **container** path (for
example `/media/TV`). If your media comes from Plex, Jellyfin or Emby, mount it
at the same path that server uses, so the file paths it reports work here too;
otherwise add a path replacement on the source (**Library → Sources**).

Coming from ErsatzTV legacy? Mount its database (for example
`-v /path/to/ersatztv.sqlite3:/legacy/ersatztv.sqlite3:ro`) and point
**Settings** at `/legacy/ersatztv.sqlite3` to import it.

## Settings

| Variable | Default | |
| --- | --- | --- |
| `TZ` | `Etc/UTC` | time zone for schedules and the guide (Settings can override it) |
| `PORT` | `8730` | the web UI's port |
| `PUBLIC_URL` | (detected) | the address other devices reach the scheduler at, e.g. `http://192.168.1.20:8730`; used for channel logos and guide images. Needed without host networking. The address set on the Streaming page wins over this. |

## Ports

- **8730**: web UI and API
- **8409**: ErsatzTV next: `channels.m3u`, `xmltv.xml` and the streams (set on the Streaming page)
- **5004**: the HDHomeRun tuner for Plex, when it's turned on under Streaming

With `network_mode: host` (Linux) nothing needs mapping, Plex discovers the
tuner by itself, and the scheduler knows your computer's real address. With
bridge networking (Docker Desktop on Windows/macOS) map the ports, set
`PUBLIC_URL`, and add the tuner to Plex by address
(`http://<this computer>:5004`).

## GPU encoding

The image includes the VA-API drivers for Intel (Quick Sync) and AMD GPUs on
x64. Pass the GPU through, then pick the encoder on the Streaming page and check
it with **Troubleshooting → Hardware encoders**:

- **NVIDIA** (NVENC): use the `deploy` block in `docker-compose.example.yml`, or
  `docker run --gpus all`. On Linux this needs the NVIDIA Container Toolkit.
  Docker Desktop on Windows passes NVIDIA GPUs through as is (WSL 2 backend, a
  current NVIDIA driver). The image already asks for the encoder libraries, so
  nothing else is needed.
- **Intel / AMD** (Quick Sync, VA-API): Linux hosts only, with
  `devices: ["/dev/dri:/dev/dri"]`. If the container doesn't run as root, also
  add the host's `render` group (`group_add`). Docker Desktop on Windows and
  macOS can't pass these GPUs through, so use NVIDIA or software encoding there.

Building with `--build-arg HWACCEL=false` leaves the drivers out for a smaller image.

## Running as another user

The container runs as root by default. To have files in `/config` owned by you,
add `user: "1000:1000"` (your `id -u`:`id -g`) and make sure that user can
write to the config folder.

## Updating

Settings → Scheduler updates is turned off in Docker. Update the image instead:

```bash
git pull
docker compose up -d --build
```

ErsatzTV next and ffmpeg still update from **Streaming → Programs**.
