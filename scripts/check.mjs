import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
function check(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) check(filename);
    else if (/\.[cm]?js$/.test(filename)) {
      const result = spawnSync(process.execPath, ["--check", filename], { encoding: "utf8" });
      if (result.status !== 0) { process.stderr.write(result.stderr); process.exitCode = 1; }
    }
  }
}
for (const directory of ["src", "test", "scripts"]) check(directory);
