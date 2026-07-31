import { EventEmitter } from "node:events";

export class CodexEventStream extends EventEmitter {
  constructor({ limit = 2_000 } = {}) {
    super();
    this.limit = limit;
    this.sequence = 0;
    this.events = [];
  }

  publish(type, payload) {
    const event = { sequence: ++this.sequence, type, payload, emittedAt: Date.now() };
    this.events.push(event);
    if (this.events.length > this.limit) this.events.splice(0, this.events.length - this.limit);
    this.emit("event", event);
    return event;
  }

  since(sequence = 0) {
    return this.events.filter((event) => event.sequence > sequence);
  }

  attach(response, sequence = 0) {
    const send = (event) => {
      if (!response.destroyed && !response.writableEnded) response.write(`${JSON.stringify(event)}\n`);
    };
    for (const event of this.since(sequence)) send(event);
    this.on("event", send);
    const heartbeat = setInterval(() => {
      if (!response.destroyed && !response.writableEnded) response.write("\n");
    }, 15_000);
    const cleanup = () => {
      clearInterval(heartbeat);
      this.off("event", send);
    };
    response.once("close", cleanup);
    response.once("finish", cleanup);
    return cleanup;
  }
}
