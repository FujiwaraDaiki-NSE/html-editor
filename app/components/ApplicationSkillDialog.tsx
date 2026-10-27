"use client";

import { useEffect, useId, useRef, useState } from "react";
import { isApplicationSkill, mutateApplicationSkill, readApplicationSkillHistory, readApplicationSkillVersion, SkillRequestError, type ApplicationSkillEntry, type ApplicationSkillMutation, type SkillEntry, type SkillHistory, type SkillHistoryEntry } from "./application-skill-requests";

type Props = {
  skill: ApplicationSkillEntry;
  latestRevision: string | undefined;
  initialTab: "edit" | "history";
  editing: boolean;
  onClose: () => void;
  onMutation: (result: ApplicationSkillMutation) => void;
  onRefresh: () => Promise<SkillEntry[] | null>;
};
type Status = { state: "idle" | "busy" | "success" | "error"; message: string };

export function ApplicationSkillDialog({ skill, latestRevision, initialTab, editing, onClose, onMutation, onRefresh }: Props) {
  const id = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const busyRef = useRef(false);
  const [current, setCurrent] = useState(skill);
  const [tab, setTab] = useState(initialTab);
  const [description, setDescription] = useState(skill.description);
  const [body, setBody] = useState(skill.body);
  const [message, setMessage] = useState("");
  const [operation, setOperation] = useState<"save" | "restore" | "refresh" | null>(null);
  const [status, setStatus] = useState<Status>({ state: "idle", message: "" });
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [history, setHistory] = useState<SkillHistory | null>(null);
  const [historyLoading, setHistoryLoading] = useState(initialTab === "history");
  const [historyError, setHistoryError] = useState("");
  const [historyReload, setHistoryReload] = useState(0);
  const [selected, setSelected] = useState<SkillHistoryEntry | null>(null);
  const [past, setPast] = useState<{ revision: string; skill: ApplicationSkillEntry } | null>(null);
  const [pastError, setPastError] = useState("");

  useEffect(() => {
    const previous = document.activeElement;
    dialogRef.current?.showModal();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);

  useEffect(() => {
    if (tab !== "history" || current.capabilities?.history !== true) return;
    const controller = new AbortController();
    void readApplicationSkillHistory(current.name, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setHistory(result);
      setHistoryLoading(false);
      if (result.revision !== current.revision) setNeedsRefresh(true);
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setHistoryLoading(false);
      setHistoryError(error instanceof Error ? error.message : String(error));
    });
    return () => controller.abort();
  }, [tab, current.name, current.revision, current.capabilities?.history, historyReload]);

  useEffect(() => {
    if (!selected || current.capabilities?.history !== true) return;
    const controller = new AbortController();
    void readApplicationSkillVersion(current.name, selected.id, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setPast(result);
      if (result.revision !== current.revision) setNeedsRefresh(true);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setPastError(error instanceof Error ? error.message : String(error));
    });
    return () => controller.abort();
  }, [selected, current.name, current.revision, current.capabilities?.history]);

  const busy = operation !== null;
  const revisionChanged = latestRevision !== undefined && latestRevision !== current.revision;
  const refreshRequired = needsRefresh || revisionChanged;
  const changed = description !== current.description || body !== current.body;
  const canSave = current.capabilities?.edit === true && !editing && !refreshRequired && !busy && changed && !!description.trim() && !!body.trim() && !!message.trim();
  const canRestore = current.capabilities?.restore === true && !editing && !refreshRequired && !busy && past !== null && past.revision === current.revision && !!message.trim();

  const refresh = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setOperation("refresh");
    setStatus({ state: "busy", message: "最新の内容を読み込み中…" });
    try {
      const entries = await onRefresh();
      const latest = entries?.find((entry) => entry.scope === "application" && entry.name === current.name);
      if (!isApplicationSkill(latest)) throw new Error("最新のスキルを読み込めませんでした。もう一度読み直してください。");
      setCurrent(latest);
      setDescription(latest.description);
      setBody(latest.body);
      setMessage("");
      setNeedsRefresh(false);
      setSelected(null);
      setPast(null);
      setHistory(null);
      setHistoryError("");
      setHistoryLoading(tab === "history");
      setHistoryReload((value) => value + 1);
      setStatus({ state: "success", message: "最新の内容を読み直しました。" });
    } catch (error) {
      setStatus({ state: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      busyRef.current = false;
      setOperation(null);
    }
  };

  const mutate = async (action: "update" | "restore") => {
    if (busyRef.current || (action === "update" ? !canSave : !canRestore)) return;
    busyRef.current = true;
    setOperation(action === "update" ? "save" : "restore");
    setStatus({ state: "busy", message: action === "update" ? "変更を保存中…" : "選んだ内容を新しい版として保存中…" });
    try {
      const payload = action === "update"
        ? { name: current.name, description, body, frontmatter: current.frontmatter, expectedRevision: current.revision, message: message.trim() }
        : { commit: selected!.id, expectedRevision: current.revision, message: message.trim() };
      const result = await mutateApplicationSkill(current.name, action, payload);
      onMutation(result);
      setCurrent(result.skill);
      setDescription(result.skill.description);
      setBody(result.skill.body);
      setMessage("");
      setSelected(null);
      setPast(null);
      setHistory(null);
      setHistoryError("");
      setHistoryLoading(tab === "history");
      setHistoryReload((value) => value + 1);
      setStatus({ state: "success", message: action === "update" ? "変更を保存しました。すべての資料でこの内容を使います。" : "選んだ内容を新しい版として保存しました。これまでの履歴も残っています。" });
    } catch (error) {
      if (error instanceof SkillRequestError && (error.kind === "conflict" || error.kind === "unknown")) setNeedsRefresh(true);
      setStatus({ state: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      busyRef.current = false;
      setOperation(null);
    }
  };

  return <dialog ref={dialogRef} className="skill-dialog application-skill-dialog" aria-labelledby={`${id}-title`} onCancel={(event) => { event.preventDefault(); if (!busyRef.current) onClose(); }}>
    <header><div><small>このアプリ共通</small><strong id={`${id}-title`}>{current.name}</strong></div><button type="button" aria-label="アプリ共通スキルを閉じる" disabled={busy} onClick={onClose}>×</button></header>
    <div className="application-skill-tabs" role="tablist" aria-label="アプリ共通スキルの管理">
      <button type="button" role="tab" id={`${id}-edit-tab`} aria-controls={`${id}-edit`} aria-selected={tab === "edit"} onClick={() => setTab("edit")}>内容を編集</button>
      <button type="button" role="tab" id={`${id}-history-tab`} aria-controls={`${id}-history`} aria-selected={tab === "history"} disabled={current.capabilities?.history !== true} onClick={() => { setTab("history"); if (!history) setHistoryLoading(true); }}>変更履歴</button>
    </div>
    <div className="skill-dialog-body">
      <p className="application-skill-intro">この指示はすべての資料で使います。説明と指示内容の変更を、メモと一緒に履歴へ保存できます。</p>
      {editing && <p className="activity-warning">スライドの編集処理が完了してから変更してください。</p>}
      {refreshRequired && <div className="skill-refresh-notice"><p role="alert">{revisionChanged ? "スキルに新しい変更が保存されました。入力内容は保持しています。最新の内容を読み直して確認してください。" : "最新の保存内容を確認する必要があります。入力内容を確認してから読み直してください。"}</p><button type="button" disabled={busy} onClick={() => void refresh()}>最新を読み直す（入力を置き換え）</button></div>}
      <section role="tabpanel" id={`${id}-edit`} aria-labelledby={`${id}-edit-tab`} hidden={tab !== "edit"}>
        {current.capabilities?.edit !== true && <p className="activity-warning">現在、このスキルは編集できません。</p>}
        <label className="skill-dialog-field"><span>説明</span><input autoFocus value={description} required maxLength={20000} disabled={busy || editing || current.capabilities?.edit !== true} onChange={(event) => setDescription(event.target.value)} /></label>
        <label className="skill-dialog-field"><span>指示内容</span><textarea value={body} required maxLength={900000} disabled={busy || editing || current.capabilities?.edit !== true} onChange={(event) => setBody(event.target.value)} /></label>
        <label className="skill-dialog-field"><span>変更メモ</span><input value={message} maxLength={180} disabled={busy || editing || current.capabilities?.edit !== true} onChange={(event) => setMessage(event.target.value)} placeholder="例：見出しを短くする指示を追加" /></label>
      </section>
      <section role="tabpanel" id={`${id}-history`} aria-labelledby={`${id}-history-tab`} hidden={tab !== "history"}>
        <p className="application-skill-intro">履歴を選んで、現在の内容と比べられます。復元した内容は新しい版として保存され、過去の履歴も残ります。</p>
        {historyLoading && <p role="status">変更履歴を読み込み中…</p>}
        {historyError && <div className="skill-status error" role="alert">{historyError}<button type="button" onClick={() => { setHistoryError(""); setHistoryLoading(true); setHistoryReload((value) => value + 1); }}>履歴を再読み込み</button></div>}
        {history && <div className="application-skill-history" aria-label="アプリ共通スキルの保存履歴">{history.entries.map((entry) => <button key={entry.id} type="button" aria-pressed={selected?.id === entry.id} disabled={busy} onClick={() => { setSelected(entry); setPast(null); setPastError(""); setMessage(`${entry.message} の内容に戻す`.slice(0, 180)); }}><strong>{entry.message}</strong><time dateTime={entry.date}>{new Date(entry.date).toLocaleString("ja-JP")}</time>{entry.id === current.revision && <span>現在の版</span>}</button>)}{history.entries.length === 0 && <p>このスキルの変更履歴はありません。</p>}</div>}
        {selected && <section className="application-skill-version" aria-label="選んだスキルの内容">
          <header><strong>{selected.message}</strong><time dateTime={selected.date}>{new Date(selected.date).toLocaleString("ja-JP")}</time></header>
          {!past && !pastError && <p role="status">この版の内容を読み込み中…</p>}
          {pastError && <p className="skill-status error" role="alert">{pastError}</p>}
          {past && <><div className="skill-version-comparison"><section><h3>現在の内容</h3><p>{current.description}</p><pre>{current.body}</pre></section><section><h3>選んだ版の内容</h3><p>{past.skill.description}</p><pre>{past.skill.body}</pre></section></div><label className="skill-dialog-field"><span>復元メモ</span><input value={message} maxLength={180} disabled={busy || editing || current.capabilities?.restore !== true} onChange={(event) => setMessage(event.target.value)} /></label>{current.capabilities?.restore !== true && <p className="activity-warning">現在、このスキルは復元できません。</p>}</>}
          <details className="version-details"><summary>技術情報</summary><code>{selected.id}</code></details>
        </section>}
      </section>
      <div className={`skill-status application-skill-status ${status.state}`} role={status.state === "error" ? "alert" : "status"} aria-live="polite" aria-busy={busy}>{status.message}</div>
      <details className="version-details"><summary>保存場所と版の情報</summary><code>{current.path}</code><code>{current.revision}</code></details>
    </div>
    <footer className="skill-dialog-actions"><button type="button" disabled={busy} onClick={onClose}>閉じる</button>{tab === "edit" ? <button type="button" className="primary-button" disabled={!canSave} onClick={() => void mutate("update")}>{operation === "save" ? "保存中…" : "変更を保存"}</button> : <button type="button" className="primary-button" disabled={!canRestore} onClick={() => void mutate("restore")}>{operation === "restore" ? "保存中…" : "選んだ内容を新しい版として保存"}</button>}</footer>
  </dialog>;
}
