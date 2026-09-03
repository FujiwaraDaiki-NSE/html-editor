import { createServer, isIPv4 } from "node:net";
import { networkInterfaces } from "node:os";

export const LOOPBACK_WEB_HOST = "127.0.0.1";

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

function configuredHosts(hosts) {
  if (!Array.isArray(hosts) || hosts.length === 0) {
    throw new TypeError("At least one web host is required.");
  }
  return [...new Set(hosts.map(parseConfiguredHost))];
}

function listenProbe(host, port) {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen({ host, port }, () => resolve(probe));
  });
}

function closeProbe(probe) {
  return new Promise((resolve, reject) => {
    probe.close((error) => error ? reject(error) : resolve());
  });
}

export async function findAvailablePort(startPort, hosts) {
  assertPortNumber(startPort);
  const parsedHosts = configuredHosts(hosts);

  for (let port = startPort; port <= 65_535; port += 1) {
    try {
      await assertPortAvailable(port, parsedHosts);
      return port;
    } catch (error) {
      if (error.code !== "EADDRINUSE" || port === 65_535) throw error;
    }
  }
  throw new RangeError("No available web port was found.");
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

export async function assertPortAvailable(port, hosts) {
  assertPortNumber(port);
  const parsedHosts = configuredHosts(hosts);
  const probes = [];
  try {
    for (const host of parsedHosts) probes.push(await listenProbe(host, port));
  } finally {
    await Promise.all(probes.map(closeProbe));
  }
}

export async function resolveWebPort(configuredPort, hosts) {
  if (configuredPort !== undefined) {
    const port = parseConfiguredPort(configuredPort);
    await assertPortAvailable(port, hosts);
    return port;
  }
  return findAvailablePort(3000, hosts);
}
