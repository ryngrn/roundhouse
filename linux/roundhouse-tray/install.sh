#!/usr/bin/env bash
set -euo pipefail
self="$(cd -- "$(dirname -- "$0")" && pwd)"
dest="$HOME/.local/share/roundhouse-projects"
mkdir -p "$dest" "$HOME/.config/autostart"
install -m 755 "$self/roundhouse-tray.py" "$dest/roundhouse-tray.py"
install -m 644 "$self/roundhouse.svg" "$dest/roundhouse.svg"
cat > "$HOME/.config/autostart/roundhouse-projects.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Version=1.0
Name=Roundhouse Projects
Comment=Open any Roundhouse project in the cloud
Exec=/usr/bin/python3 $dest/roundhouse-tray.py
Icon=$dest/roundhouse.svg
Terminal=false
X-KDE-autostart-after=panel
DESKTOP
chmod 644 "$HOME/.config/autostart/roundhouse-projects.desktop"
echo "Roundhouse KDE tray installed for login."
