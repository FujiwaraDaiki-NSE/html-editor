import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

function sourceSection(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `Could not find source section start: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `Could not find source section end: ${end}`);
  return source.slice(startIndex, endIndex);
}

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html", host: "localhost" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the Weave editor shell and product metadata", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Weave — Human \+ Agent HTML Editor<\/title>/i);
  assert.match(html, /Northstar narrative/);
  assert.match(html, /Q3 Strategy Deck/);
  assert.match(html, /INSPECTOR/);
  assert.match(html, /Waiting for local Codex/);
  assert.match(html, /property="og:image"/);
  assert.match(html, /http:\/\/localhost\/og\.png/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("ships product-specific interactions and local integration surfaces", async () => {
  const [page, layout, packageJson, localApi, devScript, viteConfig] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../server/local-api.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/dev.mjs", import.meta.url), "utf8"),
    readFile(new URL("../vite.config.ts", import.meta.url), "utf8"),
  ]);

  assert.match(page, /setMode\("code"\)/);
  assert.match(page, /setBackground\(item\)/);
  assert.match(page, /setAccent\(color\)/);
  assert.match(page, /dropOn\(block\.id\)/);
  assert.match(page, /deleteSelected/);
  assert.match(page, /OBJECT TREE/);
  assert.match(page, /deckSlides/);
  assert.match(page, /messagesEndRef/);
  assert.match(page, /chat\/clear/);
  assert.match(page, /sendMessage/);
  assert.match(page, /variations\/generate/);
  assert.match(page, /history\/checkout/);
  assert.match(layout, /generateMetadata/);
  assert.match(localApi, /codex.*app-server/s);
  assert.match(localApi, /thread\/start/);
  assert.match(localApi, /turn\/start/);
  assert.match(localApi, /item\/agentMessage\/delta/);
  assert.match(localApi, /application\/x-ndjson/);
  assert.match(localApi, /git/);
  assert.match(localApi, /weave\/variation/);
  assert.match(localApi, /defaultSlides/);
  assert.match(localApi, /slides\[activeIndex\]/);
  assert.match(localApi, /chatPath/);
  assert.match(localApi, /appendChat/);
  assert.match(localApi, /\/api\/chat\/clear/);
  assert.match(devScript, /server\/local-api\.mjs/);
  assert.match(packageJson, /"dev": "node scripts\/dev\.mjs"/);
  assert.match(
    viteConfig,
    /GENERATED_PROJECT_WATCH_GLOB\s*=\s*["'][^"']*workspaces\/northstar\/\*\*["']/,
    "the generated project path must have a dedicated Vite watch exclusion",
  );
  assert.match(
    viteConfig,
    /ignored:\s*\[\s*GENERATED_PROJECT_WATCH_GLOB\s*\]/,
    "generated project files must not trigger a Vite reload that aborts the Agent stream",
  );
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await access(new URL("../public/og.png", import.meta.url));
  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
  await assert.rejects(access(new URL("../public/favicon.svg", import.meta.url)));
  await access(new URL("../concept.md", import.meta.url));
  await access(root);
});

test("guards chat submission during IME composition and requires the displayed keyboard shortcut", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const keyboardHandler = sourceSection(page, "onKeyDown={(event) => {", "placeholder=");

  assert.match(
    keyboardHandler,
    /(?:nativeEvent\.)?isComposing|compos(?:ing|ition)[A-Za-z]*Ref\.current/i,
    "Enter must not submit while an IME composition is active",
  );
  assert.match(keyboardHandler, /event\.metaKey/, "Cmd+Enter must be supported");
  assert.match(keyboardHandler, /event\.ctrlKey/, "Ctrl+Enter must be supported");
  assert.match(
    keyboardHandler,
    /(?:metaKey[\s\S]{0,100}ctrlKey|ctrlKey[\s\S]{0,100}metaKey)/,
    "the send condition must consider Cmd and Ctrl together",
  );
  assert.doesNotMatch(
    keyboardHandler,
    /event\.key\s*===\s*["']Enter["']\s*&&\s*!event\.shiftKey\s*\)/,
    "plain Enter must not retain the old send-on-enter condition",
  );
});

test("forwards reasoning events and consumes them in the chat UI", async () => {
  const [page, localApi] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../server/local-api.mjs", import.meta.url), "utf8"),
  ]);
  const notificationForwarder = sourceSection(
    localApi,
    "function forwardTurnNotification",
    "async function handleAgentTurn",
  );
  const sendMessage = sourceSection(page, "const sendMessage = async", "const interruptAgent = async");

  assert.match(
    notificationForwarder,
    /type:\s*["']reasoning["']/,
    "the local API must expose reasoning as a dedicated NDJSON event",
  );
  assert.match(
    notificationForwarder,
    /item\/reasoning\/summaryTextDelta/,
    "reasoning summary deltas must be forwarded instead of only showing a generic activity label",
  );
  assert.match(
    sendMessage,
    /event\.type\s*===\s*["']reasoning["']/,
    "the chat stream must handle reasoning events separately from generic activity",
  );
  assert.match(
    page,
    /message\.reasoning\?\.map\(/,
    "reasoning received from the stream must be rendered in the chat UI",
  );
});

test("reserves an agent turn before asynchronous setup and always releases the reservation", async () => {
  const localApi = await readFile(new URL("../server/local-api.mjs", import.meta.url), "utf8");
  const agentTurn = sourceSection(localApi, "async function handleAgentTurn", "async function runVariationTurn");
  const reservationHelper = sourceSection(localApi, "function reserveActiveTurn", "function releaseActiveTurn");
  const busyGuard = agentTurn.indexOf("if (activeTurn)");
  const firstAwait = agentTurn.indexOf("await", busyGuard);
  const reservation = agentTurn.search(/reserveActiveTurn\(\s*["'](?:agent|turn)["']\s*\)/);

  assert.notEqual(busyGuard, -1, "agent turns must reject an existing reservation");
  assert.notEqual(reservation, -1, "agent turns must create a starting reservation");
  assert.ok(reservation > busyGuard, "the reservation must be created after the busy guard");
  assert.ok(reservation < firstAwait, "the reservation must be created before the first asynchronous operation");
  assert.match(
    reservationHelper,
    /(?:phase|status):\s*["']starting["']/,
    "the early reservation must be distinguishable from a running turn",
  );
  assert.match(
    agentTurn,
    /const cleanup\s*=\s*\(\)\s*=>\s*\{[\s\S]{0,500}releaseActiveTurn\(/,
    "the common cleanup path must release activeTurn",
  );
  assert.match(
    agentTurn,
    /finally\s*\{[\s\S]{0,300}cleanup\(\)/,
    "terminal completion must use the common cleanup path",
  );
  assert.match(
    agentTurn,
    /catch\s*\(error\)\s*\{[\s\S]{0,300}(?:failTurn|cleanup)\(/,
    "asynchronous setup failure must also reach cleanup",
  );
});

test("branches turn completion by completed, interrupted, and failed status", async () => {
  const localApi = await readFile(new URL("../server/local-api.mjs", import.meta.url), "utf8");
  const agentTurn = sourceSection(localApi, "async function handleAgentTurn", "async function runVariationTurn");

  assert.match(agentTurn, /turn\?*\.status|turnStatus/, "turn/completed handling must inspect the terminal status");
  assert.match(agentTurn, /["']completed["']/, "completed turns need an explicit branch");
  assert.match(agentTurn, /["']interrupted["']/, "interrupted turns need an explicit branch");
  assert.match(agentTurn, /emit\(\{\s*type:\s*["']done["']/, "only successful completion should emit done");
  assert.match(agentTurn, /emit\(\{\s*type:\s*["']canceled["']/, "interruption should emit canceled");
  assert.match(agentTurn, /emit\(\{\s*type:\s*["']error["']/, "failure should emit error");
  assert.match(
    agentTurn,
    /status\s*===\s*["']interrupted["'][\s\S]{0,500}type:\s*["']canceled["']/,
    "interrupted status must take the canceled path",
  );
  assert.match(
    agentTurn,
    /status\s*!==\s*["']completed["'][\s\S]{0,700}type:\s*["']error["']/,
    "failed or otherwise non-completed status must take the error path",
  );
  assert.match(
    agentTurn,
    /status\s*!==\s*["']completed["'][\s\S]{0,1500}commitIfChanged[\s\S]{0,500}type:\s*["']done["']/,
    "commit and done must remain after terminal non-success branches",
  );
});
