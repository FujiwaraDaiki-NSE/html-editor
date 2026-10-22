import assert from "node:assert/strict";
import { connect, createServer } from "node:net";
import { networkInterfaces } from "node:os";
import test from "node:test";

import { startLoopbackForwarder } from "../scripts/loopback-forwarder.mjs";

function nonLoopbackIpv4Address() {
  return Object.values(networkInterfaces()).flat().find((address) => address?.family === "IPv4" && !address.internal)?.address;
}

function trackConnections(server) {
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  return sockets;
}

function closeServer(server, sockets) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    for (const socket of sockets) socket.destroy();
  });
}

test("forwards loopback traffic to the LAN-bound web server", async (context) => {
  const targetHost = nonLoopbackIpv4Address();
  if (!targetHost) return context.skip("No non-loopback IPv4 interface is available.");

  const upstream = createServer((socket) => socket.pipe(socket));
  const upstreamSockets = trackConnections(upstream);
  await new Promise((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen({ host: targetHost, port: 0 }, resolve);
  });
  const address = upstream.address();
  assert.ok(address && typeof address === "object");
  const forwarder = await startLoopbackForwarder(targetHost, address.port);
  const forwarderSockets = trackConnections(forwarder);

  try {
    const echoed = await new Promise((resolve, reject) => {
      const client = connect({ host: "127.0.0.1", port: address.port }, () => client.write("weave"));
      client.setEncoding("utf8");
      client.once("data", (data) => {
        client.destroy();
        resolve(data);
      });
      client.once("error", reject);
    });
    assert.equal(echoed, "weave");
  } finally {
    await closeServer(forwarder, forwarderSockets);
    await closeServer(upstream, upstreamSockets);
  }
});

test("rejects a loopback forwarding target", () => {
  assert.throws(() => startLoopbackForwarder("127.0.0.1", 3001), /non-loopback target/);
});
