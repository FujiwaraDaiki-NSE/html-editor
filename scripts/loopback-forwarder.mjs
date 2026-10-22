import { connect, createServer } from "node:net";
import { assertPortNumber, LOOPBACK_WEB_HOST, parseConfiguredHost } from "./dev-port.mjs";

export function startLoopbackForwarder(targetHost, port) {
  parseConfiguredHost(targetHost);
  assertPortNumber(port);
  if (targetHost === LOOPBACK_WEB_HOST) {
    throw new TypeError("The loopback forwarder requires a non-loopback target host.");
  }

  return new Promise((resolve, reject) => {
    const server = createServer((client) => {
      const upstream = connect({ host: targetHost, port });
      client.on("error", () => upstream.destroy());
      upstream.on("error", () => client.destroy());
      client.pipe(upstream);
      upstream.pipe(client);
    });
    server.on("error", reject);
    server.listen({ host: LOOPBACK_WEB_HOST, port }, () => resolve(server));
  });
}
