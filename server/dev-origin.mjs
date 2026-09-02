export function isAllowedWebOrigin(origin, webPort, host) {
  if (origin === undefined) return true;
  if (typeof origin !== "string" || !Number.isInteger(webPort) || webPort < 1 || webPort > 65_535) return false;

  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return false;

  const originPort = url.port === "" ? 80 : Number(url.port);
  if (originPort !== webPort) return false;
  if (typeof host !== "string") return false;

  try {
    const forwardedHost = new URL(`http://${host}`);
    return forwardedHost.origin === url.origin;
  } catch {
    return false;
  }
}
