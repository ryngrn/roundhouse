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

export function dispatchLaunchAgent({ home }) {
  const support = `${home}/Library/Application Support/Roundhouse`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>io.roundhouse.dispatch</string>
  <key>ProgramArguments</key><array>
${strings(["/usr/bin/curl", "--noproxy", "*", "--fail", "--silent", "--show-error", "--connect-timeout", "5", "--max-time", "7500", "--request", "POST", "--header", "Origin: http://127.0.0.1:8787", "--header", "Content-Type: application/json", "--data", "{}", "http://127.0.0.1:8787/api/worker/tick"])}
  </array>
  <key>RunAtLoad</key><true/><key>StartInterval</key><integer>300</integer>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${escapeXml(`${support}/dispatch.log`)}</string>
  <key>StandardErrorPath</key><string>${escapeXml(`${support}/dispatch-error.log`)}</string>
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
