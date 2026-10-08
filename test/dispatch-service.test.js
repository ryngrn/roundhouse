import fs from "node:fs";
import assert from "node:assert/strict";
import {test} from "node:test";

test("five-minute dispatcher runs one bounded Depot triage before verified execution", () => {
  const wrapper=fs.readFileSync(new URL("../scripts/macos/dispatch-once.sh",import.meta.url),"utf8");
  const installer=fs.readFileSync(new URL("../scripts/macos/install-dispatch-service.sh",import.meta.url),"utf8");
  const triage=fs.readFileSync(new URL("../scripts/macos/triage-once.mjs",import.meta.url),"utf8");
  assert.ok(wrapper.indexOf('triage-once.mjs') < wrapper.indexOf('depot dispatch'));
  assert.match(installer,/install -m 700.*triage-once\.mjs/);
  assert.match(triage,/acquireLock\(store\.workerLock\)/);
  assert.match(triage,/await engine\.decide\(current\.id\)/);
  assert.match(triage,/if \(active \|\| !job\)/);
  assert.doesNotMatch(triage,/engine\.run\(/);
  assert.match(triage,/process\.argv\.includes\("--dry-run"\)/);
});
