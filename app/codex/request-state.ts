export type RequestResolutionPhase = "idle" | "submitting" | "settled" | "result_unknown";

export type RequestResolutionOutcome = {
  result: "settled" | "result_unknown";
  retryable?: boolean;
  message?: string;
};

export function beginRequestResolution(phase: RequestResolutionPhase, retryable = false): { phase: RequestResolutionPhase; started: boolean } {
  if (phase !== "idle" && !(phase === "result_unknown" && retryable)) return { phase, started: false };
  return { phase: "submitting", started: true };
}

export function finishRequestResolution(phase: RequestResolutionPhase, result: boolean | RequestResolutionOutcome["result"]): RequestResolutionPhase {
  if (phase !== "submitting") return phase;
  if (result === true || result === "settled") return "settled";
  return result === "result_unknown" ? "result_unknown" : "idle";
}
