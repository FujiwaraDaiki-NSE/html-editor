/* Check generated app-server bindings without changing the checked-in output.

   A generated binding set is tied to the Codex CLI that produced it. This command
   creates a temporary output directory and compares the protocol files. Matching
   output is removed immediately; differing output is retained in the system temp
   directory so its actual signatures can be reviewed. It is intentionally separate
   from codex:generate, which is the explicit update operation.
 */

import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkedIn = resolve(root, "generated", "codex-app-server");
const temporary = await mkdtemp(join(tmpdir(), "weave-codex-types-"));
let retainTemporary = false;

async function filesUnder(rootDirectory) {
  async function collect(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) files.push(...await collect(path));
      else if (entry.isFile() && entry.name !== "version.json") files.push(relative(rootDirectory, path));
    }
    return files;
  }
  return await collect(rootDirectory);
}

try {
  execFileSync("codex", ["app-server", "generate-ts", "--out", temporary], {
    cwd: root,
    stdio: "inherit",
  });
  const [expected, actual] = await Promise.all([filesUnder(checkedIn), filesUnder(temporary)]);
  const names = [...new Set([...expected, ...actual])].sort();
  const differences = [];
  for (const name of names) {
    const [left, right] = await Promise.all([
      readFile(join(checkedIn, name), "utf8").catch(() => null),
      readFile(join(temporary, name), "utf8").catch(() => null),
    ]);
    if (left !== right) differences.push(name);
  }
  if (differences.length > 0) {
    retainTemporary = true;
    console.error(`Codex app-server protocol differs in ${differences.length} file(s):`);
    for (const name of differences) console.error(`  ${name}`);
    console.error(`Generated comparison files retained at ${temporary}`);
    console.error(`Review with: diff -ru --exclude=version.json ${checkedIn} ${temporary}`);
    console.error("Run npm run codex:generate only when intentionally updating checked-in bindings.");
    process.exitCode = 1;
  } else {
    console.log("Codex app-server generated protocol matches the checked-in bindings.");
  }
} finally {
  if (!retainTemporary) await rm(temporary, { recursive: true, force: true });
}
