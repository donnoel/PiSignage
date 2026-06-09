#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  pisignage-provision-device.sh --device-id DEVICE_ID [options]

Options:
  --device-id ID              Stable Beam device id for this Pi. Required.
  --dashboard-url URL         Beam dashboard URL. Used to build the cloud playlist URL.
  --cloud-playlist-url URL    Explicit cloud playlist URL. Overrides --dashboard-url.
  --api-url URL               Beam cloud API base URL for heartbeat posts.
  --api-key KEY               Beam cloud API key. Written only to the private env file.
  --environment NAME          Device environment label for device.json. Default: local.
  --network-online true|false Report networkOnline in heartbeat. Defaults to true for cloud config.
  --heartbeat-interval N      Heartbeat loop interval in seconds. Default: 60.
  --repo-root PATH            PiSignage repo path on this Pi. Default: detected repo root.
  --install-service           Install the user systemd device-agent service.
  --enable-service            Enable and start the user systemd device-agent service.
  --dry-run                   Validate and show planned paths without writing files.
  --help                      Show this help.

Examples:
  device/pi/bin/pisignage-provision-device.sh \
    --device-id device-c5-aws-pilot \
    --dashboard-url https://example.awsapprunner.com \
    --api-url https://example.execute-api.us-west-2.amazonaws.com/dev \
    --api-key paste-dev-api-key
USAGE
}

die() {
  echo "error: $*" >&2
  exit 1
}

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/../../.." && pwd)"

device_id=""
dashboard_url=""
cloud_playlist_url=""
cloud_api_url=""
cloud_api_key=""
environment_name="local"
network_online=""
heartbeat_interval="60"
install_service="false"
enable_service="false"
dry_run="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --device-id)
      device_id="${2:-}"
      shift 2
      ;;
    --dashboard-url)
      dashboard_url="${2:-}"
      shift 2
      ;;
    --cloud-playlist-url)
      cloud_playlist_url="${2:-}"
      shift 2
      ;;
    --api-url)
      cloud_api_url="${2:-}"
      shift 2
      ;;
    --api-key)
      cloud_api_key="${2:-}"
      shift 2
      ;;
    --environment)
      environment_name="${2:-}"
      shift 2
      ;;
    --network-online)
      network_online="${2:-}"
      shift 2
      ;;
    --heartbeat-interval)
      heartbeat_interval="${2:-}"
      shift 2
      ;;
    --repo-root)
      repo_root="${2:-}"
      shift 2
      ;;
    --install-service)
      install_service="true"
      shift
      ;;
    --enable-service)
      install_service="true"
      enable_service="true"
      shift
      ;;
    --dry-run)
      dry_run="true"
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

[[ -n "$device_id" ]] || die "--device-id is required"
[[ "$device_id" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{1,79}$ ]] ||
  die "--device-id must be 2-80 chars: letters, numbers, dot, underscore, colon, or dash"
[[ "$environment_name" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{1,39}$ ]] ||
  die "--environment must be 2-40 chars: letters, numbers, dot, underscore, colon, or dash"
[[ "$heartbeat_interval" =~ ^[0-9]+$ ]] || die "--heartbeat-interval must be a positive integer"
(( heartbeat_interval >= 5 )) || die "--heartbeat-interval must be at least 5 seconds"

validate_no_whitespace() {
  local name="$1"
  local value="$2"
  [[ "$value" != *[$'\n\r\t ']* ]] || die "$name cannot contain whitespace"
  [[ "$value" != *['"\\']* ]] || die "$name cannot contain quotes or backslashes"
}

validate_url() {
  local name="$1"
  local value="$2"
  [[ -z "$value" || "$value" =~ ^https?:// ]] || die "$name must start with http:// or https://"
  validate_no_whitespace "$name" "$value"
}

validate_no_whitespace "--device-id" "$device_id"
validate_no_whitespace "--environment" "$environment_name"
validate_url "--dashboard-url" "$dashboard_url"
validate_url "--cloud-playlist-url" "$cloud_playlist_url"
validate_url "--api-url" "$cloud_api_url"
validate_no_whitespace "--api-key" "$cloud_api_key"

if [[ -n "$cloud_api_url" && -z "$cloud_api_key" ]] || [[ -z "$cloud_api_url" && -n "$cloud_api_key" ]]; then
  die "--api-url and --api-key must be provided together"
fi

repo_root="$(cd -- "$repo_root" && pwd)"
[[ -f "${repo_root}/device-agent/package.json" ]] || die "--repo-root does not look like PiSignage: ${repo_root}"

if [[ -z "$cloud_playlist_url" && -n "$dashboard_url" ]]; then
  cloud_playlist_url="${dashboard_url%/}/api/cloud/devices/${device_id}/playlist"
fi

if [[ -z "$network_online" ]]; then
  if [[ -n "$cloud_playlist_url" || -n "$cloud_api_url" ]]; then
    network_online="true"
  else
    network_online="false"
  fi
fi
[[ "$network_online" == "true" || "$network_online" == "false" ]] ||
  die "--network-online must be true or false"

config_dir="${HOME}/.config/pisignage"
env_file="${config_dir}/device-agent.env"
identity_file="${config_dir}/device.json"
systemd_user_dir="${HOME}/.config/systemd/user"
service_source="${repo_root}/device/pi/systemd/user/pisignage-device-agent.service"
service_target="${systemd_user_dir}/pisignage-device-agent.service"
cache_dir="${HOME}/.local/cache/pisignage/device-agent"
heartbeat_path="${HOME}/.local/state/pisignage/heartbeat.json"
playlist_path="${repo_root}/sample-content/playlist.local.json"
provisioned_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

write_files() {
  mkdir -p "$config_dir"

  local tmp_env
  tmp_env="$(mktemp "${env_file}.XXXXXX")"
  {
    echo "# Generated by device/pi/bin/pisignage-provision-device.sh"
    echo "PISIGNAGE_DEVICE_ID=${device_id}"
    echo "PISIGNAGE_PLAYLIST_PATH=${playlist_path}"
    echo "PISIGNAGE_CACHE_DIR=${cache_dir}"
    echo "PISIGNAGE_HEARTBEAT_PATH=${heartbeat_path}"
    echo "PISIGNAGE_HEARTBEAT_INTERVAL_SECONDS=${heartbeat_interval}"
    echo "PISIGNAGE_NETWORK_ONLINE=${network_online}"
    if [[ -n "$cloud_playlist_url" ]]; then
      echo "PISIGNAGE_CLOUD_PLAYLIST_URL=${cloud_playlist_url}"
    fi
    if [[ -n "$cloud_api_url" ]]; then
      echo "PISIGNAGE_CLOUD_API_URL=${cloud_api_url}"
      echo "PISIGNAGE_CLOUD_API_KEY=${cloud_api_key}"
    fi
  } > "$tmp_env"
  install -m 600 "$tmp_env" "$env_file"
  rm -f "$tmp_env"

  local tmp_identity
  tmp_identity="$(mktemp "${identity_file}.XXXXXX")"
  {
    echo "{"
    echo "  \"schemaVersion\": 1,"
    echo "  \"deviceId\": \"${device_id}\","
    echo "  \"environment\": \"${environment_name}\","
    echo "  \"repoRoot\": \"${repo_root}\","
    echo "  \"playlistPath\": \"${playlist_path}\","
    echo "  \"cacheDirectory\": \"${cache_dir}\","
    echo "  \"heartbeatPath\": \"${heartbeat_path}\","
    echo "  \"cloudPlaylistUrl\": \"${cloud_playlist_url}\","
    echo "  \"cloudApiUrl\": \"${cloud_api_url}\","
    echo "  \"provisionedAt\": \"${provisioned_at}\""
    echo "}"
  } > "$tmp_identity"
  install -m 600 "$tmp_identity" "$identity_file"
  rm -f "$tmp_identity"
}

install_user_service() {
  mkdir -p "$systemd_user_dir"
  install -m 644 "$service_source" "$service_target"
  systemctl --user daemon-reload
  if [[ "$enable_service" == "true" ]]; then
    systemctl --user enable --now pisignage-device-agent.service
  fi
}

echo "Beam Pi provisioning"
echo "  device id: ${device_id}"
echo "  env file: ${env_file}"
echo "  identity file: ${identity_file}"
echo "  repo root: ${repo_root}"
echo "  cloud playlist: $([[ -n "$cloud_playlist_url" ]] && echo configured || echo not configured)"
echo "  cloud heartbeat: $([[ -n "$cloud_api_url" ]] && echo configured || echo not configured)"
echo "  api key: $([[ -n "$cloud_api_key" ]] && echo written-redacted || echo not configured)"
echo "  install service: ${install_service}"
echo "  enable service: ${enable_service}"

if [[ "$dry_run" == "true" ]]; then
  echo "Dry run only; no files written."
  exit 0
fi

write_files

if [[ "$install_service" == "true" ]]; then
  install_user_service
fi

echo "Provisioning complete."
echo "Next checks:"
echo "  cat ${identity_file}"
echo "  systemctl --user status pisignage-device-agent.service --no-pager"
echo "  journalctl --user -u pisignage-device-agent.service -n 100 --no-pager"
