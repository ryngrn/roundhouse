import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { frontDoorLaunchDaemon, hostsBlock, menuLaunchAgent, serviceLaunchAgent } from "../src/install/macos.js";

test("macOS install configuration is loopback-local, durable, reversible, and path-safe", () => {
  const input = { node: "/opt/homebrew/bin/node", repository: "/Users/Test & Dev/roundhouse", home: "/Users/Test & Dev" };
  const service = serviceLaunchAgent(input);
  const front = frontDoorLaunchDaemon(input);
  const menu = menuLaunchAgent({ executable: "/Applications/Roundhouse Menu.app/Contents/MacOS/RoundhouseMenu", home: input.home });
  assert.match(service, /io\.roundhouse\.service/);
  assert.match(service, /Application Support\/Roundhouse\/projects\.yaml/);
  assert.match(service, /scripts\/macos\/service-wrapper\.sh/);
  assert.doesNotMatch(service, /DATABASE_URL/);
  assert.match(service, /Test &amp; Dev/);
  assert.match(front, /src\/server\/front-door\.js/);
  assert.match(menu, /io\.roundhouse\.menu/);
  assert.equal(hostsBlock, "# BEGIN ROUNDHOUSE\n127.0.0.1 roundhouse\n# END ROUNDHOUSE\n");
});

test("menu bar companion remains a thin native HTTP client with service controls", () => {
  const source = fs.readFileSync("macos/RoundhouseMenu/main.swift", "utf8");
  assert.match(source, /import AppKit/);
  assert.match(source, /http:\/\/roundhouse/);
  assert.match(source, /api\/overview/);
  assert.match(source, /api\/notifications/);
  assert.match(source, /notificationCursor/);
  assert.match(source, /Open Roundhouse/);
  assert.match(source, /Start Service/);
  assert.match(source, /Stop Service/);
  assert.match(source, /Restart Service/);
  assert.match(source, /App service unavailable/);
  assert.match(source, /Front door unavailable/);
  assert.match(source, /Counts unavailable/);
  assert.doesNotMatch(source, /Electron|terminal output/i);
});

test("installer reports success only after direct app and front-door health and exposes repair smoke paths", () => {
  const installer = fs.readFileSync("scripts/macos/install.sh", "utf8");
  const service = fs.readFileSync("scripts/macos/service.sh", "utf8");
  assert.match(installer, /app_health/);
  assert.match(installer, /front_health/);
  assert.match(installer, /wait_for_health "app service"/);
  assert.match(installer, /wait_for_health "front door"/);
  assert.match(installer, /Initial user service bootstrap failed/);
  assert.match(installer, /install\|repair\|smoke/);
  assert.match(service, /repair\)/);
  assert.match(service, /smoke\)/);
  const wrapper = fs.readFileSync("scripts/macos/service-wrapper.sh", "utf8");
  assert.match(wrapper, /neon\.env/);
  assert.match(wrapper, /400\|600/);
  assert.match(wrapper, /unset DATABASE_URL_UNPOOLED NEON_BRANCH/);
});
