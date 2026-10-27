"use client";

import { useEffect, useRef, useState } from "react";
import { readLearningState, SkillRequestError, updateLearningState, type LearningState, type SkillEntry } from "./application-skill-requests";

const outcomeLabels = { learned: "指示へ反映しました", candidate: "次回の判断用に記録しました", unchanged: "指示の変更はありません", skipped: "今回は学習を行いませんでした", failed: "学習を完了できませんでした" };

export function ApplicationSkillLearning({ skills }: { skills: SkillEntry[] }) {
  const [state, setState] = useState<LearningState | null>(null);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const readGeneration = useRef(0);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [status, setStatus] = useState<{ state: "loading" | "idle" | "busy" | "success" | "error"; message: string }>({ state: "loading", message: "自動学習の設定を読み込み中…" });

  useEffect(() => {
    if (busyRef.current) return;
    const generation = ++readGeneration.current;
    const controller = new AbortController();
    void readLearningState(controller.signal).then((result) => {
      if (controller.signal.aborted || generation !== readGeneration.current) return;
      setState(result);
      setNeedsRefresh(false);
      setStatus({ state: "idle", message: "" });
    }).catch((error: unknown) => {
      if (controller.signal.aborted || generation !== readGeneration.current) return;
      setState(null);
      setStatus({ state: "error", message: error instanceof Error ? error.message : String(error) });
    });
    return () => controller.abort();
  }, [skills, reload]);

  const update = async (enabled: boolean) => {
    if (busyRef.current || !state || state.capabilities.configure !== true || needsRefresh) return;
    busyRef.current = true;
    readGeneration.current += 1;
    setBusy(true);
    setStatus({ state: "busy", message: "自動学習の設定を保存中…" });
    try {
      const result = await updateLearningState(enabled, state.revision);
      setState(result);
      setStatus({ state: "success", message: result.enabled ? "自動学習を有効にしました。" : "自動学習を停止しました。" });
    } catch (error) {
      if (error instanceof SkillRequestError && (error.kind === "conflict" || error.kind === "unknown")) setNeedsRefresh(true);
      setStatus({ state: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return <section className="application-skill-learning" aria-label="アプリ共通スキルの自動学習" aria-busy={busy}>
    <label><span><strong>会話から好みを学習</strong><small>{state === null ? "設定を確認してください" : state.enabled ? "有効" : "停止中"}</small></span><input type="checkbox" aria-label="会話から好みを自動学習" checked={state?.enabled === true} disabled={busy || state?.capabilities.configure !== true || needsRefresh} onChange={(event) => void update(event.target.checked)} /></label>
    <p>資料づくりで伝えた好みを確認し、アプリ共通の指示に反映します。変更内容はスキルの履歴に残ります。</p>
    {state?.unavailableReason && <p className="activity-warning">{state.unavailableReason}</p>}
    <div className={`learning-status ${status.state}`} role={status.state === "error" ? "alert" : "status"} aria-live="polite">{status.message}</div>
    {(needsRefresh || state === null && status.state === "error") && <button type="button" disabled={busy} onClick={() => { setStatus({ state: "loading", message: "最新の設定を読み込み中…" }); setReload((value) => value + 1); }}>最新の設定を読み直す</button>}
    {state?.lastOutcome && <details className="learning-outcome"><summary>{outcomeLabels[state.lastOutcome.status]}</summary><time dateTime={state.lastOutcome.at}>{new Date(state.lastOutcome.at).toLocaleString("ja-JP")}</time><p>{state.lastOutcome.reason}</p></details>}
  </section>;
}
