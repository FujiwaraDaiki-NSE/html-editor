import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createSkill, editorSkillsRoot, listSkills, updateSkill, validateSkillName } from "./skills.mjs";

export const skillProposalInstructions = `After completing the requested work, consider whether the human's corrections reveal a reusable preference or workflow rule. Only propose one when it can improve future decks; do not generalize a one-off fact, project name, number, or layout instruction into a universal rule. Do not ask on every turn or repeat a dismissed suggestion without new evidence.
To propose learning, write .weave/skill-proposal.json with exactly: {"targetName":null,"name":"lowercase-kebab-name","description":"When this rule applies","body":"Complete proposed Markdown instructions","reason":"Why this applies to other decks","evidence":"The human instruction that supports this proposal"}. targetName must be null for a new skill, or the exact existing shared skill name to update. For an update keep name equal to targetName and retain the existing instructions except the intended change. Do not edit any skill file directly. The editor will show the proposed contents and ask whether to save them for all decks; writing a proposal is not approval or a successful save. Do not block the requested slide work while waiting for this decision. If there is no reusable learning, do not create this file.`;

export const proposalInputPath = (root) => join(root, ".weave", "skill-proposal.json");
const reviewPath = (root) => join(dirname(editorSkillsRoot()), "skill-reviews", `${createHash("sha256").update(resolve(root)).digest("hex")}.json`);
const queues = new Map();
async function exclusive(root, operation) {
  const key = reviewPath(root);
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.then(operation);
  queues.set(key, next.catch(() => {}));
  return next;
}
async function readReviews(root) {
  try { return JSON.parse(await readFile(reviewPath(root), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}
async function writeReviews(root, reviews) {
  const path = reviewPath(root);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(reviews));
  await rename(temporary, path);
}
export async function listSkillProposals(root) {
  return (await readReviews(root)).filter((entry) => entry.status === "pending");
}
export async function resetSkillProposal(root) {
  await rm(proposalInputPath(root), { force: true });
}
function requiredText(value, label, limit) {
  if (typeof value !== "string" || !value.trim() || value.length > limit) throw new Error(`Skill proposal ${label} is invalid.`);
  return value;
}
export async function captureSkillProposal(root, { threadId, turnId }) {
  let source;
  try {
    const info = await lstat(proposalInputPath(root));
    if (!info.isFile() || info.isSymbolicLink() || info.size > 100_000) throw new Error("Skill proposal must be a regular file under 100 KB.");
    source = await readFile(proposalInputPath(root), "utf8");
  }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  await resetSkillProposal(root);
  if (source.length > 100_000) throw new Error("Skill proposal is too large.");
  const input = JSON.parse(source);
  if (!Object.hasOwn(input, "targetName")) throw new Error("Skill proposal targetName is required.");
  const name = validateSkillName(input.name);
  const targetName = input.targetName === null ? null : validateSkillName(input.targetName);
  if (targetName !== null && name !== targetName) throw new Error("A skill proposal cannot rename a skill.");
  const skills = await listSkills(root);
  const existing = skills.find((entry) => entry.name === name);
  if (targetName === null && existing) throw new Error("A skill with this name already exists.");
  if (targetName !== null && (!existing || !existing.valid)) throw new Error("The skill to update is unavailable.");
  const proposal = {
    id: randomUUID(), threadId, turnId, status: "pending", targetName, name,
    description: requiredText(input.description, "description", 20_000),
    body: requiredText(input.body, "body", 64_000),
    reason: requiredText(input.reason, "reason", 2_000),
    evidence: requiredText(input.evidence, "evidence", 4_000),
    previousBody: existing ? existing.body : null,
    baseContent: existing ? existing.content : null,
    frontmatter: existing ? existing.frontmatter : null,
  };
  if (existing && existing.body === proposal.body && existing.description === proposal.description) return null;
  return exclusive(root, async () => {
    const reviews = await readReviews(root);
    // An unchanged suggestion already waiting for review is not asked twice.
    if (reviews.some((entry) => entry.name === name && entry.body === proposal.body && entry.status !== "saved")) return null;
    await writeReviews(root, [...reviews, proposal]);
    return proposal;
  });
}
export async function resolveSkillProposal(root, id, action) {
  if (!["accept", "dismiss"].includes(action)) throw new Error("Unknown skill review action.");
  return exclusive(root, async () => {
    const reviews = await readReviews(root);
    const proposal = reviews.find((entry) => entry.id === id);
    if (!proposal || proposal.status !== "pending") throw Object.assign(new Error("This proposal has already been resolved or is unavailable."), { code: "WEAVE_SKILL_CONFLICT" });
    if (action === "accept") {
      const input = { scope: "editor", name: proposal.name, description: proposal.description, body: proposal.body, frontmatter: proposal.frontmatter };
      if (proposal.targetName === null) await createSkill(root, input);
      else await updateSkill(root, { ...input, currentName: proposal.targetName, expectedContent: proposal.baseContent });
      proposal.status = "saved";
    } else proposal.status = "dismissed";
    await writeReviews(root, reviews);
    return proposal;
  });
}
