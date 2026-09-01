export type RequestResolutionPhase = "idle" | "submitting" | "settled";

export function beginRequestResolution(phase: RequestResolutionPhase): { phase: RequestResolutionPhase; started: boolean } {
  if (phase !== "idle") return { phase, started: false };
  return { phase: "submitting", started: true };
}

export function finishRequestResolution(phase: RequestResolutionPhase, succeeded: boolean): RequestResolutionPhase {
  if (phase !== "submitting") return phase;
  return succeeded ? "settled" : "idle";
}
