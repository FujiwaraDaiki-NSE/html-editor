import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { consolidateApplicationSlideSkills, initializeApplicationSkills } from "../server/application-skills.mjs";
import { listSkills, updateSkill, parseSkillDocument } from "../server/skills.mjs";

// Run with the app stopped so maintenance cannot race a slide-learning turn.
export async function consolidateSlideSkills({ applicationRoot, editorRoot }) {
  for (const path of [applicationRoot, editorRoot]) {
    if (typeof path !== "string" || !isAbsolute(path)) throw new Error("Explicit absolute application and editor skill roots are required.");
  }
  process.env.WEAVE_APPLICATION_SKILLS_ROOT = applicationRoot;
  process.env.WEAVE_SKILLS_ROOT = editorRoot;
  const legacyHashes = JSON.parse(await readFile(new URL("../server/slide-skill-legacy.json", import.meta.url), "utf8"));
  const target = parseSkillDocument(await readFile(new URL("../skills/slide-authoring/SKILL.md", import.meta.url), "utf8"), "slide-authoring");
  const old = (await listSkills(editorRoot)).find(({ name }) => name === "slide-authoring");
  // Preflight the editor copy before committing changes to the application store.
  if (old && (!old.valid || (old.body !== target.body && createHash("sha256").update(old.body).digest("hex") !== legacyHashes[old.name].bodyHash))) {
    throw new Error("The editor slide-authoring has custom instructions; review it manually before consolidation.");
  }
  const { revision } = await initializeApplicationSkills();
  const result = await consolidateApplicationSlideSkills(revision);
  if (old && old.body !== target.body) {
    // Preserve the exact former document beside its existing references. The pointer contains no duplicate rules.
    const archive = join(editorRoot, old.name, "references", "before-consolidation.md");
    const references = join(editorRoot, old.name, "references");
    await mkdir(references, { recursive: true });
    const directory = await lstat(references);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("The legacy reference directory must be a regular directory.");
    try { await writeFile(archive, old.content, { flag: "wx", mode: 0o600 }); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const file = await lstat(archive);
      if (!file.isFile() || file.isSymbolicLink() || await readFile(archive, "utf8") !== old.content) throw error;
    }
    await updateSkill(editorRoot, { scope: "editor", currentName: old.name, name: old.name, description: target.description, body: target.body, frontmatter: old.frontmatter, expectedContent: old.content });
  }
  return { ...result, editorUpdated: Boolean(old && old.body !== target.body) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { "application-root": { type: "string" }, "editor-root": { type: "string" }, apply: { type: "boolean" } } });
  if (values.apply !== true) throw new Error("Use --apply with explicit --application-root and --editor-root after stopping the app. No files were changed.");
  console.log(JSON.stringify(await consolidateSlideSkills({ applicationRoot: values["application-root"], editorRoot: values["editor-root"] })));
}
