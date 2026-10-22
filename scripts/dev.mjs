import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LOOPBACK_WEB_HOST, parseConfiguredHost, resolveWebPort } from "./dev-port.mjs";
import { startLoopbackForwarder } from "./loopback-forwarder.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webHost = parseConfiguredHost(process.env.WEAVE_WEB_HOST ?? LOOPBACK_WEB_HOST);
const webHosts = webHost === LOOPBACK_WEB_HOST ? [webHost] : [webHost, LOOPBACK_WEB_HOST];
const webPort = await resolveWebPort(process.env.WEAVE_WEB_PORT, webHosts);
const loopbackForwarder = webHost === LOOPBACK_WEB_HOST ? null : await startLoopbackForwarder(webHost, webPort);
const childEnv = { ...process.env, WEAVE_WEB_HOST: webHost, WEAVE_WEB_PORT: String(webPort) };
console.log(`Weave web: http://${webHost}:${webPort}`);
if (loopbackForwarder) console.log(`Weave web: http://localhost:${webPort}`);
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
  if (loopbackForwarder) loopbackForwarder.close();
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
