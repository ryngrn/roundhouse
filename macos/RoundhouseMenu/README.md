# Roundhouse Control Center for macOS

The macOS menu bar companion is a native SwiftUI popover. It reads the locally authoritative Roundhouse engine via `http://127.0.0.1:8787/api/local-snapshot`, including needs-you, ready, active, completed, blocked, and recent attention items. The public dashboard is the sole browser interface, linked at `https://roundhouse.ryan.green/`.

The native client does not fetch from `http://roundhouse` and does not depend on the retired front-door hostname. It refreshes on opening and every 30 seconds, with manual refresh available. It displays a connection error rather than false zero counts if the engine is unreachable. It does not dispatch jobs on its own.

Build on the Mac Studio:

```sh
swiftc -parse-as-library -O -framework AppKit -framework SwiftUI macos/RoundhouseMenu/main.swift -o /tmp/RoundhouseMenu-new
```

Install into an existing user-owned app bundle by booting out the menu's user LaunchAgent, copying the binary, and bootstrapping the LaunchAgent again. Keep the previous executable as a rollback. Do not re-sign the bundle after replacing the executable; this Mac's installed LaunchAgent has previously rejected an altered bundle signature with `Launch Constraint Violation`.

The localhost browser front-door runs as a separate system LaunchDaemon and must be decommissioned separately with administrator authorization. Do not stop the local engine on port 8787.
