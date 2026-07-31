import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "generated", "codex-app-server");

await mkdir(output, { recursive: true });
const rawVersion = execFileSync("codex", ["--version"], { encoding: "utf8" }).trim();
const version = rawVersion.match(/\d+\.\d+\.\d+/)?.[0];
if (!version) throw new Error(`Could not parse Codex CLI version from: ${rawVersion}`);

execFileSync("codex", ["app-server", "generate-ts", "--out", output], {
  cwd: root,
  stdio: "inherit",
});
await writeFile(
  resolve(output, "version.json"),
  `${JSON.stringify({ cliVersion: version }, null, 2)}\n`,
);
console.log(`Generated Codex app-server bindings for ${version}.`);
