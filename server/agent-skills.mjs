import { join } from "node:path";
import { applicationSkillsRoot } from "./application-skills.mjs";

const skillRoot = applicationSkillsRoot();

export const applicationSkillInstructions = `These instructions define how to operate Weave: edit boundaries, source files, saving, and verification.
Presentation composition, visual hierarchy, and design preferences belong to the application skills.
Before creating or revising technical-report slides, read both application-wide skills below.
They are shared by every Weave project; read them from these exact paths, not from the user's
common skill directory or a project-local copy:
- ${join(skillRoot, "technical-report-slides", "SKILL.md")}
- ${join(skillRoot, "author-slide-preferences", "SKILL.md")}
Follow their linked references only when needed. The current human request takes precedence over
stored design preferences. For other presentation styles, use only the skills that fit the request.
These versioned skills are application resources. Do not modify them during ordinary slide edits;
project skill-edit permission does not authorize application-wide changes. The root agent may record verified human preferences only through the dedicated slide-learning tools when learning is enabled; never rewrite these files directly. Report an unreadable
skill rather than silently substituting a personal or project-local skill with the same name.`;
