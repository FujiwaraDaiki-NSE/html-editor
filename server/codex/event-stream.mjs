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
    let lastSent = sequence;
    const send = (event) => {
      if (event.sequence <= lastSent) return;
      lastSent = event.sequence;
      if (!response.destroyed && !response.writableEnded) response.write(`${JSON.stringify(event)}\n`);
    };
    this.on("event", send);
    const oldest = this.events[0]?.sequence ?? this.sequence + 1;
    if (sequence < oldest - 1) {
      send({
        sequence: oldest - 1,
        type: "codex/gap",
        payload: { requested: sequence, oldest, latest: this.sequence },
        emittedAt: Date.now(),
      });
    }
    for (const event of this.since(lastSent)) send(event);
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
