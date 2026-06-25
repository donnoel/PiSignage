#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  pisignage-reset-device.sh [--repo-root PATH] [--source git-head|current] [--agent-safe] [--dry-run|--apply]

Restores a Beam Pi appliance to the repo-backed first-run state while preserving
device identity, network settings, SSH access, hostname, and OS users.

Options:
  --repo-root PATH   PiSignage repo path on this Pi. Default: detected repo root.
  --source MODE      Reset source for playlist/assets. Default: git-head.
                     Use current after a controller has staged files into repo.
  --agent-safe       Do not stop/restart the device-agent service while the
                     agent is running this reset and still needs to report back.
  --dry-run          Show planned reset work without changing files. Default.
  --apply            Perform the reset.
  --help             Show this help.
USAGE
}

die() {
  echo "error: $*" >&2
  exit 1
}

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/../../.." && pwd)"
mode="dry-run"
source_mode="git-head"
agent_safe="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-root)
      repo_root="${2:-}"
      shift 2
      ;;
    --dry-run)
      mode="dry-run"
      shift
      ;;
    --source)
      source_mode="${2:-}"
      shift 2
      ;;
    --apply)
      mode="apply"
      shift
      ;;
    --agent-safe)
      agent_safe="true"
      shift
      ;;
    --help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

repo_root="$(cd -- "$repo_root" && pwd)"
[[ -f "${repo_root}/sample-content/playlist.local.json" ]] || die "--repo-root does not look like PiSignage: ${repo_root}"
[[ -d "${repo_root}/device/pi/bin" ]] || die "--repo-root is missing device/pi/bin: ${repo_root}"
[[ "$source_mode" == "git-head" || "$source_mode" == "current" ]] || die "--source must be git-head or current"

playlist_path="${repo_root}/sample-content/playlist.local.json"
assets_dir="${repo_root}/sample-content/assets"
schedules_path="${repo_root}/sample-content/schedules.local.json"
systemd_user_dir="${HOME}/.config/systemd/user"
local_bin_dir="${HOME}/.local/bin"
state_dir="${HOME}/.local/state/pisignage"
agent_cache_dir="${HOME}/.local/cache/pisignage/device-agent"
config_dir="${HOME}/.config/pisignage"

managed_bin_sources=(
  "device/pi/bin/pisignage-call-home-now.sh"
  "device/pi/bin/pisignage-configure-wifi.sh"
  "device/pi/bin/pisignage-enforce-schedule.mjs"
  "device/pi/bin/pisignage-serve-player.mjs"
  "device/pi/bin/pisignage-start-display.sh"
  "device/pi/bin/pisignage-vlc-playlist.mjs"
)

managed_unit_sources=(
  "device/pi/systemd/user/pisignage-device-agent.service"
  "device/pi/systemd/user/pisignage-kiosk.service"
  "device/pi/systemd/user/pisignage-player.service"
  "device/pi/systemd/user/pisignage-schedule.service"
  "device/pi/systemd/user/pisignage-schedule.timer"
  "device/pi/systemd/user/pisignage-vlc.service"
)

print_step() {
  echo "reset: $*"
}

apply_or_print() {
  if [[ "$mode" == "apply" ]]; then
    "$@"
  else
    printf 'dry-run:'
    printf ' %q' "$@"
    printf '\n'
  fi
}

service_exists() {
  systemctl --user list-unit-files "$1" --no-legend 2>/dev/null | grep -q "^$1"
}

restore_tracked_file() {
  local relative_path="$1"
  local target_path="${repo_root}/${relative_path}"
  local target_dir
  target_dir="$(dirname -- "$target_path")"

  if [[ "$source_mode" == "current" ]]; then
    [[ -f "$target_path" ]] || die "required reset file is missing: ${relative_path}"
    print_step "using staged current file for ${relative_path}"
    return
  fi

  if ! git -C "$repo_root" cat-file -e "HEAD:${relative_path}" 2>/dev/null; then
    [[ -f "$target_path" ]] || die "required reset file is missing: ${relative_path}"
    print_step "using current file because ${relative_path} is not tracked in git"
    return
  fi

  if [[ "$mode" == "apply" ]]; then
    mkdir -p "$target_dir"
    local tmp_path
    tmp_path="$(mktemp "${target_path}.XXXXXX")"
    git -C "$repo_root" show "HEAD:${relative_path}" > "$tmp_path"
    mv "$tmp_path" "$target_path"
  else
    echo "dry-run: git -C ${repo_root} show HEAD:${relative_path} > ${target_path}"
  fi
}

read_playlist_assets() {
  node - "$playlist_path" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const playlistPath = process.argv[2];
const playlist = JSON.parse(fs.readFileSync(playlistPath, "utf8"));
if (!Array.isArray(playlist.assets)) {
  throw new Error("playlist assets must be an array");
}
for (const asset of playlist.assets) {
  if (!asset || typeof asset.uri !== "string" || !asset.uri.startsWith("assets/")) {
    continue;
  }
  const normalized = path.posix.normalize(asset.uri);
  if (path.posix.isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`unsafe asset uri: ${asset.uri}`);
  }
  console.log(normalized);
}
NODE
}

echo "Beam Pi reset"
echo "  repo root: ${repo_root}"
echo "  mode: ${mode}"
echo "  source: ${source_mode}"
echo "  agent safe: ${agent_safe}"
echo "  preserves: ${config_dir}, hostname, network, SSH, OS users"
echo "  clears: playlist publish state, stale media, schedules, player status, heartbeat, device-agent cache"

print_step "checking required tracked files"
for source in "${managed_bin_sources[@]}" "${managed_unit_sources[@]}" "sample-content/playlist.local.json"; do
  [[ -f "${repo_root}/${source}" ]] || die "missing required reset source: ${source}"
done

if [[ -f "${config_dir}/device.json" ]]; then
  print_step "preserving device identity at ${config_dir}/device.json"
else
  print_step "device identity file is not present; reset will not create one"
fi

print_step "stopping managed services"
for unit in pisignage-schedule.timer pisignage-schedule.service pisignage-kiosk.service pisignage-player.service pisignage-vlc.service pisignage-device-agent.service; do
  if [[ "$agent_safe" == "true" && "$unit" == "pisignage-device-agent.service" ]]; then
    print_step "leaving ${unit} running for cloud reset reporting"
    continue
  fi
  if service_exists "$unit"; then
    apply_or_print systemctl --user stop "$unit"
  fi
done

print_step "restoring first-run playlist"
restore_tracked_file "sample-content/playlist.local.json"

playlist_assets="$(read_playlist_assets)"
playlist_asset_count="$(printf '%s\n' "$playlist_assets" | sed '/^$/d' | wc -l | tr -d ' ')"
print_step "restoring ${playlist_asset_count} playlist asset(s)"
apply_or_print mkdir -p "$assets_dir"
while IFS= read -r asset; do
  [[ -n "$asset" ]] || continue
  restore_tracked_file "sample-content/${asset}"
done <<< "$playlist_assets"

print_step "pruning stale published media"
if [[ "$mode" == "apply" ]]; then
  expected_list="$(mktemp)"
  while IFS= read -r asset; do
    [[ -n "$asset" ]] || continue
    printf '%s\n' "${assets_dir}/$(basename -- "$asset")" >> "$expected_list"
  done <<< "$playlist_assets"
  if [[ -d "$assets_dir" ]]; then
    while IFS= read -r -d '' file_path; do
      if ! grep -Fxq "$file_path" "$expected_list"; then
        rm -f -- "$file_path"
      fi
    done < <(find "$assets_dir" -maxdepth 1 -type f -print0)
  fi
  rm -f "$expected_list"
else
  echo "dry-run: remove files in ${assets_dir} except playlist-referenced assets"
fi

print_step "clearing schedules, runtime status, and agent cache"
apply_or_print rm -f "$schedules_path"
apply_or_print rm -rf "$state_dir"
apply_or_print rm -rf "$agent_cache_dir"
apply_or_print mkdir -p "$state_dir"

print_step "reinstalling managed scripts"
apply_or_print mkdir -p "$local_bin_dir"
for source in "${managed_bin_sources[@]}"; do
  apply_or_print install -m 755 "${repo_root}/${source}" "${local_bin_dir}/$(basename -- "$source")"
done

print_step "reinstalling managed user services"
apply_or_print mkdir -p "$systemd_user_dir"
for source in "${managed_unit_sources[@]}"; do
  apply_or_print install -m 644 "${repo_root}/${source}" "${systemd_user_dir}/$(basename -- "$source")"
done

print_step "reloading and enabling field services"
apply_or_print systemctl --user daemon-reload
apply_or_print systemctl --user disable --now pisignage-kiosk.service
apply_or_print systemctl --user disable --now pisignage-player.service
apply_or_print systemctl --user enable --now pisignage-vlc.service
apply_or_print systemctl --user enable --now pisignage-schedule.timer
if [[ -f "${repo_root}/device-agent/dist/index.js" ]]; then
  if [[ "$agent_safe" == "true" ]]; then
    apply_or_print systemctl --user enable pisignage-device-agent.service
  else
    apply_or_print systemctl --user enable --now pisignage-device-agent.service
  fi
else
  print_step "device-agent dist not present; leaving device-agent service disabled"
fi

print_step "collecting reset evidence"
if [[ "$mode" == "apply" ]]; then
  playlist_sha="$(sha256sum "$playlist_path" | awk '{print $1}')"
  asset_count="$(find "$assets_dir" -maxdepth 1 -type f 2>/dev/null | wc -l | tr -d ' ')"
  vlc_state="$(systemctl --user is-active pisignage-vlc.service 2>/dev/null || true)"
  agent_state="$(systemctl --user is-active pisignage-device-agent.service 2>/dev/null || true)"
  timer_state="$(systemctl --user is-active pisignage-schedule.timer 2>/dev/null || true)"
  echo "reset-complete"
  echo "playlist_sha=${playlist_sha}"
  echo "asset_count=${asset_count}"
  echo "vlc_service=${vlc_state}"
  echo "device_agent_service=${agent_state:-unknown}"
  echo "schedule_timer=${timer_state:-unknown}"
else
  echo "Dry run only; no files changed."
fi
