#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  pisignage-install-runtime.sh [options] [--dry-run|--apply]

Installs or updates the Beam Pi runtime for the current user. The helper writes
user systemd services with the detected repo path, current user runtime dir, and
chosen display settings so field Pis do not depend on hidden C5-only paths.

Options:
  --repo-root PATH             PiSignage repo path. Default: detected repo root.
  --display-output NAME        Display output. Default: HDMI-A-1.
  --display-resolution MODE    Display mode. Default: 1920x1080@60.000000.
  --screen-id ID               Local screen id for schedule enforcement. Default: screen-primary.
  --field-player vlc|browser|none
                               Enable the field playback stack. Default: vlc.
  --enable-device-agent auto|true|false
                               Enable agent when dist exists, force enable, or disable. Default: auto.
  --enable-remote-access auto|true|false
                               Install/enable Tailscale and browser remote desktop prerequisites. Default: auto.
  --tailscale-hostname NAME    Tailnet hostname. Default: beam-<local hostname>.
  --tailscale-auth-key-env NAME
                               Env var containing a Tailscale auth key for noninteractive enrollment.
                               Default: PISIGNAGE_TAILSCALE_AUTHKEY.
  --node-bin PATH              Node binary for services. Default: /usr/bin/node.
  --dry-run                    Show planned work without changing files. Default.
  --apply                      Install files and update user services.
  --help                       Show this help.
USAGE
}

die() {
  echo "error: $*" >&2
  exit 1
}

print_step() {
  echo "install-runtime: $*"
}

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/../../.." && pwd)"
display_output="HDMI-A-1"
display_resolution="1920x1080@60.000000"
screen_id="screen-primary"
field_player="vlc"
enable_device_agent="auto"
enable_remote_access="auto"
tailscale_hostname=""
tailscale_auth_key_env="PISIGNAGE_TAILSCALE_AUTHKEY"
node_bin="/usr/bin/node"
mode="dry-run"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-root)
      repo_root="${2:-}"
      shift 2
      ;;
    --display-output)
      display_output="${2:-}"
      shift 2
      ;;
    --display-resolution)
      display_resolution="${2:-}"
      shift 2
      ;;
    --screen-id)
      screen_id="${2:-}"
      shift 2
      ;;
    --field-player)
      field_player="${2:-}"
      shift 2
      ;;
    --enable-device-agent)
      enable_device_agent="${2:-}"
      shift 2
      ;;
    --enable-remote-access)
      enable_remote_access="${2:-}"
      shift 2
      ;;
    --tailscale-hostname)
      tailscale_hostname="${2:-}"
      shift 2
      ;;
    --tailscale-auth-key-env)
      tailscale_auth_key_env="${2:-}"
      shift 2
      ;;
    --node-bin)
      node_bin="${2:-}"
      shift 2
      ;;
    --dry-run)
      mode="dry-run"
      shift
      ;;
    --apply)
      mode="apply"
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

[[ "$field_player" == "vlc" || "$field_player" == "browser" || "$field_player" == "none" ]] ||
  die "--field-player must be vlc, browser, or none"
[[ "$enable_device_agent" == "auto" || "$enable_device_agent" == "true" || "$enable_device_agent" == "false" ]] ||
  die "--enable-device-agent must be auto, true, or false"
[[ "$enable_remote_access" == "auto" || "$enable_remote_access" == "true" || "$enable_remote_access" == "false" ]] ||
  die "--enable-remote-access must be auto, true, or false"
[[ -n "$repo_root" ]] || die "--repo-root cannot be empty"
repo_root="$(cd -- "$repo_root" && pwd)"
[[ -f "${repo_root}/sample-content/playlist.local.json" ]] ||
  die "--repo-root does not look like PiSignage: ${repo_root}"
[[ -d "${repo_root}/device/pi/bin" ]] || die "--repo-root is missing device/pi/bin"

validate_no_whitespace() {
  local name="$1"
  local value="$2"
  [[ -n "$value" ]] || die "${name} cannot be empty"
  [[ "$value" != *[$'\n\r\t ']* ]] || die "${name} cannot contain whitespace"
}

validate_no_whitespace "--repo-root" "$repo_root"
validate_no_whitespace "--display-output" "$display_output"
validate_no_whitespace "--display-resolution" "$display_resolution"
validate_no_whitespace "--screen-id" "$screen_id"
validate_no_whitespace "--node-bin" "$node_bin"
if [[ -z "$tailscale_hostname" ]]; then
  local_hostname="$(hostname -s 2>/dev/null || hostname)"
  tailscale_hostname="beam-${local_hostname,,}"
fi
validate_no_whitespace "--tailscale-hostname" "$tailscale_hostname"
validate_no_whitespace "--tailscale-auth-key-env" "$tailscale_auth_key_env"

uid="$(id -u)"
home_dir="${HOME:?HOME is required}"
local_bin_dir="${home_dir}/.local/bin"
systemd_user_dir="${home_dir}/.config/systemd/user"
state_dir="${home_dir}/.local/state/pisignage"
agent_cache_dir="${home_dir}/.local/cache/pisignage/device-agent"
runtime_dir="/run/user/${uid}"
dbus_address="unix:path=${runtime_dir}/bus"
device_agent_dist="${repo_root}/device-agent/dist/index.js"

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

required_asset_sources=(
  "device/pi/assets/ad-dad-logo.png"
  "device/pi/assets/ad-dad-logo.ppm"
)

managed_sudoers_sources=(
  "device/pi/sudoers.d/pisignage-display-recovery"
  "device/pi/sudoers.d/pisignage-reset-reboot"
)

for source in "${managed_bin_sources[@]}" "${required_asset_sources[@]}" "${managed_sudoers_sources[@]}"; do
  [[ -f "${repo_root}/${source}" ]] || die "missing runtime file: ${source}"
done

apply_or_print() {
  if [[ "$mode" == "apply" ]]; then
    "$@"
  else
    printf 'dry-run:'
    printf ' %q' "$@"
    printf '\n'
  fi
}

sudo_apply_or_print() {
  if [[ "$mode" == "apply" ]]; then
    sudo "$@"
  else
    printf 'dry-run: sudo'
    printf ' %q' "$@"
    printf '\n'
  fi
}

write_root_text_file() {
  local target="$1"
  local file_mode="$2"
  local body="$3"
  if [[ "$mode" == "apply" ]]; then
    local tmp_path
    tmp_path="$(mktemp)"
    printf '%s\n' "$body" > "$tmp_path"
    sudo install -m "$file_mode" "$tmp_path" "$target"
    rm -f "$tmp_path"
  else
    echo "dry-run: sudo write ${target} (${file_mode})"
  fi
}

write_text_file() {
  local target="$1"
  local file_mode="$2"
  local body="$3"
  if [[ "$mode" == "apply" ]]; then
    mkdir -p "$(dirname -- "$target")"
    local tmp_path
    tmp_path="$(mktemp "${target}.XXXXXX")"
    printf '%s\n' "$body" > "$tmp_path"
    install -m "$file_mode" "$tmp_path" "$target"
    rm -f "$tmp_path"
  else
    echo "dry-run: write ${target} (${file_mode})"
  fi
}

install_tailscale_apt_source() {
  local codename
  codename="$(. /etc/os-release && printf '%s' "${VERSION_CODENAME:-}")"
  [[ -n "$codename" ]] || die "could not detect Debian codename for Tailscale apt source"

  if [[ "$mode" == "apply" && ! -x /usr/bin/curl ]]; then
    sudo_apply_or_print apt-get update
    sudo_apply_or_print env DEBIAN_FRONTEND=noninteractive apt-get install -y curl ca-certificates
  fi

  if [[ "$mode" == "apply" ]]; then
    curl -fsSL "https://pkgs.tailscale.com/stable/debian/${codename}.noarmor.gpg" |
      sudo tee /usr/share/keyrings/tailscale-archive-keyring.gpg >/dev/null
    curl -fsSL "https://pkgs.tailscale.com/stable/debian/${codename}.tailscale-keyring.list" |
      sudo tee /etc/apt/sources.list.d/tailscale.list >/dev/null
  else
    echo "dry-run: install Tailscale apt source for Debian ${codename}"
  fi
}

install_remote_access_packages() {
  [[ "$enable_remote_access" != "false" ]] || return

  print_step "installing remote access packages"
  local missing_packages=()
  for package in tailscale novnc websockify wayvnc; do
    if ! dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q "install ok installed"; then
      missing_packages+=("$package")
    fi
  done

  if [[ ${#missing_packages[@]} -eq 0 ]]; then
    print_step "remote access packages already installed"
    return
  fi

  if [[ " ${missing_packages[*]} " == *" tailscale "* ]] && [[ ! -f /etc/apt/sources.list.d/tailscale.list ]]; then
    install_tailscale_apt_source
  fi

  sudo_apply_or_print apt-get update
  sudo_apply_or_print env DEBIAN_FRONTEND=noninteractive apt-get install -y "${missing_packages[@]}"
}

configure_wayvnc() {
  [[ "$enable_remote_access" != "false" ]] || return

  if ! command -v wayvnc >/dev/null 2>&1 && [[ "$mode" == "apply" ]]; then
    print_step "WayVNC unavailable; remote desktop backend not configured"
    return
  fi

  print_step "configuring WayVNC for browser remote desktop"
  write_root_text_file /etc/wayvnc/config 644 "$(cat <<'WAYVNC'
use_relative_paths=true
address=::
enable_auth=false
enable_pam=true
private_key_file=tls_key.pem
certificate_file=tls_cert.pem
rsa_private_key_file=rsa_key.pem
WAYVNC
)"
  sudo_apply_or_print systemctl enable --now wayvnc.service
  sudo_apply_or_print systemctl restart wayvnc.service
}

configure_tailscale() {
  [[ "$enable_remote_access" != "false" ]] || return

  if ! command -v tailscale >/dev/null 2>&1 && [[ "$mode" == "apply" ]]; then
    print_step "Tailscale unavailable; tailnet enrollment not configured"
    return
  fi

  print_step "configuring Tailscale"
  sudo_apply_or_print systemctl enable --now tailscaled.service

  if [[ "$mode" != "apply" ]]; then
    echo "dry-run: enroll Tailscale as ${tailscale_hostname} with --accept-dns=false when not already logged in"
    return
  fi

  if tailscale ip -4 >/dev/null 2>&1; then
    print_step "Tailscale already enrolled as $(tailscale ip -4)"
    return
  fi

  local auth_key="${!tailscale_auth_key_env:-}"
  if [[ -n "$auth_key" ]]; then
    print_step "enrolling Tailscale with auth key from ${tailscale_auth_key_env}"
    sudo tailscale up --auth-key="$auth_key" --hostname="$tailscale_hostname" --accept-dns=false
    return
  fi

  print_step "Tailscale needs interactive approval; visit the login URL printed below"
  timeout 30s sudo tailscale up --hostname="$tailscale_hostname" --accept-dns=false || true
}

install_managed_scripts() {
  print_step "installing managed scripts into ${local_bin_dir}"
  apply_or_print mkdir -p "$local_bin_dir"
  for source in "${managed_bin_sources[@]}"; do
    apply_or_print install -m 755 "${repo_root}/${source}" "${local_bin_dir}/$(basename -- "$source")"
  done
}

install_managed_sudoers() {
  print_step "installing managed sudoers drop-ins"
  for source in "${managed_sudoers_sources[@]}"; do
    if command -v visudo >/dev/null 2>&1; then
      visudo -cf "${repo_root}/${source}" >/dev/null
    fi
    sudo_apply_or_print install -m 0440 "${repo_root}/${source}" "/etc/sudoers.d/$(basename -- "$source")"
    if [[ "$mode" == "apply" ]] && command -v visudo >/dev/null 2>&1; then
      sudo visudo -cf "/etc/sudoers.d/$(basename -- "$source")" >/dev/null
    fi
  done
}

device_agent_service="$(cat <<SERVICE
[Unit]
Description=PiSignage Device Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${repo_root}
Environment=PISIGNAGE_PLAYLIST_PATH=${repo_root}/sample-content/playlist.local.json
Environment=PISIGNAGE_CACHE_DIR=%h/.local/cache/pisignage/device-agent
Environment=PISIGNAGE_HEARTBEAT_PATH=%h/.local/state/pisignage/heartbeat.json
Environment=PISIGNAGE_HEARTBEAT_INTERVAL_SECONDS=30
Environment=PISIGNAGE_HEARTBEAT_JITTER_SECONDS=5
Environment=DISPLAY=:0
Environment=XDG_RUNTIME_DIR=${runtime_dir}
Environment=DBUS_SESSION_BUS_ADDRESS=${dbus_address}
Environment=WAYLAND_DISPLAY=wayland-0
EnvironmentFile=-%h/.config/pisignage/device-agent.env
ExecStart=${node_bin} ${device_agent_dist} --loop
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
SERVICE
)"

player_service="$(cat <<SERVICE
[Unit]
Description=PiSignage Player Static Server

[Service]
Type=simple
WorkingDirectory=${repo_root}
ExecStart=${node_bin} %h/.local/bin/pisignage-serve-player.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
SERVICE
)"

kiosk_service="$(cat <<SERVICE
[Unit]
Description=PiSignage Display Browser
After=pisignage-player.service
Wants=pisignage-player.service

[Service]
Type=simple
Environment=PISIGNAGE_DISPLAY_MODE=kiosk
ExecStart=%h/.local/bin/pisignage-start-display.sh
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
SERVICE
)"

schedule_service="$(cat <<SERVICE
[Unit]
Description=PiSignage Schedule Enforcement

[Service]
Type=oneshot
WorkingDirectory=${repo_root}
Environment=DISPLAY=:0
Environment=XDG_RUNTIME_DIR=${runtime_dir}
Environment=DBUS_SESSION_BUS_ADDRESS=${dbus_address}
Environment=WAYLAND_DISPLAY=wayland-0
Environment=PISIGNAGE_REPO_ROOT=${repo_root}
Environment=PISIGNAGE_SCREEN_ID=${screen_id}
Environment=PISIGNAGE_DISPLAY_OUTPUT=${display_output}
Environment=PISIGNAGE_DISPLAY_RESOLUTION=${display_resolution}
Environment=PISIGNAGE_SCHEDULE_STATUS_PATH=%h/.local/state/pisignage/schedule-status.json
ExecStart=${node_bin} %h/.local/bin/pisignage-enforce-schedule.mjs
SERVICE
)"

schedule_timer="$(cat <<'SERVICE'
[Unit]
Description=Run PiSignage schedule enforcement every minute

[Timer]
OnBootSec=30s
OnUnitActiveSec=60s
Persistent=true

[Install]
WantedBy=timers.target
SERVICE
)"

vlc_service="$(cat <<SERVICE
[Unit]
Description=PiSignage Native VLC Video Player

[Service]
Type=simple
WorkingDirectory=${repo_root}
Environment=DISPLAY=:0
Environment=XDG_RUNTIME_DIR=${runtime_dir}
Environment=DBUS_SESSION_BUS_ADDRESS=${dbus_address}
Environment=WAYLAND_DISPLAY=wayland-0
Environment=PISIGNAGE_REPO_ROOT=${repo_root}
Environment=PISIGNAGE_DISPLAY_OUTPUT=${display_output}
Environment=PISIGNAGE_DISPLAY_RESOLUTION=${display_resolution}
Environment=PISIGNAGE_VLC_VIDEO_OUTPUT=wl_shm
Environment=PISIGNAGE_VLC_PLAYBACK_MODE=continuous
Environment=PISIGNAGE_PLAYLIST_HANDOFF_OVERLAP_MS=2500
Environment=PISIGNAGE_VLC_RESTART_BACKOFF_MS=15000
Environment=PISIGNAGE_VLC_RESTART_BACKOFF_MAX_MS=120000
Environment=PISIGNAGE_VLC_WAYLAND_DISPLAY=wayland-0
Environment=PISIGNAGE_STATUS_PATH=%h/.local/state/pisignage/player-status.json
Environment=PISIGNAGE_STARTUP_SETTLE_MS=0
ExecStartPre=%h/.local/bin/pisignage-hide-desktop.sh
ExecStart=${node_bin} %h/.local/bin/pisignage-vlc-playlist.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
SERVICE
)"

remote_desktop_service="$(cat <<'SERVICE'
[Unit]
Description=PiSignage Browser Remote Desktop
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/websockify --web=/usr/share/novnc 0.0.0.0:6080 127.0.0.1:5900
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
SERVICE
)"

install_user_services() {
  print_step "writing generated user services into ${systemd_user_dir}"
  write_text_file "${systemd_user_dir}/pisignage-device-agent.service" 644 "$device_agent_service"
  write_text_file "${systemd_user_dir}/pisignage-player.service" 644 "$player_service"
  write_text_file "${systemd_user_dir}/pisignage-kiosk.service" 644 "$kiosk_service"
  write_text_file "${systemd_user_dir}/pisignage-schedule.service" 644 "$schedule_service"
  write_text_file "${systemd_user_dir}/pisignage-schedule.timer" 644 "$schedule_timer"
  write_text_file "${systemd_user_dir}/pisignage-vlc.service" 644 "$vlc_service"
  write_text_file "${systemd_user_dir}/pisignage-remote-desktop.service" 644 "$remote_desktop_service"
}

enable_services() {
  print_step "reloading user systemd"
  apply_or_print systemctl --user daemon-reload

  case "$field_player" in
    vlc)
      print_step "enabling VLC field playback"
      apply_or_print systemctl --user disable --now pisignage-kiosk.service pisignage-player.service
      apply_or_print systemctl --user enable pisignage-vlc.service
      apply_or_print systemctl --user restart pisignage-vlc.service
      ;;
    browser)
      print_step "enabling browser field playback"
      apply_or_print systemctl --user disable --now pisignage-vlc.service
      apply_or_print systemctl --user enable pisignage-player.service pisignage-kiosk.service
      apply_or_print systemctl --user restart pisignage-player.service pisignage-kiosk.service
      ;;
    none)
      print_step "field player left unchanged"
      ;;
  esac

  apply_or_print systemctl --user enable --now pisignage-schedule.timer

  if command -v websockify >/dev/null 2>&1 && [[ -f /usr/share/novnc/vnc.html ]]; then
    print_step "enabling browser remote desktop bridge"
    apply_or_print systemctl --user enable --now pisignage-remote-desktop.service
  else
    print_step "browser remote desktop bridge not enabled; install novnc and websockify first"
  fi

  if [[ "$enable_device_agent" == "true" ]] || [[ "$enable_device_agent" == "auto" && -f "$device_agent_dist" ]]; then
    print_step "enabling device agent"
    apply_or_print systemctl --user enable --now pisignage-device-agent.service
  elif [[ "$enable_device_agent" == "false" ]]; then
    print_step "disabling device agent by request"
    apply_or_print systemctl --user disable --now pisignage-device-agent.service
  else
    print_step "device-agent dist not present; installed service but did not enable it"
  fi
}

print_summary() {
  echo "Beam Pi runtime install/update"
  echo "  mode: ${mode}"
  echo "  repo root: ${repo_root}"
  echo "  user: $(id -un) (${uid})"
  echo "  runtime dir: ${runtime_dir}"
  echo "  display: ${display_output} ${display_resolution}"
  echo "  screen id: ${screen_id}"
  echo "  field player: ${field_player}"
  echo "  device agent: ${enable_device_agent}"
  echo "  state dir: ${state_dir}"
  echo "  agent cache: ${agent_cache_dir}"
}

print_summary
install_remote_access_packages
configure_wayvnc
configure_tailscale
install_managed_scripts
install_managed_sudoers
install_user_services
enable_services

if [[ "$mode" == "apply" ]]; then
  print_step "service state"
  systemctl --user --no-pager --plain status pisignage-vlc.service pisignage-device-agent.service pisignage-schedule.timer pisignage-remote-desktop.service || true
else
  echo "Dry run only; rerun with --apply to install files and update services."
fi
