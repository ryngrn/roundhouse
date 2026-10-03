#!/bin/zsh
set -euo pipefail
script_dir="${0:A:h}"
repo="${script_dir:h:h}"
app="$repo/build/Roundhouse Menu.app"
executable="$app/Contents/MacOS/RoundhouseMenu"
agents="$HOME/Library/LaunchAgents"
action="${1:-build}"

build() {
  mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
  xcrun swiftc "$repo/macos/RoundhouseMenu/main.swift" -o "$executable" -framework AppKit -framework UserNotifications
  cp "$repo/macos/RoundhouseMenu/Info.plist" "$app/Contents/Info.plist"
  cp "$repo/macos/RoundhouseMenu/status-light.svg" "$app/Contents/Resources/status-light.svg"
  cp "$repo/macos/RoundhouseMenu/status-dark.svg" "$app/Contents/Resources/status-dark.svg"
}

case "$action" in
  build) build; print "$app" ;;
  run) build; open "$app" ;;
  install)
    build
    mkdir -p "$agents"
    stage="$(mktemp -d)"
    trap 'rm -rf "$stage"' EXIT
    node "$repo/scripts/macos/generate.mjs" "$stage" "$repo" "$(command -v node)" "$HOME" "$executable"
    cp "$stage/io.roundhouse.menu.plist" "$agents/io.roundhouse.menu.plist"
    launchctl bootout "gui/$UID/io.roundhouse.menu" 2>/dev/null || true
    launchctl bootstrap "gui/$UID" "$agents/io.roundhouse.menu.plist"
    print "Roundhouse menu helper installed at login."
    ;;
  uninstall)
    launchctl bootout "gui/$UID/io.roundhouse.menu" 2>/dev/null || true
    rm -f "$agents/io.roundhouse.menu.plist"
    print "Roundhouse menu login helper removed."
    ;;
  *) print -u2 "Usage: menu-bar.sh <build|run|install|uninstall>"; exit 64 ;;
esac
