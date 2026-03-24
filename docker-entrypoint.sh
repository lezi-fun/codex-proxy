#!/bin/sh
set -e

# Seed empty config bind mount with defaults from the image
if [ -d /defaults ] && [ -z "$(ls -A /app/config 2>/dev/null)" ]; then
  echo "[Init] Config directory is empty — seeding from image defaults"
  cp -r /defaults/* /app/config/
fi

# Ensure mounted volumes are writable by the node user (UID 1000).
# When Docker auto-creates bind-mount directories on the host,
# they default to root:root — the node user can't write to them.
chown -R node:node /app/data /app/config 2>/dev/null || true

exec gosu node "$@"
