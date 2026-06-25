#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  pisignage-call-home-now.sh [--repo-root PATH] [--env-file PATH]

Runs one PiSignage device-agent cycle immediately. This writes the local
heartbeat and, when cloud settings are provisioned, posts a call-home heartbeat
to Beam. Secrets are read from the private device-agent env file and are not
printed by this helper.

Options:
  --repo-root PATH  PiSignage repo path. Default: detected repo root, or ~/PiSignage.
  --env-file PATH   Device-agent env file. Default: ~/.config/pisignage/device-agent.env.
  --help            Show this help.
USAGE
}

die() {
  echo "error: $*" >&2
  exit 1
}

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
detected_repo_root="$(cd -- "${script_dir}/../../.." 2>/dev/null && pwd || true)"
if [[ -n "$detected_repo_root" && -f "${detected_repo_root}/device-agent/dist/index.js" ]]; then
  repo_root="$detected_repo_root"
else
  repo_root="${HOME}/PiSignage"
fi
env_file="${HOME}/.config/pisignage/device-agent.env"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-root)
      repo_root="${2:-}"
      shift 2
      ;;
    --env-file)
      env_file="${2:-}"
      shift 2
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

[[ -n "$repo_root" ]] || die "--repo-root is required"
[[ -f "${repo_root}/device-agent/dist/index.js" ]] ||
  die "compiled device-agent not found at ${repo_root}/device-agent/dist/index.js"
[[ -f "$env_file" ]] ||
  die "device-agent env file not found at ${env_file}; run pisignage-provision-device.sh first"

echo "Beam Pi call-home"
echo "  repo root: ${repo_root}"
echo "  env file: ${env_file}"
echo "  cloud heartbeat: $(grep -q '^PISIGNAGE_CLOUD_API_URL=' "$env_file" && echo configured || echo not configured)"

set -a
# shellcheck disable=SC1090
. "$env_file"
set +a

exec /usr/bin/node "${repo_root}/device-agent/dist/index.js"
