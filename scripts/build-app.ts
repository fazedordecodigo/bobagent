import { spawnSync } from "node:child_process";

const bundles: Record<string, string> = {
  darwin: "app",
  linux: "appimage,deb",
  win32: "nsis",
};
const targetBundles = bundles[process.platform];
if (!targetBundles) {
  console.error(`Unsupported app build platform: ${process.platform}`);
  process.exitCode = 1;
} else {
  for (const args of [
    ["run", "build:daemon"],
    ["run", "--cwd", "apps/desktop", "tauri", "build", "--debug", "--bundles", targetBundles],
  ]) {
    const result = spawnSync("bun", args, { stdio: "inherit" });
    if (result.error) {
      console.error(result.error.message);
      process.exitCode = 1;
      break;
    }
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
      break;
    }
  }
}
