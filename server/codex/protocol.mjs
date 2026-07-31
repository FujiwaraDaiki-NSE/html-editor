export function classifyMessage(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return "invalid";
  const hasId = Object.hasOwn(message, "id");
  const hasMethod = typeof message.method === "string" && message.method.length > 0;
  if (hasId && hasMethod) return "serverRequest";
  if (hasMethod) return "notification";
  if (hasId && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) return "response";
  return "invalid";
}

export function rpcError(code, message, data) {
  return { code, message, ...(data === undefined ? {} : { data }) };
}

export function parseJsonLine(line) {
  try {
    const message = JSON.parse(line);
    return classifyMessage(message) === "invalid"
      ? { ok: false, error: new Error("Invalid app-server JSON-RPC message.") }
      : { ok: true, message };
  } catch (error) {
    return { ok: false, error };
  }
}
