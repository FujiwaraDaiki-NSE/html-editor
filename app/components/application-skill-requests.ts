export type SkillScope = "application" | "project" | "common";
export type SkillEntry = {
  name: string;
  description: string;
  body: string;
  content: string;
  frontmatter: string | null;
  scope: SkillScope;
  location: SkillScope;
  path: string;
  filePath: string;
  valid: boolean;
  error: string | null;
  revision?: string;
  capabilities?: { edit: boolean; history: boolean; restore: boolean; delete: boolean; move: boolean };
};
export type ApplicationSkillEntry = SkillEntry & { scope: "application"; revision: string };
export type SkillHistoryEntry = { id: string; shortId: string; message: string; date: string };
export type SkillHistory = { revision: string; entries: SkillHistoryEntry[] };
export type ApplicationSkillMutation = { skill: ApplicationSkillEntry; skills: SkillEntry[]; project: { clean: boolean; revision?: string; commit: string } };
export type LearningState = {
  enabled: boolean;
  revision: string;
  capabilities: { configure: boolean };
  unavailableReason: string | null;
  lastOutcome: null | { status: "learned" | "candidate" | "unchanged" | "skipped" | "failed"; at: string; reason: string; ruleId: string | null; threadId: string | null; turnId: string | null };
};

export class SkillRequestError extends Error {
  kind: "conflict" | "rejected" | "unknown";
  constructor(message: string, kind: "conflict" | "rejected" | "unknown") {
    super(message);
    this.kind = kind;
  }
}

const endpoint = (name: string) => `/api/skills/application/${encodeURIComponent(name)}`;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object";

export function isApplicationSkill(value: unknown): value is ApplicationSkillEntry {
  return record(value) && value.scope === "application" && typeof value.name === "string"
    && typeof value.description === "string" && typeof value.body === "string" && typeof value.content === "string"
    && (value.frontmatter === null || typeof value.frontmatter === "string")
    && value.location === "application" && typeof value.path === "string" && typeof value.filePath === "string"
    && typeof value.valid === "boolean" && (value.error === null || typeof value.error === "string")
    && typeof value.revision === "string" && value.revision.length > 0;
}

async function readResponse(response: Response, mutation: boolean): Promise<Record<string, unknown>> {
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new SkillRequestError(mutation ? "保存結果を確認できません。最新の内容を読み直して確認してください。" : "スキルの応答を読み取れませんでした。", mutation ? "unknown" : "rejected");
  }
  if (!response.ok) {
    if (response.status === 409) throw new SkillRequestError("ほかの変更が保存されています。最新の内容を読み直してから、変更を確認してください。", "conflict");
    throw new SkillRequestError(record(result) && typeof result.error === "string" ? result.error : "スキルの操作を完了できませんでした。", "rejected");
  }
  if (!record(result)) throw new SkillRequestError(mutation ? "保存結果を確認できません。最新の内容を読み直して確認してください。" : "スキルの応答が不正です。", mutation ? "unknown" : "rejected");
  return result;
}

export async function readApplicationSkillHistory(name: string, signal?: AbortSignal): Promise<SkillHistory> {
  const result = await readResponse(await fetch(`${endpoint(name)}/history`, { signal }), false);
  if (typeof result.revision !== "string" || !Array.isArray(result.entries) || !result.entries.every((entry) => record(entry) && ["id", "shortId", "message", "date"].every((key) => typeof entry[key] === "string"))) throw new SkillRequestError("変更履歴の応答が不正です。", "rejected");
  return result as SkillHistory;
}

export async function readApplicationSkillVersion(name: string, commit: string, signal?: AbortSignal): Promise<{ revision: string; skill: ApplicationSkillEntry }> {
  const result = await readResponse(await fetch(`${endpoint(name)}/version?commit=${encodeURIComponent(commit)}`, { signal }), false);
  if (typeof result.revision !== "string" || !isApplicationSkill(result.skill) || result.skill.name !== name) throw new SkillRequestError("過去の内容の応答が不正です。", "rejected");
  return result as { revision: string; skill: ApplicationSkillEntry };
}

export async function mutateApplicationSkill(name: string, action: "update" | "restore", payload: Record<string, unknown>): Promise<ApplicationSkillMutation> {
  let response: Response;
  try {
    response = await fetch(action === "restore" ? `${endpoint(name)}/restore` : endpoint(name), { method: action === "restore" ? "POST" : "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  } catch {
    throw new SkillRequestError("保存結果を確認できません。最新の内容を読み直して確認してください。", "unknown");
  }
  const result = await readResponse(response, true);
  if (!isApplicationSkill(result.skill) || result.skill.name !== name || !Array.isArray(result.skills) || !record(result.project) || typeof result.project.clean !== "boolean" || typeof result.project.commit !== "string") throw new SkillRequestError("保存結果を確認できません。最新の内容を読み直して確認してください。", "unknown");
  return result as ApplicationSkillMutation;
}

function isLearningState(value: unknown): value is LearningState {
  if (!record(value) || typeof value.enabled !== "boolean" || typeof value.revision !== "string" || !value.revision || !record(value.capabilities) || typeof value.capabilities.configure !== "boolean" || (value.unavailableReason !== null && typeof value.unavailableReason !== "string")) return false;
  if (value.lastOutcome === null) return true;
  const outcome = value.lastOutcome;
  return record(outcome) && ["learned", "candidate", "unchanged", "skipped", "failed"].includes(String(outcome.status))
    && typeof outcome.at === "string" && typeof outcome.reason === "string"
    && ["ruleId", "threadId", "turnId"].every((key) => outcome[key] === null || typeof outcome[key] === "string");
}

export async function readLearningState(signal?: AbortSignal): Promise<LearningState> {
  const result = await readResponse(await fetch("/api/skills/learning", { signal }), false);
  if (!isLearningState(result)) throw new SkillRequestError("自動学習の設定を読み取れませんでした。", "rejected");
  return result;
}

export async function updateLearningState(enabled: boolean, expectedRevision: string): Promise<LearningState> {
  let response: Response;
  try {
    response = await fetch("/api/skills/learning", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled, expectedRevision }) });
  } catch {
    throw new SkillRequestError("設定の保存結果を確認できません。最新の設定を読み直してください。", "unknown");
  }
  const result = await readResponse(response, true);
  if (!isLearningState(result) || result.enabled !== enabled) throw new SkillRequestError("設定の保存結果を確認できません。最新の設定を読み直してください。", "unknown");
  return result;
}
