import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureSkillProposal, listSkillProposals, proposalInputPath, resetSkillProposal, resolveSkillProposal } from "../server/skill-proposals.mjs";
import { createSkill, listSkills, setEditorSkillEnabled, updateSkill } from "../server/skills.mjs";

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "weave-proposal-"));
  const root = join(home, "deck");
  await mkdir(join(root, ".weave"), { recursive: true });
  process.env.WEAVE_SKILLS_ROOT = join(home, "editor", "skills");
  t.after(async () => { delete process.env.WEAVE_SKILLS_ROOT; await rm(home, { recursive: true, force: true }); });
  const input = { targetName: null, name: "preserve-meaning", description: "When rewriting slides", body: "Keep reasons and examples.", reason: "The preference applies to future explanations.", evidence: "意味を削らずに書いてください。" };
  const propose = async (changes = {}) => {
    await writeFile(proposalInputPath(root), JSON.stringify({ ...input, ...changes }));
    return captureSkillProposal(root, { threadId: "thread-1", turnId: "turn-1" });
  };
  return { root, input, propose };
}

test("proposal waits for an explicit decision, persists, and applies exactly once", async (t) => {
  const { root, propose } = await fixture(t);
  assert.equal(await captureSkillProposal(root, { threadId: "thread-1", turnId: "turn-0" }), null);
  const proposal = await propose();
  assert.deepEqual(await listSkills(root), []);
  assert.equal((await listSkillProposals(root))[0].id, proposal.id);
  await resolveSkillProposal(root, proposal.id, "accept");
  assert.equal((await listSkills(root))[0].body, proposal.body);
  assert.deepEqual(await listSkillProposals(root), []);
  await assert.rejects(resolveSkillProposal(root, proposal.id, "accept"), /already been resolved/);
});

test("dismissed learning does not change skills or reappear for the same contents", async (t) => {
  const { root, propose } = await fixture(t);
  const proposal = await propose();
  await resolveSkillProposal(root, proposal.id, "dismiss");
  assert.deepEqual(await listSkills(root), []);
  assert.equal(await propose(), null);
  assert.deepEqual(await listSkillProposals(root), []);
});

test("updates preserve metadata and disabled state, and reject stale proposals", async (t) => {
  const { root, propose } = await fixture(t);
  const original = await createSkill(root, { scope: "editor", name: "preserve-meaning", description: "Existing", body: "Keep conditions.", frontmatter: "license: MIT" });
  await setEditorSkillEnabled(root, original.name, false);
  const proposal = await propose({ targetName: original.name, body: "Keep conditions, reasons and examples." });
  assert.equal(proposal.previousBody, "Keep conditions.");
  await resolveSkillProposal(root, proposal.id, "accept");
  const [updated] = await listSkills(root);
  assert.equal(updated.enabled, false);
  assert.equal(updated.frontmatter, "license: MIT");
  const stale = await propose({ targetName: original.name, body: "Another proposed rule." });
  await updateSkill(root, { scope: "editor", currentName: original.name, name: original.name, description: "Manual", body: "A newer manual edit.", frontmatter: "license: MIT" });
  await assert.rejects(resolveSkillProposal(root, stale.id, "accept"), /changed after this proposal/);
  assert.equal((await listSkills(root))[0].body, "A newer manual edit.");
  assert.equal((await listSkillProposals(root))[0].id, stale.id);
});

test("malformed proposals and stale turn input cannot become shared instructions", async (t) => {
  const { root, propose } = await fixture(t);
  await assert.rejects(propose({ evidence: "" }), /evidence is invalid/);
  await assert.rejects(propose({ name: "../escape" }), /lowercase kebab-case/);
  await writeFile(proposalInputPath(root), "{invalid");
  await assert.rejects(captureSkillProposal(root, { threadId: "thread-1", turnId: "turn-2" }));
  await writeFile(proposalInputPath(root), "stale input");
  await resetSkillProposal(root);
  await assert.rejects(readFile(proposalInputPath(root)), { code: "ENOENT" });
  assert.deepEqual(await listSkillProposals(root), []);
  assert.deepEqual(await listSkills(root), []);
});
