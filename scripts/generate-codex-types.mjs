/* Regenerates the app-server bindings from whichever Codex CLI is on PATH.

   The app-server API grows and shifts with each CLI release, so running this is one step of a
   longer procedure. When bumping the CLI version:

   1. Update the Codex CLI.
   2. Run this script.
   3. Read the generated diff.
   4. Sort what changed into stable / beta / experimental / deprecated.
   5. Update the reducer's unknown-event fixtures for anything new.
   6. Turn on only the APIs Weave actually adopts.

   Anything the official docs mark as under development or experimental does not become a
   production dependency just because it appeared in the generated types. */

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
