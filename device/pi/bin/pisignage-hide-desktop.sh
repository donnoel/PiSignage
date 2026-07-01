#!/usr/bin/env bash
set -euo pipefail

readonly home_dir="${HOME:?HOME is required}"

write_pcmanfm_config() {
  local profile="$1"
  local target_dir="${home_dir}/.config/pcmanfm/${profile}"
  local target_path="${target_dir}/desktop-items-0.conf"
  local tmp_path

  mkdir -p "$target_dir"
  tmp_path="$(mktemp "${target_path}.XXXXXX")"
  cat > "$tmp_path" <<'CONFIG'
[*]
wallpaper_mode=color
wallpaper_common=1
wallpaper=
desktop_bg=#000000
desktop_fg=#ffffff
desktop_shadow=#000000
desktop_font=Sans 12
show_wm_menu=0
sort=mtime;ascending;
show_documents=0
show_trash=0
show_mounts=0
CONFIG
  install -m 644 "$tmp_path" "$target_path"
  rm -f "$tmp_path"
}

write_pcmanfm_config "LXDE-pi"
write_pcmanfm_config "default"
