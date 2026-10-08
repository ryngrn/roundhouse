#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { dispatchLaunchAgent, serviceLaunchAgent, menuLaunchAgent } from "../../src/install/macos.js";

const [output, repository, node, home, menuExecutable] = process.argv.slice(2);
if (![output, repository, node, home].every(Boolean)) throw new Error("Usage: generate.mjs <output> <repository> <node> <home> [menu-executable]");
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, "io.roundhouse.service.plist"), serviceLaunchAgent({ node, repository, home }));
fs.writeFileSync(path.join(output, "io.roundhouse.dispatch.plist"), dispatchLaunchAgent({ home }));
if (menuExecutable) fs.writeFileSync(path.join(output, "io.roundhouse.menu.plist"), menuLaunchAgent({ executable: menuExecutable, home }));
