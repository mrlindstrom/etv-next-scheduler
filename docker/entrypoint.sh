#!/bin/sh
# Makes the /config folders the server expects (the /app/<name> links point at
# them), then starts the server. Runs as whatever user the container runs as.
set -e
for d in data channels runtime bin playouts; do
  mkdir -p "/config/$d" || { echo "can't create /config/$d: check the /config volume's owner (or the container's user:)" >&2; exit 1; }
done
# where ErsatzTV's (static) ffmpeg finds the VA-API drivers the image installs
[ -n "$LIBVA_DRIVERS_PATH" ] || export LIBVA_DRIVERS_PATH="/usr/lib/$(uname -m)-linux-gnu/dri"
cd /app
exec "$@"
