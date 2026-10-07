export const REMOTE_DESKTOP_COMMANDER_PERMITTED_USES = Object.freeze([
  "transport",
  "inspection",
  "connectivity_check",
  "bootstrap",
  "emergency_repair",
]);

const normalize = (value) => String(value).toLowerCase().replace(/[^a-z0-9]/g, "");
const commandTokens = (value) => String(value).split(/[\s;&|()<>]+/).map((token) => token.replace(/^["']+|["']+$/g, "")).filter(Boolean);

function isRemoteDesktopCommanderToken(value) {
  const text = String(value);
  const normalized = normalize(text);
  const basename = normalize(text.split(/[\\/]/).pop());
  return basename === "rdc" || basename === "remotedesktopcommander" || normalized === "remotedesktopcommander";
}

export function isRemoteDesktopCommanderCommand(command) {
  if (!Array.isArray(command)) return false;
  return command.some((argument) => isRemoteDesktopCommanderToken(argument) ||
    commandTokens(argument).some(isRemoteDesktopCommanderToken));
}

export function assertNotRemoteDesktopCommanderCommand(command, boundary) {
  if (isRemoteDesktopCommanderCommand(command)) {
    throw new Error(`${boundary} cannot use Remote Desktop Commander. It is reserved for transport, inspection, connectivity checks, bootstrap, and emergency repair; substantial project work must enter Roundhouse and use an authorized execution runtime.`);
  }
}
