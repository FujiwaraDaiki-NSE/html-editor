import { readFile, writeFile } from "node:fs/promises";
const args = process.argv.slice(2);
let input = "";
for await (const chunk of process.stdin) input += chunk;
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const sessionId = args[args.indexOf(args.includes("--resume") ? "--resume" : "--session-id") + 1];
send({ type: "system", subtype: "init", session_id: sessionId });
if (input === "WAIT") { setInterval(() => {}, 1000); }
else if (input === "BAD_JSON") { process.stdout.write("broken\n"); }
else if (input === "EXIT") { process.exitCode = 1; }
else {
  if (input === "EDIT") await writeFile("slide.html", (await readFile("slide.html", "utf8")).replace("Before", "After"));
  send({ type: "stream_event", event: { type: "message_start", message: { id: "answer" } } });
  send({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text" } } });
  send({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "DONE" } } });
  send({ type: "assistant", message: { id: "answer", content: [{ type: "text", text: "DONE" }, { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "slide.html" } }] } });
  send({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "file content" }] } });
  send({ type: "result", subtype: "success", is_error: false, permission_denials: input === "DENIED" ? [{ tool_name: "Bash" }] : [], result: "DONE" });
}
