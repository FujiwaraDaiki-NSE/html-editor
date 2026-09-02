import { createServer } from "node:net";

export const WEB_BIND_HOST = "0.0.0.0";

export function findAvailablePort(startPort) {
  assertPortNumber(startPort);

  return new Promise((resolve, reject) => {
    const tryPort = (port) => {
      const probe = createServer();
      probe.once("error", (error) => {
        probe.close(() => {
          if (error.code === "EADDRINUSE" && port < 65_535) {
            tryPort(port + 1);
            return;
          }
          reject(error);
        });
      });
      probe.listen({ host: WEB_BIND_HOST, port }, () => {
        probe.close((error) => error ? reject(error) : resolve(port));
      });
    };
    tryPort(startPort);
  });
}

export function assertPortNumber(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new RangeError("port must be an integer between 1 and 65535.");
  }
}

export function parseConfiguredPort(value) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new RangeError("WEAVE_WEB_PORT must be an integer between 1 and 65535.");
  }
  const port = Number(value);
  assertPortNumber(port);
  return port;
}

export function assertPortAvailable(port) {
  assertPortNumber(port);
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", (error) => probe.close(() => reject(error)));
    probe.listen({ host: WEB_BIND_HOST, port }, () => {
      probe.close((error) => error ? reject(error) : resolve());
    });
  });
}

export async function resolveWebPort(configuredPort) {
  if (configuredPort !== undefined) {
    const port = parseConfiguredPort(configuredPort);
    await assertPortAvailable(port);
    return port;
  }
  return findAvailablePort(3000);
}
