#!/bin/zsh
set -euo pipefail
script_dir="${0:A:h}"
repo="${script_dir:h:h}"
app="$repo/build/Roundhouse Menu.app"
executable="$app/Contents/MacOS/RoundhouseMenu"
installed_app="$HOME/Applications/Roundhouse Menu.app"
installed_executable="$installed_app/Contents/MacOS/RoundhouseMenu"
agents="$HOME/Library/LaunchAgents"
support="$HOME/Library/Application Support/Roundhouse"
action="${1:-build}"

build() {
  mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
  xcrun swiftc -parse-as-library "$repo/macos/RoundhouseMenu/main.swift" -o "$executable" -framework AppKit -framework UserNotifications
  cp "$repo/macos/RoundhouseMenu/Info.plist" "$app/Contents/Info.plist"
  cp "$repo/macos/RoundhouseMenu/status-light.svg" "$app/Contents/Resources/status-light.svg"
  cp "$repo/macos/RoundhouseMenu/status-dark.svg" "$app/Contents/Resources/status-dark.svg"
  codesign --force --deep --sign - "$app"
  codesign --verify --deep --strict "$app"
}

case "$action" in
  build) build; print "$app" ;;
  run) build; open "$app" ;;
  install)
    build
    mkdir -p "$agents" "$support/menu-rollbacks" "$HOME/Applications"
    rollback=""
    if [[ -d "$installed_app" ]]; then
      rollback="$support/menu-rollbacks/Roundhouse Menu.$(date -u '+%Y%m%dT%H%M%SZ').app"
      mv "$installed_app" "$rollback"
    fi
    /usr/bin/ditto "$app" "$installed_app"
    codesign --verify --deep --strict "$installed_app"
    stage="$(mktemp -d)"
    trap 'rm -rf "$stage"' EXIT
    node "$repo/scripts/macos/generate.mjs" "$stage" "$repo" "$(command -v node)" "$HOME" "$installed_executable"
    cp "$stage/io.roundhouse.menu.plist" "$agents/io.roundhouse.menu.plist"
    launchctl bootout "gui/$UID/io.roundhouse.menu" 2>/dev/null || true
    if ! launchctl bootstrap "gui/$UID" "$agents/io.roundhouse.menu.plist"; then
      print -u2 "Initial menu bootstrap failed; clearing the stale registration and retrying once."
      launchctl bootout "gui/$UID/io.roundhouse.menu" 2>/dev/null || true
      launchctl bootstrap "gui/$UID" "$agents/io.roundhouse.menu.plist"
    fi
    launchctl kickstart -k "gui/$UID/io.roundhouse.menu"
    launchctl print "gui/$UID/io.roundhouse.menu" >/dev/null
    print "Roundhouse menu helper installed at login.${rollback:+ Rollback: $rollback}"
    ;;
  uninstall)
    launchctl bootout "gui/$UID/io.roundhouse.menu" 2>/dev/null || true
    rm -f "$agents/io.roundhouse.menu.plist"
    print "Roundhouse menu login helper removed."
    ;;
  *) print -u2 "Usage: menu-bar.sh <build|run|install|uninstall>"; exit 64 ;;
esac
