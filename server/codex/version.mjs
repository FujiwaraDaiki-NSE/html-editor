import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

export function parseCodexVersion(output) {
  return String(output).match(/\d+\.\d+\.\d+/)?.[0] ?? null;
}

export async function checkGeneratedVersion(versionFile, { exec = execFileSync } = {}) {
  const generated = JSON.parse(await readFile(versionFile, "utf8"));
  const running = parseCodexVersion(exec("codex", ["--version"], { encoding: "utf8" }));
  if (!running) throw new Error("Could not determine the running Codex CLI version.");
  return {
    compatible: running === generated.cliVersion,
    running,
    generated: generated.cliVersion,
    message: running === generated.cliVersion
      ? null
      : `Generated app-server bindings target ${generated.cliVersion}, but Codex CLI ${running} is running. Run npm run codex:generate.`,
  };
}
