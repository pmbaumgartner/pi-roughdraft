import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  type AssistantMessage,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { McpClient, StdioTransport } from "@earendil-works/pi-mcp";
import { chromium } from "@playwright/test";

const run = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const directory = await mkdtemp(
  path.join(tmpdir(), "roughdraft-pi-acceptance-"),
);
const binary =
  process.env.ROUGHDRAFT_BIN || path.join(root, "node_modules/.bin/roughdraft");
const file = path.join(directory, "review with spaces.md");
const feedback = "Use the concrete customer example.";
const portProbe = createServer();
await new Promise<void>((resolve) => portProbe.listen(0, "127.0.0.1", resolve));
const address = portProbe.address();
assert.ok(address && typeof address === "object");
await new Promise<void>((resolve, reject) =>
  portProbe.close((error) => (error ? reject(error) : resolve())),
);
const live = process.argv.includes("--live");
function option(name: string) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}
if (live && (!option("--provider") || !option("--model")))
  throw new Error("--live requires --provider and --model");
const env = {
  ...process.env,
  ROUGHDRAFT_STATE_DIR: path.join(directory, "server-state"),
  ROUGHDRAFT_STATE_FILE: undefined,
  ROUGHDRAFT_HOST: undefined,
  ROUGHDRAFT_NO_OPEN: "1",
  ROUGHDRAFT_PORT: String(address.port),
  ROUGHDRAFT_BIND_HOST: "127.0.0.1",
};
let session:
  | Awaited<ReturnType<typeof createAgentSession>>["session"]
  | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const client = new McpClient({
  name: "roughdraft-pi-acceptance",
  version: "1",
  requestTimeoutMs: 5000,
});
let started = false;
let serverUrl: string;

function log(event: string, data: object = {}) {
  console.log(JSON.stringify({ event, ...data }));
}
async function status(reviewId: string) {
  const url = new URL("/api/review-events/status", serverUrl);
  url.searchParams.set("projectPath", directory);
  url.searchParams.set("path", path.basename(file));
  url.searchParams.set("reviewId", reviewId);
  const response = await fetch(url);
  assert.equal(response.status, 200);
  return response.json() as Promise<{ state: string }>;
}

try {
  await writeFile(
    file,
    '# Review acceptance\n\n{==Example==}{>>Clarify this.<<}{#c1}\n\n---\ncomments:\n  c1:\n    by: user\n    at: "2026-10-02T12:00:00.000Z"\n',
  );
  const opened = JSON.parse(
    (
      await run(binary, ["open", file, "--json", "--no-watch", "--no-open"], {
        env,
      })
    ).stdout,
  );
  started = true;
  serverUrl = opened.serverUrl;
  const server = await (await fetch(new URL("/api/status", serverUrl))).json();
  assert.equal(
    server.capabilities.reviewSessions,
    true,
    "Acceptance requires the scoped-review fork",
  );
  await client.connect(
    new StdioTransport({
      command: binary,
      args: ["mcp"],
      env: Object.fromEntries(
        Object.entries(env).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
    }),
  );
  assert.ok(
    (await client.listTools()).some(
      (tool) => tool.name === "roughdraft_get_review_index",
    ),
  );
  const index = await client.callTool("roughdraft_get_review_index", {
    documentPath: file,
  });
  assert.match(JSON.stringify(index), /Clarify this/);
  log("native-mcp.passed");

  const settings = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const modelRuntime = await ModelRuntime.create(
    live
      ? {}
      : {
          authPath: path.join(directory, "auth.json"),
          modelsPath: path.join(directory, "models.json"),
        },
  );
  let calls = 0;
  if (!live)
    modelRuntime.registerProvider("roughdraft-acceptance", {
      api: "openai-completions",
      apiKey: "deterministic-test-provider",
      baseUrl: "http://unused.invalid",
      models: [
        {
          id: "fixture",
          name: "Deterministic acceptance",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32000,
          maxTokens: 1000,
        },
      ],
      streamSimple(model, context) {
        const stream = createAssistantMessageEventStream();
        const step = calls++;
        const output: AssistantMessage = {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          content:
            step === 0
              ? [
                  {
                    type: "toolCall",
                    id: "review-1",
                    name: "roughdraft_review",
                    arguments: {
                      path: file,
                      openBrowser: false,
                      timeoutSeconds: 30,
                    },
                  },
                ]
              : step === 1
                ? [
                    {
                      type: "toolCall",
                      id: "read-1",
                      name: "read",
                      arguments: { path: file },
                    },
                  ]
                : [
                    {
                      type: "text",
                      text: "Review feedback reread from the saved Markdown.",
                    },
                  ],
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: step < 2 ? "toolUse" : "stop",
          timestamp: Date.now(),
        };
        if (step === 1)
          assert.ok(
            context.messages.some(
              (message) =>
                message.role === "toolResult" &&
                JSON.stringify(message).includes("Read the latest Markdown"),
            ),
            "Actual Pi receives the extension handoff",
          );
        if (step === 2)
          assert.ok(
            context.messages.some(
              (message) =>
                message.role === "toolResult" &&
                JSON.stringify(message).includes(feedback),
            ),
            "Actual Pi read tool sees persisted feedback",
          );
        stream.push({ type: "start", partial: output });
        stream.push({
          type: "done",
          reason: output.stopReason as "toolUse" | "stop",
          message: output,
        });
        stream.end(output);
        return stream;
      },
    });
  const selectedModel = live
    ? modelRuntime.getModel(option("--provider")!, option("--model")!)
    : modelRuntime.getModel("roughdraft-acceptance", "fixture");
  assert.ok(
    selectedModel,
    "Requested model exists in the configured Pi runtime",
  );
  if (live)
    assert.ok(
      (await modelRuntime.getAvailable(selectedModel.provider)).some(
        (model) => model.id === selectedModel.id,
      ),
      "Live acceptance requires existing provider credentials",
    );
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: path.join(directory, "pi-agent"),
    settingsManager: settings,
    noContextFiles: true,
    additionalExtensionPaths: [path.join(root, "src/index.ts")],
    additionalSkillPaths: [path.join(root, "skills/roughdraft")],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  assert.ok(
    loader.getSkills().skills.some((skill) => skill.name === "roughdraft"),
    "Pi discovers the bundled skill",
  );
  ({ session } = await createAgentSession({
    cwd: directory,
    agentDir: path.join(directory, "pi-agent"),
    modelRuntime,
    model: selectedModel,
    thinkingLevel: "off",
    resourceLoader: loader,
    settingsManager: settings,
    sessionManager: SessionManager.inMemory(directory),
    tools: ["read", "roughdraft_review"],
  }));
  await session.bindExtensions({
    onError(error) {
      throw new Error(error.error);
    },
  });
  let ready!: (url: string) => void;
  const readyUrl = new Promise<string>((resolve) => {
    ready = resolve;
  });
  const toolResults: string[] = [];
  session.subscribe((event) => {
    if (
      event.type === "tool_execution_update" &&
      event.toolName === "roughdraft_review"
    ) {
      const text = JSON.stringify(event.partialResult);
      const match = text.match(/http:\/\/(?:localhost|127\.0\.0\.1):[^\\"\s]+/);
      if (match) ready(match[0]);
    }
    if (event.type === "tool_execution_end")
      toolResults.push(JSON.stringify(event.result));
  });
  const originalBinary = process.env.ROUGHDRAFT_BIN;
  Object.assign(
    process.env,
    Object.fromEntries(
      Object.entries(env).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
    { ROUGHDRAFT_BIN: binary },
  );
  const deadline = setTimeout(() => {
    void session?.abort();
  }, 90000);
  deadline.unref();
  const pending = session
    .prompt(
      `Use roughdraft_review for ${JSON.stringify(file)} with openBrowser false. Wait for Finish review. Then use read to reread that file and briefly report the overall feedback. Do not modify files.`,
    )
    .finally(() => clearTimeout(deadline));
  void pending.catch(() => {});
  const viewerUrl = await Promise.race([
    readyUrl,
    pending.then(() => {
      throw new Error("Pi ended before opening the review");
    }),
    new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Pi review readiness timed out")),
        20000,
      );
      timer.unref();
    }),
  ]);
  const reviewId = new URL(viewerUrl).searchParams.get("reviewId");
  assert.ok(reviewId, "Pi publishes a scoped browser URL");
  if (process.argv.includes("--browser")) {
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(viewerUrl);
    await page.getByTestId("review-handoff-button").waitFor();
    await page.getByTestId("review-handoff-comment-trigger").click();
    await page.getByTestId("review-handoff-overall-comment").fill(feedback);
    await page.getByTestId("review-handoff-submit-comment").click();
    await page
      .getByTestId("review-handoff-status")
      .getByText("Received by Pi", { exact: true })
      .waitFor();
    await page.screenshot({
      path:
        process.env.ROUGHDRAFT_ACCEPTANCE_SCREENSHOT ||
        path.join(root, ".context/acceptance.png"),
    });
    log("browser-finish-and-receipt.passed");
  } else {
    const completed = await fetch(new URL("/api/review-events", serverUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectPath: directory,
        path: path.basename(file),
        reviewId,
        overallComment: feedback,
      }),
    });
    assert.equal(completed.status, 201);
    assert.equal((await completed.json()).state, "queued");
    log("http-finish.passed", { browser: "not requested" });
  }
  await pending;
  if (originalBinary === undefined) delete process.env.ROUGHDRAFT_BIN;
  else process.env.ROUGHDRAFT_BIN = originalBinary;
  if (!live) assert.equal(calls, 3);
  assert.equal((await status(reviewId)).state, "received");
  assert.match(
    await readFile(file, "utf8"),
    /Use the concrete customer example/,
  );
  assert.ok(
    toolResults.some(
      (result) =>
        result.includes("roughdraft") ||
        result.includes("Read the latest Markdown"),
    ),
  );
  assert.ok(toolResults.every((result) => !result.includes("receiptToken")));
  assert.ok(
    toolResults.some((result) => result.includes(feedback)),
    "Pi rereads the persisted feedback",
  );
  log("actual-pi-host.passed", {
    provider: live ? selectedModel.provider : "deterministic",
    model: selectedModel.id,
    receipt: "received",
  });
} finally {
  session?.dispose();
  await browser?.close();
  await client.close();
  if (started) await run(binary, ["stop", "--json"], { env });
  await rm(directory, { recursive: true, force: true });
}
