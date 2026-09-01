export type TurnSubmissionPhase = "idle" | "submitting" | "accepted";

export type TurnSubmissionState = {
  phase: TurnSubmissionPhase;
  threadId: string | null;
};

export type TurnPresentationState = "idle" | "submission" | "accepted" | "in_progress";

export const IDLE_TURN_SUBMISSION: TurnSubmissionState = { phase: "idle", threadId: null };

export function deriveTurnPresentation(
  submission: TurnSubmissionState,
  activeThreadId: string | null,
  agentRunning: boolean,
): TurnPresentationState {
  if (agentRunning) return "in_progress";
  if (submission.phase === "submitting" && submission.threadId === activeThreadId) return "submission";
  if (submission.phase === "accepted" && submission.threadId && submission.threadId === activeThreadId) return "accepted";
  return "idle";
}

export function resetTurnSubmission(
  submission: TurnSubmissionState,
  activeThreadId: string | null,
  agentRunning: boolean,
  connectionStatus: "connecting" | "connected" | "reconnecting" | "disconnected" | "incompatible",
): TurnSubmissionState {
  if (submission.phase === "idle") return submission;
  if (connectionStatus !== "connected") return IDLE_TURN_SUBMISSION;
  if (submission.threadId !== activeThreadId) return IDLE_TURN_SUBMISSION;
  if (submission.phase === "accepted" && agentRunning) return IDLE_TURN_SUBMISSION;
  return submission;
}
