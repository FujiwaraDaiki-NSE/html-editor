export type ProjectEventDiagnostic = { code?: string; message: string; severity?: string; source?: string };

type ProjectEventPayload = {
  status?: unknown;
  error?: unknown;
  diagnostics?: unknown;
  cleanupError?: unknown;
};

export type ProjectEventDecision = {
  refreshState: boolean;
  error: string | null;
  diagnostics: ProjectEventDiagnostic[];
};

/** Decide whether a project event may refresh the editor and expose a structured failure. */
export function projectEventDecision(payload: unknown): ProjectEventDecision {
  if (!payload || typeof payload !== "object" || (payload as ProjectEventPayload).status !== "error") {
    return { refreshState: true, error: null, diagnostics: [] };
  }

  const event = payload as ProjectEventPayload;
  const base = typeof event.error === "string" && event.error.trim()
    ? event.error.trim()
    : "Agent output failed the project quality gate.";
  const cleanupError = typeof event.cleanupError === "string" && event.cleanupError.trim()
    ? event.cleanupError.trim()
    : null;
  const diagnostics = Array.isArray(event.diagnostics)
    ? event.diagnostics
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const diagnostic = item as Record<string, unknown>;
        const message = typeof diagnostic.message === "string" ? diagnostic.message.trim() : "";
        if (!message) return null;
        return {
          ...(typeof diagnostic.code === "string" ? { code: diagnostic.code } : {}),
          message,
          ...(typeof diagnostic.severity === "string" ? { severity: diagnostic.severity } : {}),
          ...(typeof diagnostic.source === "string" ? { source: diagnostic.source } : {}),
        };
      })
      .filter((diagnostic): diagnostic is ProjectEventDiagnostic => diagnostic !== null)
    : [];
  const details = [...new Set(diagnostics.map((diagnostic) => diagnostic.message))].join(" ");
  const message = details ? `${base} ${details}` : base;
  return {
    refreshState: cleanupError === null,
    error: cleanupError ? `${message} Restore failed: ${cleanupError}` : message,
    diagnostics,
  };
}
