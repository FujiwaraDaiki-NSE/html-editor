import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import { join, relative } from "node:path";
import { assetPathsInHtml } from "../shared/asset-path.mjs";
import { mergeEditorDecks } from "../shared/editor-workflow.mjs";
import {
  readProject,
  readDeckCss,
  readTemplates,
  runProjectExclusive,
  writeProjectUnlocked,
  getRevision,
} from "./project.mjs";

const file = (root) => join(root, ".weave", "slide-proposals.json");
const requiredText = (value) =>
  typeof value === "string" && value.trim().length > 0;
export function validateDirections(directions) {
  if (
    !Array.isArray(directions) ||
    directions.length !== 3 ||
    directions.some(
      (d) =>
        !d ||
        !requiredText(d.title) ||
        d.title.length > 80 ||
        !requiredText(d.description) ||
        d.description.length > 400 ||
        !requiredText(d.instruction) ||
        d.instruction.length > 10000,
    )
  )
    throw new Error(
      "比較には、title・description・instructionを持つ異なる3方向を指定してください。",
    );
  if (new Set(directions.map((d) => d.title.trim())).size !== 3)
    throw new Error("3案の方向性は異なる名前にしてください。");
}
export class SlideProposals {
  constructor({ workspaceRoot, publish, livePreview = () => null }) {
    this.workspaceRoot = workspaceRoot;
    this.publish = publish;
    this.livePreview = livePreview;
  }
  async read(root) {
    try {
      return JSON.parse(await readFile(file(root), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }
  async save(root, groups) {
    await mkdir(join(root, ".weave"), { recursive: true });
    const temp = `${file(root)}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(groups), { mode: 0o600 });
    await rename(temp, file(root));
    this.publish("weave/proposals", { root });
  }
  group(groups, id) {
    const group = groups.find((g) => g.id === id);
    if (!group) throw new Error("提案が見つかりません。");
    return group;
  }
  candidate(group, id) {
    const candidate = group.candidates.find((c) => c.id === id);
    if (!candidate) throw new Error("案が見つかりません。");
    return candidate;
  }
  workspace(group, candidate) {
    return join(this.workspaceRoot, ".proposals", group.id, candidate.id);
  }
  async copyWorkspace(source, destination) {
    await mkdir(destination, { recursive: true });
    for (const entry of await readdir(source, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      if (entry.name === ".weave") {
        await mkdir(join(destination, ".weave"), { recursive: true });
        await cp(
          join(source, ".weave", "deck.json"),
          join(destination, ".weave", "deck.json"),
        );
      } else
        await cp(join(source, entry.name), join(destination, entry.name), {
          recursive: true,
          dereference: false,
        });
    }
    for (const args of [
      ["init", "-b", "main"],
      ["config", "user.name", "Weave"],
      ["config", "user.email", "weave@localhost"],
      ["add", "--all"],
      [
        "commit",
        "-m",
        "Snapshot the common proposal baseline to isolate candidate editing",
      ],
    ])
      execFileSync("git", args, { cwd: destination, stdio: "pipe" });
  }
  async create(root, { threadId, prompt, scope, directions }) {
    validateDirections(directions);
    return await runProjectExclusive(async () => {
      const groups = await this.read(root);
      const baseDeck = await readProject(root);
      const group = {
        id: randomUUID(),
        threadId,
        prompt,
        scope,
        baseDeck,
        createdAt: Date.now(),
        state: "open",
        prepared: false,
        preparationError: null,
        selections: {},
        candidates: directions.map((direction, index) => ({
          id: String.fromCharCode(97 + index),
          title: direction.title,
          description: direction.description,
          instruction: direction.instruction,
          version: 1,
          taskId: null,
          ready: false,
          error: null,
          result: null,
        })),
      };
      groups.push(group);
      await this.save(root, groups);
      // Every candidate starts from the exact same snapshot, including unsaved draft content.
      const baseline = join(
        this.workspaceRoot,
        ".proposals",
        group.id,
        "baseline",
      );
      try {
        await this.copyWorkspace(root, baseline);
        for (const candidate of group.candidates)
          await this.copyWorkspace(baseline, this.workspace(group, candidate));
        group.prepared = true;
      } catch (error) {
        group.preparationError = error.message;
        await this.save(root, groups);
        throw error;
      }
      await this.save(root, groups);
      return group;
    }, root);
  }
  async target(root, { groupId, candidateId, version }) {
    const group = this.group(await this.read(root), groupId);
    const candidate = this.candidate(group, candidateId);
    if (
      group.state !== "open" ||
      !candidate.ready ||
      candidate.version !== version
    )
      throw new Error("案が更新されました。最新の案を開き直してください。");
    return { group, candidate, workspace: this.workspace(group, candidate) };
  }
  async attach(
    root,
    groupId,
    candidateId,
    taskId,
    { revise = false, expectedVersion = null } = {},
  ) {
    return await runProjectExclusive(async () => {
      const groups = await this.read(root);
      const group = this.group(groups, groupId);
      const candidate = this.candidate(group, candidateId);
      if (revise) {
        if (
          !candidate.ready ||
          group.state !== "open" ||
          (expectedVersion !== null && candidate.version !== expectedVersion)
        )
          throw new Error("この案は修正できません。");
        candidate.version++;
      }
      candidate.taskId = taskId;
      candidate.ready = false;
      candidate.error = null;
      await this.save(root, groups);
      return candidate.version;
    }, root);
  }
  async finish(root, groupId, candidateId, task) {
    return await runProjectExclusive(async () => {
      const groups = await this.read(root);
      const group = this.group(groups, groupId);
      const candidate = this.candidate(group, candidateId);
      if (candidate.taskId !== task.id) return;
      candidate.ready = task.status === "completed";
      candidate.error = task.error;
      if (candidate.ready) {
        const workspace = this.workspace(group, candidate);
        candidate.result = {
          deck: await readProject(workspace),
          css: await readDeckCss(workspace),
          templates: await readTemplates(workspace),
          review: task.review,
        };
      }
      await this.save(root, groups);
    }, root);
  }
  async recover(root) {
    await runProjectExclusive(async () => {
      const groups = await this.read(root);
      let changed = false;
      for (const group of groups)
        if (group.prepared === false && !group.preparationError) {
          group.preparationError =
            "準備中にエディターが終了しました。自動再開はしていません。";
          changed = true;
        }
      if (changed) await this.save(root, groups);
    }, root);
  }
  async snapshot(root, tasks) {
    const current = await readProject(root);
    return (await this.read(root)).map((group) => ({
      id: group.id,
      threadId: group.threadId,
      prompt: group.prompt,
      scope: group.scope,
      createdAt: group.createdAt,
      state: group.state,
      preparationError:
        group.preparationError === undefined ? null : group.preparationError,
      selections: group.selections,
      slideIds: group.baseDeck.slides
        .filter(
          (s) =>
            group.scope.kind === "deck" || group.scope.slideIds.includes(s.id),
        )
        .map((s) => s.id),
      candidates: group.candidates.map((candidate) => {
        const task = tasks.find((t) => t.id === candidate.taskId);
        const busy =
          task && !["completed", "failed", "cancelled"].includes(task.status);
        const live = this.livePreview(candidate.taskId);
        const status = group.preparationError
          ? "failed"
          : group.prepared === false
            ? "preparing"
            : candidate.ready
              ? "ready"
              : task
                ? task.status
                : "queued";
        const adoptable = group.state === "open" && candidate.ready && !busy;
        return {
          targetSlideIds:
            group.scope.kind === "deck"
              ? [
                  ...new Set([
                    ...group.baseDeck.slides.map((s) => s.id),
                    ...(candidate.result
                      ? candidate.result.deck.slides.map((s) => s.id)
                      : []),
                  ]),
                ]
              : group.scope.slideIds,
          id: candidate.id,
          title: candidate.title,
          description:
            candidate.description === undefined ? null : candidate.description,
          instruction: candidate.instruction,
          version: candidate.version,
          taskId: candidate.taskId,
          status,
          previewRevision: `${candidate.version}:${candidate.taskId}:${live === null ? "baseline" : live.revision}:${candidate.ready ? "reviewed" : "draft"}`,
          activity: task ? task.activity : null,
          startedAt: task?.startedAt === undefined ? null : task.startedAt,
          workerStartedAt:
            task?.workerStartedAt === undefined ? null : task.workerStartedAt,
          finishedAt: task?.finishedAt === undefined ? null : task.finishedAt,
          error:
            group.preparationError ?? candidate.error ?? task?.error ?? null,
          stale: JSON.stringify(current) !== JSON.stringify(group.baseDeck),
          available: {
            view: group.prepared !== false,
            adopt: adoptable,
            revise: adoptable,
            dismiss:
              group.state === "open" &&
              !group.candidates.some((c) => {
                const t = tasks.find((t) => t.id === c.taskId);
                return (
                  t && !["completed", "failed", "cancelled"].includes(t.status)
                );
              }),
          },
        };
      }),
    }));
  }
  async preview(root, groupId, candidateId, version) {
    const group = this.group(await this.read(root), groupId);
    const candidate = this.candidate(group, candidateId);
    if (group.prepared === false || candidate.version !== version)
      throw new Error("表示できる最新の案を選んでください。");
    const live = this.livePreview(candidate.taskId);
    const previewRevision = `${candidate.version}:${candidate.taskId}:${live === null ? "baseline" : live.revision}:${candidate.ready ? "reviewed" : "draft"}`;
    const identity = {
      groupId,
      candidateId,
      version,
      baseDeck: group.baseDeck,
      previewRevision,
    };
    if (candidate.ready && candidate.result)
      return {
        ...candidate.result,
        ...identity,
        reviewed: true,
        phase: "reviewed",
      };
    if (live !== null)
      return {
        deck: live.deck,
        css: live.css,
        templates: live.templates,
        review: null,
        ...identity,
        reviewed: false,
        phase: "working",
      };
    if (candidate.result)
      return {
        ...candidate.result,
        ...identity,
        reviewed: false,
        phase: "previous",
      };
    const baseline = join(
      this.workspaceRoot,
      ".proposals",
      group.id,
      "baseline",
    );
    return {
      deck: group.baseDeck,
      css: await readDeckCss(baseline),
      templates: await readTemplates(baseline),
      review: null,
      ...identity,
      reviewed: false,
      phase: "baseline",
    };
  }

  async adopt(
    root,
    { groupId, candidateId, version, slideIds, expectedRevision },
    tasks,
  ) {
    if (
      !Array.isArray(slideIds) ||
      !slideIds.length ||
      new Set(slideIds).size !== slideIds.length
    )
      throw new Error("採用するスライドを指定してください。");
    return await runProjectExclusive(async () => {
      if (expectedRevision !== getRevision(root))
        throw Object.assign(
          new Error(
            "資料が更新されました。最新の内容を確認してから採用してください。",
          ),
          { code: "WEAVE_REVISION_CONFLICT" },
        );
      const groups = await this.read(root);
      const group = this.group(groups, groupId);
      const candidate = this.candidate(group, candidateId);
      if (
        group.state !== "open" ||
        !candidate.ready ||
        candidate.version !== version ||
        !tasks.some(
          (t) =>
            t.id === candidate.taskId &&
            t.status === "completed" &&
            t.approvedVersion === t.version,
        )
      )
        throw new Error("レビュー済みの最新の案だけ採用できます。");
      const targets =
        group.scope.kind === "deck"
          ? [
              ...new Set([
                ...group.baseDeck.slides.map((s) => s.id),
                ...candidate.result.deck.slides.map((s) => s.id),
              ]),
            ]
          : group.scope.slideIds;
      if (slideIds.some((id) => !targets.includes(id)))
        throw new Error("採用範囲が提案の対象を超えています。");
      if (slideIds.some((id) => group.selections[id]))
        throw new Error(
          "採用済みのスライドです。新しい提案を作成してください。",
        );
      const all = targets.every((id) => slideIds.includes(id));
      const selected = new Set(slideIds);
      const resultDeck = candidate.result.deck;
      const agent = all
        ? resultDeck
        : {
            ...group.baseDeck,
            slides: [
              ...group.baseDeck.slides
                .filter(
                  (s) =>
                    !selected.has(s.id) ||
                    resultDeck.slides.some((a) => a.id === s.id),
                )
                .map((s) =>
                  selected.has(s.id)
                    ? resultDeck.slides.find((a) => a.id === s.id)
                    : s,
                ),
              ...resultDeck.slides.filter(
                (s) =>
                  selected.has(s.id) &&
                  !group.baseDeck.slides.some((b) => b.id === s.id),
              ),
            ],
          };
      const current = await readProject(root);
      const merged = mergeEditorDecks({
        base: group.baseDeck,
        agent,
        current,
        scope: group.scope.kind,
      });
      if (merged.conflicts.length)
        throw Object.assign(
          new Error(
            "提案後の編集と競合しています。最新の資料から案を作り直してください。",
          ),
          { code: "WEAVE_REVISION_CONFLICT", diagnostics: merged.conflicts },
        );
      const assetRoot = join(this.workspace(group, candidate), "assets");
      const neededAssets = new Set(
        merged.deck.slides
          .filter((slide) => selected.has(slide.id))
          .flatMap((slide) => assetPathsInHtml(slide.html)),
      );
      const copies = [];
      for (const asset of neededAssets) {
        const filename = asset.slice("assets/".length);
        const source = await readFile(join(assetRoot, filename));
        try {
          const existing = await readFile(join(root, asset));
          if (!existing.equals(source))
            throw new Error(
              `画像が更新されています。新しいファイル名で案を作り直してください: ${filename}`,
            );
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          copies.push(filename);
        }
      }
      for (const filename of copies) {
        await mkdir(join(root, "assets"), { recursive: true });
        await cp(join(assetRoot, filename), join(root, "assets", filename), {
          force: false,
          errorOnExist: true,
        });
      }
      const deck = await writeProjectUnlocked(
        merged.deck,
        expectedRevision,
        root,
      );
      for (const id of slideIds) group.selections[id] = candidateId;
      if (targets.every((id) => group.selections[id])) group.state = "adopted";
      await this.save(root, groups);
      return { deck, baseline: current, groupId, candidateId };
    }, root);
  }
  async dismiss(root, groupId, tasks) {
    return await runProjectExclusive(async () => {
      const groups = await this.read(root);
      const group = this.group(groups, groupId);
      if (
        group.candidates.some((c) =>
          tasks.some(
            (t) =>
              t.id === c.taskId &&
              !["completed", "failed", "cancelled"].includes(t.status),
          ),
        )
      )
        throw new Error("生成中の担当を停止してから提案を終了してください。");
      group.state = "dismissed";
      await this.save(root, groups);
    }, root);
  }
  async assetPath(root, groupId, candidateId, filename) {
    const group = this.group(await this.read(root), groupId);
    const candidate = this.candidate(group, candidateId);
    if (
      relative(
        join(this.workspace(group, candidate), "assets"),
        join(this.workspace(group, candidate), "assets", filename),
      ).startsWith("..")
    )
      throw new Error("Invalid asset");
    return join(this.workspace(group, candidate), "assets", filename);
  }
}
