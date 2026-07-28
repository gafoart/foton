#!/usr/bin/env node
// One-time per-machine bootstrap. Works on Windows and macOS without bash or
// admin rights.
//
//   node scripts/setup.mjs
//
// Strategy:
//   1. If pnpm is already on PATH at the right version, skip ahead.
//   2. Otherwise install it via `npm install -g pnpm@<version>` (npm's user
//      prefix is writable on both OSes; corepack `enable` would need admin
//      on Windows because Node lives under `C:\Program Files`).
//   3. Run `pnpm install`.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const pm = pkg.packageManager;
if (!pm || !pm.startsWith("pnpm@")) {
  console.error(`[setup] package.json packageManager must be pnpm@<version> (got ${pm ?? "<missing>"})`);
  process.exit(1);
}
const wantVersion = pm.slice("pnpm@".length);
const isWindows = process.platform === "win32";

function run(cmd, args, { allowFail = false } = {}) {
  console.log(`[setup] $ ${cmd} ${args.join(" ")}`);
  // shell:true on Windows resolves `.cmd` shims (npm.cmd, pnpm.cmd) without
  // hard-coding the extension. Node 20+ requires this for .cmd targets.
  const result = spawnSync(cmd, args, {
    stdio: "inherit",
    cwd: repoRoot,
    shell: isWindows,
  });
  if (result.error) {
    if (allowFail) return { ok: false };
    console.error(`[setup] failed: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    if (allowFail) return { ok: false, code: result.status };
    process.exit(result.status ?? 1);
  }
  return { ok: true };
}

function captureVersion(cmd) {
  const result = spawnSync(cmd, ["--version"], { shell: isWindows });
  if (result.status !== 0) return null;
  return String(result.stdout ?? "").trim();
}

const installedPnpm = captureVersion("pnpm");
if (installedPnpm === wantVersion) {
  console.log(`[setup] pnpm@${wantVersion} already on PATH; skipping install of pnpm itself.`);
} else {
  if (installedPnpm) {
    console.log(`[setup] pnpm@${installedPnpm} on PATH but repo wants ${wantVersion}; installing the right version.`);
  } else {
    console.log(`[setup] pnpm not on PATH; installing pnpm@${wantVersion} via npm.`);
  }
  run("npm", ["install", "-g", `pnpm@${wantVersion}`]);
}

run("pnpm", ["install"]);

console.log(`[setup] done. Use \`pnpm <cmd>\` from here on.`);
