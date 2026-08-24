const LOOPBACK_HTTP_ORIGIN = /^http:\/\/127\.0\.0\.1(?::\d+)?$/;

export function isAllowedWebOrigin(origin, webPort) {
  if (origin === undefined) return true;
  if (typeof origin !== "string" || !Number.isInteger(webPort) || webPort < 1 || webPort > 65_535) return false;

  if (!LOOPBACK_HTTP_ORIGIN.test(origin)) return false;

  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }

  const originPort = url.port === "" ? 80 : Number(url.port);
  return originPort === webPort;
}
