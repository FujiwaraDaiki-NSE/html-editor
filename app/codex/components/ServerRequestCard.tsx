"use client";
/* eslint-disable @typescript-eslint/no-explicit-any -- reverse requests are forward-compatible generated protocol payloads. */

import { useState } from "react";
import type { PendingServerRequest } from "../types";

type Props = {
  request: PendingServerRequest;
  onResolve: (id: string | number, result: Record<string, unknown>) => void;
  onReject: (id: string | number) => void;
};

export function ServerRequestCard({ request, onResolve, onReject }: Props) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [mcpContent, setMcpContent] = useState("{}");
  const params = request.params as any;

  if (request.method === "item/tool/requestUserInput") {
    const questions = (params.questions ?? []).slice(0, 3);
    return (
      <article className="server-request">
        <strong>Codexから確認があります</strong>
        {questions.map((question: any) => (
          <label className="server-question" key={question.id}>
            <span>{question.header || question.question}</span>
            <small>{question.question}</small>
            {question.options?.length ? (
              <select
                value={answers[question.id] ?? ""}
                onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))}
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
            />
          </label>
        ))}
        <button
          disabled={questions.some((question: any) => !answers[question.id]?.trim())}
          onClick={() => onResolve(request.id, {
            answers: Object.fromEntries(
              questions.map((question: any) => [question.id, { answers: [answers[question.id]] }]),
            ),
          })}
        >
          回答を送信
        </button>
        <button onClick={() => onReject(request.id)}>キャンセル</button>
      </article>
    );
  }

  if (request.method === "item/permissions/requestApproval") {
    const permissions = Object.fromEntries(
      Object.entries(params.permissions ?? {}).filter(([, value]) => value !== null),
    );
    return (
      <article className="server-request">
        <strong>追加の権限が必要です</strong>
        <p>{String(params.reason ?? "Codexがプロジェクトへの追加権限を求めています。")}</p>
        <button onClick={() => onResolve(request.id, { permissions, scope: "turn" })}>今回のみ許可</button>
        <button onClick={() => onResolve(request.id, { permissions, scope: "session" })}>このセッションで許可</button>
        <button onClick={() => onReject(request.id)}>許可しない</button>
      </article>
    );
  }

  if (request.method === "mcpServer/elicitation/request") {
    return (
      <article className="server-request">
        <strong>{params.serverName ?? "MCPサーバー"}</strong>
        <p>{String(params.message ?? "MCPサーバーから回答を求められています。")}</p>
        {params.mode === "url" ? (
          <>
            <button onClick={() => {
              if (window.confirm("外部の認証ページを開きますか？")) {
                window.open(String(params.url), "_blank", "noopener,noreferrer");
              }
            }}>認証ページを開く</button>
            <button onClick={() => onResolve(request.id, { action: "accept", content: null, _meta: params._meta ?? null })}>続ける</button>
          </>
        ) : (
          <>
            <label className="server-question">
              <span>フォームへの回答</span>
              <textarea value={mcpContent} onChange={(event) => setMcpContent(event.target.value)} />
            </label>
            <button onClick={() => {
              try {
                onResolve(request.id, {
                  action: "accept",
                  content: JSON.parse(mcpContent),
                  _meta: params._meta ?? null,
                });
              } catch {
                setMcpContent('{"error":"正しいJSONを入力してください"}');
              }
            }}>フォームを送信</button>
          </>
        )}
        <button onClick={() => onResolve(request.id, { action: "decline", content: null, _meta: null })}>許可しない</button>
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
    <article className="server-request">
      <strong>{request.method}</strong>
      <p>{String(params.reason ?? params.message ?? params.command ?? "Codexが許可を求めています。")}</p>
      {decisions.map((decision: any) => {
        const value = typeof decision === "string" ? decision : decision.decision;
        return <button key={value} onClick={() => onResolve(request.id, { decision: value })}>{decisionLabels[value] ?? value}</button>;
      })}
    </article>
  );
}
