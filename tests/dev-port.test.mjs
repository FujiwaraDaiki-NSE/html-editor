import assert from "node:assert/strict";
import { createServer } from "node:net";
import { networkInterfaces } from "node:os";
import test from "node:test";

import { findAvailablePort, parseConfiguredPort, resolveWebPort } from "../scripts/dev-port.mjs";

function listenOnEphemeralPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => resolve(server));
  });
}

function nonLoopbackIpv4Address() {
  return Object.values(networkInterfaces()).flat().find((address) => address?.family === "IPv4" && !address.internal)?.address;
}

test("selects the next available port when the starting port is occupied", async () => {
  const blocker = await listenOnEphemeralPort();
  const address = blocker.address();
  assert.ok(address && typeof address === "object");

  try {
    const selected = await findAvailablePort(address.port);
    assert.ok(selected > address.port);
  } finally {
    blocker.close();
  }
});

test("fails when an explicitly configured port is occupied", async () => {
  const blocker = await listenOnEphemeralPort();
  const address = blocker.address();
  assert.ok(address && typeof address === "object");

  try {
    await assert.rejects(resolveWebPort(String(address.port)), { code: "EADDRINUSE" });
  } finally {
    blocker.close();
  }
});

test("detects a port occupied only on a non-loopback interface", async (context) => {
  const host = nonLoopbackIpv4Address();
  if (!host) return context.skip("No non-loopback IPv4 interface is available.");

  const blocker = createServer();
  await new Promise((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen({ host, port: 0 }, resolve);
  });
  const address = blocker.address();
  assert.ok(address && typeof address === "object");

  try {
    await assert.rejects(resolveWebPort(String(address.port)), { code: "EADDRINUSE" });
  } finally {
    blocker.close();
  }
});

test("rejects a missing or invalid explicit port", () => {
  assert.throws(() => parseConfiguredPort(undefined), /WEAVE_WEB_PORT/);
  assert.throws(() => parseConfiguredPort("0"), /between 1 and 65535/);
  assert.throws(() => parseConfiguredPort("3001.5"), /WEAVE_WEB_PORT/);
});
