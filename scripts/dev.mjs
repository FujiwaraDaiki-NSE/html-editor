import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfiguredHost, resolveWebPort } from "./dev-port.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webHost = parseConfiguredHost(process.env.WEAVE_WEB_HOST ?? "127.0.0.1");
const webPort = await resolveWebPort(process.env.WEAVE_WEB_PORT, webHost);
const childEnv = { ...process.env, WEAVE_WEB_HOST: webHost, WEAVE_WEB_PORT: String(webPort) };
console.log(`Weave web: http://${webHost}:${webPort}`);
const children = [
  spawn(process.execPath, ["server/local-api.mjs"], {
    cwd: root,
    stdio: "inherit",
    env: childEnv,
  }),
  spawn("npm", ["run", "dev:web", "--", "--hostname", webHost, "--port", String(webPort)], {
    cwd: root,
    stdio: "inherit",
    env: childEnv,
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
