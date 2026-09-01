"use client";
/* eslint-disable @typescript-eslint/no-explicit-any -- reverse requests are forward-compatible generated protocol payloads. */

import { useRef, useState } from "react";
import { beginRequestResolution, finishRequestResolution, type RequestResolutionPhase } from "../request-state";
import type { PendingServerRequest } from "../types";

type Props = {
  request: PendingServerRequest;
  onResolve: (id: string | number, result: Record<string, unknown>) => Promise<void>;
  onReject: (id: string | number) => Promise<void>;
};

export function ServerRequestCard({ request, onResolve, onReject }: Props) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [mcpContent, setMcpContent] = useState("{}");
  const [resolutionPhase, setResolutionPhase] = useState<RequestResolutionPhase>("idle");
  const [resolutionError, setResolutionError] = useState<string | null>(null);
  const resolutionPhaseRef = useRef<RequestResolutionPhase>("idle");
  const params = request.params as any;
  const submitResolution = (operation: () => Promise<void>) => {
    const started = beginRequestResolution(resolutionPhaseRef.current);
    if (!started.started) return;
    resolutionPhaseRef.current = started.phase;
    setResolutionPhase(started.phase);
    setResolutionError(null);
    void Promise.resolve()
      .then(operation)
      .then(
        () => {
          const next = finishRequestResolution(resolutionPhaseRef.current, true);
          resolutionPhaseRef.current = next;
          setResolutionPhase(next);
        },
        () => {
          const next = finishRequestResolution(resolutionPhaseRef.current, false);
          resolutionPhaseRef.current = next;
          setResolutionPhase(next);
          setResolutionError("回答の送信に失敗しました。再試行できます。");
        },
      );
  };
  const resolve = (result: Record<string, unknown>) => submitResolution(() => onResolve(request.id, result));
  const reject = () => submitResolution(() => onReject(request.id));
  const isResolving = resolutionPhase === "submitting";
  const isSettled = resolutionPhase === "settled";
  const statusLabel = resolutionError ?? (isResolving ? "回答を送信中…" : isSettled ? "回答を送信しました" : "");
  const statusRole = resolutionError ? "alert" : "status";

  if (request.method === "item/tool/requestUserInput") {
    const questions = (params.questions ?? []).slice(0, 3);
    return (
      <article className="server-request" aria-busy={isResolving} data-resolution-state={resolutionPhase}>
        <strong>Codexから確認があります</strong>
        {questions.map((question: any) => (
          <label className="server-question" key={question.id}>
            <span>{question.header || question.question}</span>
            <small>{question.question}</small>
            {question.options?.length ? (
              <select
                value={answers[question.id] ?? ""}
                onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))}
                disabled={isResolving || isSettled}
              >
                <option value="">選択してください…</option>
                {question.options.map((option: any) => (
                  <option key={option.label} value={option.label}>{option.label}</option>
                ))}
              </select>
            ) : null}
            <input
              type={question.isSecret ? "password" : "text"}
              value={answers[question.id] ?? ""}
              onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))}
              placeholder={question.isOther ? "回答を入力" : "回答"}
              disabled={isResolving || isSettled}
            />
          </label>
        ))}
        <button
          disabled={isResolving || isSettled || questions.some((question: any) => !answers[question.id]?.trim())}
          onClick={() => resolve({
            answers: Object.fromEntries(
              questions.map((question: any) => [question.id, { answers: [answers[question.id]] }]),
            ),
          })}
        >
          回答を送信
        </button>
        <button disabled={isResolving || isSettled} onClick={reject}>キャンセル</button>
        {statusLabel && <span className={`server-request-status${resolutionError ? " error" : ""}`} role={statusRole} aria-live="polite">{statusLabel}</span>}
      </article>
    );
  }

  if (request.method === "item/permissions/requestApproval") {
    const permissions = Object.fromEntries(
      Object.entries(params.permissions ?? {}).filter(([, value]) => value !== null),
    );
    return (
      <article className="server-request" aria-busy={isResolving} data-resolution-state={resolutionPhase}>
        <strong>追加の権限が必要です</strong>
        <p>{String(params.reason ?? "Codexがプロジェクトへの追加権限を求めています。")}</p>
        <button disabled={isResolving || isSettled} onClick={() => resolve({ permissions, scope: "turn" })}>今回のみ許可</button>
        <button disabled={isResolving || isSettled} onClick={() => resolve({ permissions, scope: "session" })}>このセッションで許可</button>
        <button disabled={isResolving || isSettled} onClick={reject}>許可しない</button>
        {statusLabel && <span className={`server-request-status${resolutionError ? " error" : ""}`} role={statusRole} aria-live="polite">{statusLabel}</span>}
      </article>
    );
  }

  if (request.method === "mcpServer/elicitation/request") {
    return (
      <article className="server-request" aria-busy={isResolving} data-resolution-state={resolutionPhase}>
        <strong>{params.serverName ?? "MCPサーバー"}</strong>
        <p>{String(params.message ?? "MCPサーバーから回答を求められています。")}</p>
        {params.mode === "url" ? (
          <>
            <button onClick={() => {
              if (window.confirm("外部の認証ページを開きますか？")) {
                window.open(String(params.url), "_blank", "noopener,noreferrer");
              }
            }} disabled={isResolving || isSettled}>認証ページを開く</button>
            <button disabled={isResolving || isSettled} onClick={() => resolve({ action: "accept", content: null, _meta: params._meta ?? null })}>続ける</button>
          </>
        ) : (
          <>
            <label className="server-question">
              <span>フォームへの回答</span>
              <textarea value={mcpContent} onChange={(event) => setMcpContent(event.target.value)} disabled={isResolving || isSettled} />
            </label>
            <button disabled={isResolving || isSettled} onClick={() => {
              try {
                const content = JSON.parse(mcpContent);
                resolve({
                  action: "accept",
                  content,
                  _meta: params._meta ?? null,
                });
              } catch {
                setMcpContent('{"error":"正しいJSONを入力してください"}');
              }
            }}>フォームを送信</button>
          </>
        )}
        <button disabled={isResolving || isSettled} onClick={() => resolve({ action: "decline", content: null, _meta: null })}>許可しない</button>
        {statusLabel && <span className={`server-request-status${resolutionError ? " error" : ""}`} role={statusRole} aria-live="polite">{statusLabel}</span>}
      </article>
    );
  }

  const generatedDecisions = request.method === "item/commandExecution/requestApproval"
    ? ["accept", "acceptForSession", "decline", "cancel"]
    : ["accept", "acceptForSession", "decline", "cancel"];
  const decisions = Array.isArray(params.availableDecisions) ? params.availableDecisions : generatedDecisions;
  const decisionLabels: Record<string, string> = {
    accept: "許可",
    acceptForSession: "このセッションで許可",
    decline: "許可しない",
    cancel: "キャンセル",
  };
  return (
    <article className="server-request" aria-busy={isResolving} data-resolution-state={resolutionPhase}>
      <strong>{request.method}</strong>
      <p>{String(params.reason ?? params.message ?? params.command ?? "Codexが許可を求めています。")}</p>
      {decisions.map((decision: any) => {
        const value = typeof decision === "string" ? decision : decision.decision;
        return <button key={value} disabled={isResolving || isSettled} onClick={() => resolve({ decision: value })}>{decisionLabels[value] ?? value}</button>;
      })}
      {statusLabel && <span className={`server-request-status${resolutionError ? " error" : ""}`} role={statusRole} aria-live="polite">{statusLabel}</span>}
    </article>
  );
}
