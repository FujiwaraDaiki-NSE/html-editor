import { createServer, isIPv4 } from "node:net";
import { networkInterfaces } from "node:os";

export function parseConfiguredHost(value) {
  if (typeof value !== "string" || value.trim() !== value || !isIPv4(value) || value === "0.0.0.0") {
    throw new TypeError("WEAVE_WEB_HOST must be a concrete local IPv4 interface address.");
  }
  const localAddresses = new Set(Object.values(networkInterfaces()).flat().map((address) => address?.address).filter(Boolean));
  if (!localAddresses.has(value)) {
    throw new TypeError("WEAVE_WEB_HOST must match an IP address assigned to this computer.");
  }
  return value;
}

export function findAvailablePort(startPort, host) {
  assertPortNumber(startPort);
  parseConfiguredHost(host);

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
      probe.listen({ host, port }, () => {
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

export function assertPortAvailable(port, host) {
  assertPortNumber(port);
  parseConfiguredHost(host);
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", (error) => probe.close(() => reject(error)));
    probe.listen({ host, port }, () => {
      probe.close((error) => error ? reject(error) : resolve());
    });
  });
}

export async function resolveWebPort(configuredPort, host) {
  if (configuredPort !== undefined) {
    const port = parseConfiguredPort(configuredPort);
    await assertPortAvailable(port, host);
    return port;
  }
  return findAvailablePort(3000, host);
}
