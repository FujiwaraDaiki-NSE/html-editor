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
        <strong>Codex needs more information</strong>
        {questions.map((question: any) => (
          <label className="server-question" key={question.id}>
            <span>{question.header || question.question}</span>
            <small>{question.question}</small>
            {question.options?.length ? (
              <select
                value={answers[question.id] ?? ""}
                onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))}
              >
                <option value="">Choose…</option>
                {question.options.map((option: any) => (
                  <option key={option.label} value={option.label}>{option.label}</option>
                ))}
              </select>
            ) : null}
            <input
              type={question.isSecret ? "password" : "text"}
              value={answers[question.id] ?? ""}
              onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))}
              placeholder={question.isOther ? "Type an answer" : "Answer"}
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
          Submit answers
        </button>
        <button onClick={() => onReject(request.id)}>Cancel</button>
      </article>
    );
  }

  if (request.method === "item/permissions/requestApproval") {
    const permissions = Object.fromEntries(
      Object.entries(params.permissions ?? {}).filter(([, value]) => value !== null),
    );
    return (
      <article className="server-request">
        <strong>Additional permissions</strong>
        <p>{String(params.reason ?? "Codex requested additional project permissions.")}</p>
        <button onClick={() => onResolve(request.id, { permissions, scope: "turn" })}>Allow for turn</button>
        <button onClick={() => onResolve(request.id, { permissions, scope: "session" })}>Allow for session</button>
        <button onClick={() => onReject(request.id)}>Decline</button>
      </article>
    );
  }

  if (request.method === "mcpServer/elicitation/request") {
    return (
      <article className="server-request">
        <strong>{params.serverName ?? "MCP server"}</strong>
        <p>{String(params.message ?? "The MCP server needs a response.")}</p>
        {params.mode === "url" ? (
          <>
            <button onClick={() => {
              if (window.confirm("Open this external authorization page?")) {
                window.open(String(params.url), "_blank", "noopener,noreferrer");
              }
            }}>Open URL</button>
            <button onClick={() => onResolve(request.id, { action: "accept", content: null, _meta: params._meta ?? null })}>Continue</button>
          </>
        ) : (
          <>
            <label className="server-question">
              <span>Form response</span>
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
                setMcpContent('{"error":"Enter valid JSON"}');
              }
            }}>Submit form</button>
          </>
        )}
        <button onClick={() => onResolve(request.id, { action: "decline", content: null, _meta: null })}>Decline</button>
      </article>
    );
  }

  const generatedDecisions = request.method === "item/commandExecution/requestApproval"
    ? ["accept", "acceptForSession", "decline", "cancel"]
    : ["accept", "acceptForSession", "decline", "cancel"];
  const decisions = Array.isArray(params.availableDecisions) ? params.availableDecisions : generatedDecisions;
  return (
    <article className="server-request">
      <strong>{request.method}</strong>
      <p>{String(params.reason ?? params.message ?? params.command ?? "Codex needs your approval.")}</p>
      {decisions.map((decision: any) => {
        const value = typeof decision === "string" ? decision : decision.decision;
        return <button key={value} onClick={() => onResolve(request.id, { decision: value })}>{value}</button>;
      })}
    </article>
  );
}
