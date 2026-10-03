import path from "node:path";

const escapeXml = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const strings = (values) => values.map((value) => `    <string>${escapeXml(value)}</string>`).join("\n");

export function serviceLaunchAgent({ node, repository, home }) {
  const support = `${home}/Library/Application Support/Roundhouse`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>io.roundhouse.service</string>
  <key>ProgramArguments</key><array>
${strings(["/bin/zsh", `${repository}/scripts/macos/service-wrapper.sh`, node, repository])}
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>ROUNDHOUSE_STATE_DIR</key><string>${escapeXml(`${support}/state`)}</string>
    <key>ROUNDHOUSE_CONFIG</key><string>${escapeXml(`${support}/projects.yaml`)}</string>
    <key>PATH</key><string>${escapeXml(`${path.dirname(node)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`)}</string>
  </dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${escapeXml(`${support}/service.log`)}</string>
  <key>StandardErrorPath</key><string>${escapeXml(`${support}/service-error.log`)}</string>
</dict></plist>\n`;
}

export function frontDoorLaunchDaemon({ node, repository }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>io.roundhouse.front-door</string>
  <key>ProgramArguments</key><array>
${strings([node, `${repository}/src/server/front-door.js`])}
  </array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/var/log/roundhouse-front-door.log</string>
  <key>StandardErrorPath</key><string>/var/log/roundhouse-front-door-error.log</string>
</dict></plist>\n`;
}

export function menuLaunchAgent({ executable, home }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>io.roundhouse.menu</string>
  <key>ProgramArguments</key><array>${strings([executable])}</array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${escapeXml(`${home}/Library/Application Support/Roundhouse/menu.log`)}</string>
  <key>StandardErrorPath</key><string>${escapeXml(`${home}/Library/Application Support/Roundhouse/menu-error.log`)}</string>
</dict></plist>\n`;
}

export const hostsBlock = "# BEGIN ROUNDHOUSE\n127.0.0.1 roundhouse\n# END ROUNDHOUSE\n";
