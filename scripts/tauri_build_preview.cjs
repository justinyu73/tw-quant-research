#!/usr/bin/env node
/* Cross-platform launcher for Tauri's beforeBuildCommand. */
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const script = path.join(root, "scripts", "build_dashboard_preview.py");
const candidates = process.platform === "win32"
  ? [["py", ["-3"]], ["python", []]]
  : [["python3", []], ["python", []]];

for (const [command, prefix] of candidates) {
  const result = spawnSync(command, [...prefix, script], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error && result.error.code === "ENOENT") continue;
  if (result.status === 0) process.exit(0);
  process.exit(result.status || 1);
}

console.error("TQR requires Python 3 to build the dashboard preview.");
process.exit(1);
