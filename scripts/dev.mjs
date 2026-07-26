import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const children = [
  spawn(process.execPath, ["server/local-api.mjs"], {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  }),
  spawn("npm", ["run", "dev:web"], {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  }),
];

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(code), 1200).unref();
}

for (const child of children) {
  child.on("exit", (code, signal) => {
    if (!stopping && code !== 0) {
      console.error(`Development process exited (${signal ?? code}).`);
      stop(code ?? 1);
    }
  });
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
