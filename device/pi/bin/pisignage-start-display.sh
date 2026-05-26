#!/usr/bin/env bash
set -euo pipefail

export DISPLAY="${DISPLAY:-:0}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=${XDG_RUNTIME_DIR}/bus}"

readonly player_url="${PISIGNAGE_PLAYER_URL:-http://localhost:5173/}"
readonly chromium_binary="${PISIGNAGE_CHROMIUM_BIN:-/usr/bin/chromium}"
readonly display_mode="${PISIGNAGE_DISPLAY_MODE:-operator}"

for _ in {1..60}; do
  if /usr/bin/curl -fsS "${player_url}" >/dev/null; then
    break
  fi
  sleep 1
done

case "${display_mode}" in
  operator)
    browser_mode_arguments=(--start-maximized)
    ;;
  kiosk)
    browser_mode_arguments=(--kiosk --start-fullscreen)
    ;;
  *)
    printf "Unsupported PISIGNAGE_DISPLAY_MODE: %s\n" "${display_mode}" >&2
    exit 2
    ;;
esac

exec "${chromium_binary}" \
  "${browser_mode_arguments[@]}" \
  --no-first-run \
  --no-default-browser-check \
  --disable-infobars \
  --autoplay-policy=no-user-gesture-required \
  "${player_url}"
