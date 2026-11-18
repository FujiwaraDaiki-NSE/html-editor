import { createInterface } from 'node:readline';
const url = process.env.WEAVE_TOOL_URL; const token = process.env.WEAVE_TOOL_TOKEN;
if (!url || !token) throw new Error('Orchestrator tool endpoint and capability token are required.');
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  void (async () => {
    let request;
    try {
      request = JSON.parse(line); if (request.id === undefined) return;
      let result;
      if (request.method === 'initialize') result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'weave_ui', version: '1.0.0' } };
      else if (request.method === 'ping') result = {};
      else if (request.method === 'tools/list' || request.method === 'tools/call') {
        const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ method: request.method, params: request.params }) });
        const body = await response.json(); if (!response.ok) throw new Error(body.error); result = body;
      } else throw new Error('Unsupported MCP method.');
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
    } catch (error) { if (request?.id !== undefined) process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: error.message } })}\n`); }
  })();
}
