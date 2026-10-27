import { spawnSync } from "node:child_process";

const version = "2.12.4";

function cargo(args) {
  return spawnSync("cargo", args, {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
}

const probe = cargo(["tauri", "--version"]);
if (probe.status === 0) {
  process.exit(0);
}

if (process.env.CI !== "true") {
  console.error(
    `Tauri CLI is not installed. Install cargo-tauri ${version} or run this build in CI.`,
  );
  process.exit(1);
}

console.log(`Tauri CLI not found; installing cargo-tauri ${version} for CI...`);
const install = cargo(["install", "tauri-cli", "--version", version, "--locked"]);
if (install.status !== 0) {
  process.exit(install.status ?? 1);
}

const verify = cargo(["tauri", "--version"]);
process.exit(verify.status ?? 1);
