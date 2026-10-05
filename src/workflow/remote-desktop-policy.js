export const REMOTE_DESKTOP_COMMANDER_PERMITTED_USES = Object.freeze([
  "transport",
  "inspection",
  "connectivity_check",
  "bootstrap",
  "emergency_repair",
]);

const normalize = (value) => String(value).toLowerCase().replace(/[^a-z0-9]/g, "");

export function isRemoteDesktopCommanderCommand(command) {
  if (!Array.isArray(command)) return false;
  return command.some((argument) => {
    const text = String(argument);
    const normalized = normalize(text);
    const basename = normalize(text.split(/[\\/]/).pop());
    return basename === "rdc" || normalized === "remotedesktopcommander" ||
      (/[\\/]/.test(text) && normalized.includes("remotedesktopcommander"));
  });
}

export function assertNotRemoteDesktopCommanderCommand(command, boundary) {
  if (isRemoteDesktopCommanderCommand(command)) {
    throw new Error(`${boundary} cannot use Remote Desktop Commander. It is reserved for transport, inspection, connectivity checks, bootstrap, and emergency repair; substantial project work must enter Roundhouse and use an authorized execution runtime.`);
  }
}
