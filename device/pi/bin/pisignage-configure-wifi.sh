#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  pisignage-configure-wifi.sh [--ssid SSID] [--ifname IFACE] [--dry-run]

Connects a Beam Pi to Wi-Fi through NetworkManager without accepting a
password argument. NetworkManager prompts for the Wi-Fi secret at runtime so the
password does not land in git, shell history, or script output.

Options:
  --ssid SSID       Wi-Fi network name. If omitted, prompt interactively.
  --ifname IFACE    Wireless interface. Default: wlan0.
  --no-rescan       Skip the pre-connect Wi-Fi rescan.
  --dry-run         Check prerequisites and show intended action only.
  --help            Show this help.

Examples:
  device/pi/bin/pisignage-configure-wifi.sh
  device/pi/bin/pisignage-configure-wifi.sh --ssid "Office Wi-Fi"
USAGE
}

die() {
  echo "error: $*" >&2
  exit 1
}

nmcli_command=(nmcli)
ssid=""
ifname="wlan0"
dry_run="false"
rescan="true"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ssid)
      ssid="${2:-}"
      shift 2
      ;;
    --ifname)
      ifname="${2:-}"
      shift 2
      ;;
    --no-rescan)
      rescan="false"
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

command -v nmcli >/dev/null 2>&1 || die "NetworkManager nmcli is required for this helper."
[[ -n "$ifname" ]] || die "--ifname cannot be empty"

if [[ -z "$ssid" && "$dry_run" != "true" ]]; then
  read -r -p "Wi-Fi SSID: " ssid
fi

if [[ "$dry_run" != "true" ]]; then
  [[ -n "$ssid" ]] || die "Wi-Fi SSID is required"
fi

echo "Beam Wi-Fi setup"
echo "  interface: ${ifname}"
echo "  route preference: Wi-Fi is preferred when Ethernet and Wi-Fi are both active"
echo "  credential entry: prompted by NetworkManager; not accepted by this script"
echo "  note: if you are connected over SSH, the session may drop after the network route changes"

if [[ "$dry_run" == "true" ]]; then
  echo "Dry run only; no Wi-Fi settings changed."
  nmcli device status 2>/dev/null | awk '$1 == "wlan0" || $1 == "'"${ifname}"'" { print }' || true
  exit 0
fi

nmcli_with_privilege() {
  local output
  if output="$("${nmcli_command[@]}" "$@" 2>&1)"; then
    return 0
  fi

  if [[ "${nmcli_command[0]}" != "sudo" ]] && grep -qi "not authorized" <<< "$output" && command -v sudo >/dev/null 2>&1; then
    nmcli_command=(sudo nmcli)
    "${nmcli_command[@]}" "$@"
    return $?
  fi

  printf '%s\n' "$output" >&2
  return 1
}

nmcli_with_privilege radio wifi on
nmcli_with_privilege device set "$ifname" managed yes >/dev/null 2>&1 || true

if [[ "$rescan" == "true" ]]; then
  nmcli_with_privilege device wifi rescan ifname "$ifname" >/dev/null 2>&1 || true
fi

echo "NetworkManager may ask for the Wi-Fi password now."
nmcli_with_privilege --ask device wifi connect "$ssid" ifname "$ifname"
nmcli_with_privilege connection modify "$ssid" connection.autoconnect yes connection.autoconnect-priority 0 ipv4.route-metric 50 ipv6.route-metric 50

echo "Wi-Fi connection command completed."
echo "Current Wi-Fi evidence:"
ip -br -4 addr show dev "$ifname" 2>/dev/null || true
printf 'defaultRoute='
ip route get 1.1.1.1 2>/dev/null | head -n 1 || true
echo "Saved Wi-Fi route preference:"
nmcli connection show "$ssid" | awk '/connection.autoconnect:/ || /connection.autoconnect-priority:/ || /connection.interface-name:/ || /802-11-wireless.ssid:/ || /ipv4.route-metric:/ || /ipv6.route-metric:/ { print }' || true
