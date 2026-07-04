#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  pisignage-reset-device.sh [--repo-root PATH] [--source golden-master|git-head|current] [--golden-remote NAME] [--golden-ref REF] [--agent-safe] [--defer-field-player-restart] [--dry-run|--apply]

Restores a Beam Pi appliance to the repo-backed first-run state while preserving
device identity, network settings, SSH access, hostname, and OS users.

Options:
  --repo-root PATH   PiSignage repo path on this Pi. Default: detected repo root.
  --source MODE      Reset source for managed files, playlist, and assets.
                     Default: golden-master.
                     golden-master fetches the configured remote/ref first.
                     git-head uses the local repo HEAD without fetching.
                     current uses files already staged into the local checkout.
  --golden-remote NAME
                     Git remote for --source golden-master. Default: github
                     when present, otherwise origin.
  --golden-ref REF   Git ref for --source golden-master. Default: main.
  --agent-safe       Do not stop/restart the device-agent service while the
                     agent is running this reset and still needs to report back.
  --defer-field-player-restart
                     Leave the visible field player running until an external
                     reboot. This avoids desktop/ready-page flashes during
                     cloud deployment reset.
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
source_mode="golden-master"
golden_remote="${PISIGNAGE_GOLDEN_REMOTE:-}"
golden_ref="${PISIGNAGE_GOLDEN_REF:-main}"
golden_tree=""
golden_commit=""
agent_safe="false"
defer_field_player_restart="false"

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
    --golden-remote)
      golden_remote="${2:-}"
      shift 2
      ;;
    --golden-ref)
      golden_ref="${2:-}"
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
    --defer-field-player-restart)
      defer_field_player_restart="true"
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
[[ "$source_mode" == "golden-master" || "$source_mode" == "git-head" || "$source_mode" == "current" ]] || die "--source must be golden-master, git-head, or current"

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
  "device/pi/bin/pisignage-hide-desktop.sh"
  "device/pi/bin/pisignage-install-runtime.sh"
  "device/pi/bin/pisignage-provision-device.sh"
  "device/pi/bin/pisignage-reset-device.sh"
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

required_asset_sources=(
  "device/pi/assets/ad-dad-logo.png"
  "device/pi/assets/ad-dad-logo.ppm"
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

resolve_golden_remote() {
  if [[ -n "$golden_remote" ]]; then
    return
  fi
  if git -C "$repo_root" remote get-url github >/dev/null 2>&1; then
    golden_remote="github"
    return
  fi
  if git -C "$repo_root" remote get-url origin >/dev/null 2>&1; then
    golden_remote="origin"
    return
  fi
  die "--source golden-master requires a github or origin git remote"
}

prepare_reset_source() {
  case "$source_mode" in
    current)
      return
      ;;
    git-head)
      golden_tree="HEAD"
      golden_commit="$(git -C "$repo_root" rev-parse HEAD)"
      return
      ;;
    golden-master)
      resolve_golden_remote
      print_step "fetching PI golden master from ${golden_remote}/${golden_ref}"
      git -C "$repo_root" fetch --quiet "$golden_remote" "$golden_ref"
      golden_tree="FETCH_HEAD"
      golden_commit="$(git -C "$repo_root" rev-parse FETCH_HEAD)"
      [[ -n "$golden_commit" ]] || die "could not resolve PI golden master commit from ${golden_remote}/${golden_ref}"
      return
      ;;
  esac
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

  if ! git -C "$repo_root" cat-file -e "${golden_tree}:${relative_path}" 2>/dev/null; then
    [[ -f "$target_path" ]] || die "required reset file is missing: ${relative_path}"
    print_step "using current file because ${relative_path} is not tracked in reset source"
    return
  fi

  if [[ "$mode" == "apply" ]]; then
    mkdir -p "$target_dir"
    local tmp_path
    tmp_path="$(mktemp "${target_path}.XXXXXX")"
    git -C "$repo_root" show "${golden_tree}:${relative_path}" > "$tmp_path"
    mv "$tmp_path" "$target_path"
  else
    echo "dry-run: git -C ${repo_root} show ${golden_tree}:${relative_path} > ${target_path}"
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
if [[ "$source_mode" == "golden-master" ]]; then
  echo "  golden ref: ${golden_ref}"
fi
echo "  agent safe: ${agent_safe}"
echo "  defer field player restart: ${defer_field_player_restart}"
echo "  preserves: ${config_dir}, hostname, network, SSH, OS users"
echo "  clears: playlist publish state, stale media, schedules, player status, heartbeat, device-agent cache"

prepare_reset_source
if [[ "$source_mode" != "current" ]]; then
  echo "  reset commit: ${golden_commit}"
fi

print_step "checking required tracked files"
for source in "${managed_bin_sources[@]}" "${managed_unit_sources[@]}" "${required_asset_sources[@]}" "sample-content/playlist.local.json"; do
  if [[ "$source_mode" == "current" ]]; then
    [[ -f "${repo_root}/${source}" ]] || die "missing required reset source: ${source}"
  else
    git -C "$repo_root" cat-file -e "${golden_tree}:${source}" 2>/dev/null || die "missing required reset source: ${source}"
  fi
done

if [[ -f "${config_dir}/device.json" ]]; then
  print_step "preserving device identity at ${config_dir}/device.json"
else
  print_step "device identity file is not present; reset will not create one"
fi

print_step "stopping managed services"
for unit in pisignage-schedule.timer pisignage-schedule.service pisignage-kiosk.service pisignage-player.service pisignage-vlc.service pisignage-device-agent.service; do
  if [[ "$defer_field_player_restart" == "true" && ( "$unit" == "pisignage-vlc.service" || "$unit" == "pisignage-player.service" || "$unit" == "pisignage-kiosk.service" ) ]]; then
    print_step "leaving ${unit} running until reboot"
    continue
  fi
  if [[ "$agent_safe" == "true" && "$unit" == "pisignage-device-agent.service" ]]; then
    print_step "leaving ${unit} running for cloud reset reporting"
    continue
  fi
  if service_exists "$unit"; then
    apply_or_print systemctl --user stop "$unit"
  fi
done

restore_first_run_media() {
  local playlist_assets
  local playlist_asset_count

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
    local expected_list
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
}

if [[ "$defer_field_player_restart" == "true" ]]; then
  print_step "deferring playlist and media reset until just before reboot"
else
  restore_first_run_media
fi

clear_runtime_state() {
  print_step "clearing schedules, runtime status, and agent cache"
  apply_or_print rm -f "$schedules_path"
  apply_or_print rm -rf "$state_dir"
  apply_or_print rm -rf "$agent_cache_dir"
  apply_or_print mkdir -p "$state_dir"
}

if [[ "$defer_field_player_restart" == "true" ]]; then
  print_step "deferring runtime cache clear until just before reboot"
else
  clear_runtime_state
fi

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
if [[ "$defer_field_player_restart" == "true" ]]; then
  apply_or_print systemctl --user disable pisignage-kiosk.service
  apply_or_print systemctl --user disable pisignage-player.service
  apply_or_print systemctl --user enable pisignage-vlc.service
else
  apply_or_print systemctl --user disable --now pisignage-kiosk.service
  apply_or_print systemctl --user disable --now pisignage-player.service
  apply_or_print systemctl --user enable --now pisignage-vlc.service
fi
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

if [[ "$defer_field_player_restart" == "true" ]]; then
  restore_first_run_media
  clear_runtime_state
fi

print_step "collecting reset evidence"
if [[ "$mode" == "apply" ]]; then
  playlist_sha="$(sha256sum "$playlist_path" | awk '{print $1}')"
  asset_count="$(find "$assets_dir" -maxdepth 1 -type f 2>/dev/null | wc -l | tr -d ' ')"
  vlc_state="$(systemctl --user is-active pisignage-vlc.service 2>/dev/null || true)"
  agent_state="$(systemctl --user is-active pisignage-device-agent.service 2>/dev/null || true)"
  timer_state="$(systemctl --user is-active pisignage-schedule.timer 2>/dev/null || true)"
  echo "reset-complete"
  echo "reset_source=${source_mode}"
  if [[ "$source_mode" == "golden-master" ]]; then
    echo "golden_remote=${golden_remote}"
    echo "golden_ref=${golden_ref}"
  fi
  if [[ "$source_mode" != "current" ]]; then
    echo "reset_commit=${golden_commit}"
  fi
  echo "playlist_sha=${playlist_sha}"
  echo "asset_count=${asset_count}"
  echo "vlc_service=${vlc_state}"
  echo "device_agent_service=${agent_state:-unknown}"
  echo "schedule_timer=${timer_state:-unknown}"
else
  echo "Dry run only; no files changed."
fi
