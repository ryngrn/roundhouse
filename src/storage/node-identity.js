import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const defaultCapabilities = ["decision", "execution", "verification", "shipping", "mcp-delivery"];

function capabilities(value) {
  if (!value) return defaultCapabilities;
  const parsed = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  return parsed.length ? [...new Set(parsed)].sort() : defaultCapabilities;
}

export function loadNodeIdentity(directory, env = process.env) {
  const root = path.resolve(directory);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const filename = path.join(root, "node-identity.json");
  let stored;
  if (fs.existsSync(filename)) stored = JSON.parse(fs.readFileSync(filename, "utf8"));
  else {
    const generated = { id: randomUUID(), created_at: new Date().toISOString() };
    const temporary = `${filename}.${process.pid}.${generated.id}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(generated, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    try {
      fs.linkSync(temporary, filename);
      stored = generated;
      const directoryFd = fs.openSync(root, "r");
      try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      stored = JSON.parse(fs.readFileSync(filename, "utf8"));
    } finally {
      fs.unlinkSync(temporary);
    }
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(stored.id ?? "") || !stored.created_at) {
    throw new Error(`Invalid node identity: ${filename}`);
  }
  return {
    id: stored.id,
    name: env.ROUNDHOUSE_NODE_NAME?.trim() || os.hostname(),
    capabilities: capabilities(env.ROUNDHOUSE_NODE_CAPABILITIES),
    created_at: stored.created_at,
    identity_file: filename,
  };
}
