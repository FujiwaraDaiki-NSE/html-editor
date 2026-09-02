export type ProjectEventDiagnostic = { code?: string; message: string; severity?: string; source?: string };

type ProjectEventPayload = {
  status?: unknown;
  error?: unknown;
  diagnostics?: unknown;
  cleanupError?: unknown;
};

type ActiveProjectPreview = {
  threadId?: unknown;
  turnId?: unknown;
  previewSequence?: unknown;
} | null;

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

/** Reject replayed turn events when the state endpoint belongs to a newer active turn. */
export function projectEventMatchesActivePreview(payload: unknown, activePreview: ActiveProjectPreview): boolean {
  if (!payload || typeof payload !== "object") return true;
  const event = payload as Record<string, unknown>;
  const status = event.status;
  const threadId = typeof event.threadId === "string" ? event.threadId : null;
  const turnId = typeof event.turnId === "string" ? event.turnId : null;
  if (status === "preview" && (!threadId || !turnId || !activePreview)) return false;
  if (!threadId || !turnId || !activePreview) return true;
  if (activePreview.threadId !== threadId || activePreview.turnId !== turnId) return false;
  if (status !== "preview") return true;
  const eventSequence = Number(event.previewSequence);
  const stateSequence = Number(activePreview.previewSequence);
  return Number.isFinite(eventSequence) && Number.isFinite(stateSequence) && eventSequence <= stateSequence;
}

export function preservedSlideNumber(
  currentSlides: Array<{ id: string }>,
  nextSlides: Array<{ id: string }>,
  currentNumber: number,
  preferredSlideId: string | null = null,
): number {
  const preferredIndex = preferredSlideId ? nextSlides.findIndex((slide) => slide.id === preferredSlideId) : -1;
  if (preferredIndex >= 0) return preferredIndex + 1;
  const currentId = currentSlides[currentNumber - 1]?.id;
  const preservedIndex = currentId ? nextSlides.findIndex((slide) => slide.id === currentId) : -1;
  return preservedIndex >= 0 ? preservedIndex + 1 : Math.min(Math.max(currentNumber, 1), nextSlides.length);
}

export function viewedSlideIdForHydration(
  currentSlides: Array<{ id: string }>,
  hydratedSlides: Array<{ id: string }>,
  currentNumber: number,
  deckLoaded: boolean,
): string | null {
  const slides = deckLoaded ? currentSlides : hydratedSlides;
  return slides[currentNumber - 1]?.id ?? null;
}
