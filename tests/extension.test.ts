import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import roughdraftExtension from "../src/index.ts";
import type { ReviewOptions, ReviewResult } from "../src/client.ts";

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
type Message = Parameters<ExtensionAPI["sendMessage"]>[0];
type MessageOptions = Parameters<ExtensionAPI["sendMessage"]>[1];

function completed(path = "/project/draft.md"): ReviewResult {
  return {
    path,
    events: [
      {
        type: "review.completed",
        documentPath: path,
        projectPath: "/project",
        relativePath: "draft.md",
        version: "version-2",
        sequence: 4,
        createdAt: "2026-10-02T13:00:00.000Z",
        summary: { comments: 2, replies: 1, suggestions: 3, unresolved: 2 },
      },
    ],
  };
}

function harness(hasUI = true, cwd = "/project") {
  const commands = new Map<string, Command>();
  const tools = new Map<string, ToolDefinition>();
  const events = new Map<
    string,
    (event: unknown, ctx: ExtensionContext) => unknown
  >();
  const messages: { message: Message; options: MessageOptions }[] = [];
  const notices: { text: string; level: string }[] = [];
  const statuses = new Map<string, string | undefined>();
  const widgets = new Map<string, string[] | undefined>();
  const calls: {
    options: ReviewOptions;
    resolve: (result: ReviewResult) => void;
    reject: (error: Error) => void;
  }[] = [];
  let sessionId = "session-a";
  let idle = true;
  const idleWaiters = new Set<() => void>();
  const ctx = {
    cwd,
    hasUI,
    isIdle: () => idle,
    waitForIdle: () =>
      idle
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            idleWaiters.add(resolve);
          }),
    sessionManager: { getSessionId: () => sessionId },
    ui: {
      notify: (text: string, level: string) => {
        notices.push({ text, level });
      },
      setStatus: (key: string, value: string | undefined) => {
        statuses.set(key, value);
      },
      setWidget: (key: string, value: string[] | undefined) => {
        widgets.set(key, value);
      },
    },
  } as unknown as ExtensionCommandContext;
  const pi = {
    registerCommand: (name: string, command: Command) => {
      commands.set(name, command);
    },
    registerTool: (tool: ToolDefinition) => {
      tools.set(tool.name, tool);
    },
    on: (
      name: string,
      handler: (event: unknown, ctx: ExtensionContext) => unknown,
    ) => {
      events.set(name, handler);
      return () => events.delete(name);
    },
    sendMessage: (message: Message, options: MessageOptions) => {
      messages.push({ message, options });
    },
  } as unknown as ExtensionAPI;
  roughdraftExtension(
    pi,
    (options) =>
      new Promise<ReviewResult>((resolve, reject) => {
        calls.push({ options, resolve, reject });
      }),
  );
  const command = commands.get("roughdraft");
  const tool = tools.get("roughdraft_review");
  assert.ok(command, "the interactive review command must be available");
  assert.ok(tool, "the model-callable review tool must be available");
  return {
    calls,
    messages,
    notices,
    statuses,
    widgets,
    command: (args: string) => command.handler(args, ctx),
    completions: (prefix: string) => command.getArgumentCompletions?.(prefix),
    execute: (
      params: { path: string; openBrowser?: boolean; timeoutSeconds?: number },
      signal?: AbortSignal,
      onUpdate?: Parameters<ToolDefinition["execute"]>[3],
    ) =>
      tool.execute(
        "review-call",
        params,
        signal,
        onUpdate,
        ctx as unknown as ExtensionToolContext,
      ),
    event: (name: string) => {
      const handler = events.get(name);
      assert.ok(handler, `review lifecycle must handle ${name}`);
      return handler({ type: name }, ctx);
    },
    setSession: (value: string) => {
      sessionId = value;
    },
    setIdle: (value: boolean) => {
      idle = value;
      if (idle) {
        for (const resolve of idleWaiters) resolve();
        idleWaiters.clear();
      }
    },
  };
}

test("a command stays responsive and delivers one handoff after explicit review completion", async () => {
  const h = harness();
  await h.command('"draft with spaces.md"');
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].options.path, "draft with spaces.md");
  assert.equal(h.calls[0].options.cwd, "/project");
  assert.equal(h.messages.length, 0);

  h.calls[0].options.onReady?.({
    path: "/project/draft with spaces.md",
    url: "http://localhost:3000/draft",
  });
  await h.command("status");
  assert.match(h.notices.at(-1)!.text, /http:\/\/localhost:3000\/draft/);
  assert.match(h.statuses.get("roughdraft")!, /draft with spaces\.md/);
  assert.ok(
    h.widgets.get("roughdraft")?.includes("http://localhost:3000/draft"),
  );
  assert.ok(
    h.widgets.get("roughdraft")?.some((line) => line.includes("Finish review")),
  );

  const result = completed("/project/draft with spaces.md");
  h.calls[0].resolve(result);
  await setImmediate();
  assert.equal(h.messages.length, 1);
  const delivered = h.messages[0];
  assert.equal(delivered.message.customType, "roughdraft-review");
  assert.match(String(delivered.message.content), /draft with spaces\.md/);
  assert.match(
    String(delivered.message.content),
    /Read the latest Markdown from disk/,
  );
  assert.deepEqual(delivered.message.details, result);
  assert.deepEqual(delivered.options, { triggerTurn: true });
  assert.equal(h.statuses.get("roughdraft"), undefined);
  assert.equal(h.widgets.get("roughdraft"), undefined);
  await h.command("status");
  assert.match(h.notices.at(-1)!.text, /No active/);
  assert.equal(h.messages.length, 1);
});

test("reopen explains how to start when this branch has no reviewed file", async () => {
  const h = harness();
  await h.command("reopen");
  assert.equal(h.calls.length, 0);
  assert.match(h.notices.at(-1)!.text, /No previous.*review.*branch/i);
  assert.match(h.notices.at(-1)!.text, /\/roughdraft <file\.md>/);
});

test("reopen starts a fresh review of the last successfully opened absolute path", async () => {
  const h = harness();
  await h.command("draft.md");
  h.calls[0].options.onReady?.({
    path: "/project/draft.md",
    url: "http://localhost:3000/draft",
  });
  h.calls[0].resolve(completed());
  await setImmediate();
  await h.command("reopen");
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].options.path, "/project/draft.md");
  assert.notEqual(h.calls[1].options.signal, h.calls[0].options.signal);
  assert.equal(h.messages.length, 1, "reopen must wait for a new handoff");
  await h.command("cancel");
});

test("cancel retains the last path for an explicit reopen without reviving the old handoff", async () => {
  const h = harness();
  await h.command("draft.md");
  h.calls[0].options.onReady?.({
    path: "/project/draft.md",
    url: "http://localhost:3000/draft",
  });
  await h.command("cancel");
  assert.equal(h.calls.length, 1);
  await h.command("reopen");
  assert.equal(h.calls[1].options.path, "/project/draft.md");
  assert.equal(h.calls[1].options.signal.aborted, false);
  h.calls[0].resolve(completed());
  await setImmediate();
  assert.equal(h.messages.length, 0);
  await h.command("cancel");
});

for (const event of [
  "session_before_switch",
  "session_before_fork",
  "session_before_tree",
  "session_shutdown",
]) {
  test(`${event} clears reopen history for the outgoing conversation branch`, async () => {
    const h = harness();
    await h.command("draft.md");
    h.calls[0].options.onReady?.({
      path: "/project/draft.md",
      url: "http://localhost:3000/draft",
    });
    h.event(event);
    await h.command("reopen");
    assert.equal(h.calls.length, 1);
    assert.match(h.notices.at(-1)!.text, /No previous/);
  });
}

test("reopen cannot carry a reviewed path to another session even without a navigation event", async () => {
  const h = harness();
  await h.command("draft.md");
  h.calls[0].options.onReady?.({
    path: "/project/draft.md",
    url: "http://localhost:3000/draft",
  });
  await h.command("cancel");
  h.setSession("session-b");
  await h.command("reopen");
  assert.equal(h.calls.length, 1);
  assert.match(h.notices.at(-1)!.text, /No previous/);
});

test("command completions find subcommands and Markdown paths in the current session directory", async (t) => {
  const cwd = await mkdtemp(path.join(process.cwd(), ".test-completions-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(path.join(cwd, "docs with spaces"));
  await writeFile(path.join(cwd, "draft.md"), "# Draft\n");
  await writeFile(path.join(cwd, "notes.txt"), "Notes\n");
  await writeFile(path.join(cwd, "docs with spaces", "Plan.MD"), "# Plan\n");
  const h = harness(true, cwd);
  h.event("session_start");
  assert.deepEqual(
    (await h.completions("re"))?.map((item) => item.value),
    ["reopen"],
  );
  const root = (await h.completions(""))?.map((item) => item.value) ?? [];
  assert.ok(root.includes("draft.md"));
  assert.ok(root.includes(`docs with spaces${path.sep}`));
  assert.equal(root.includes("notes.txt"), false);
  const matches = await h.completions('"docs with spaces/Pl');
  assert.equal(matches?.length, 1);
  await h.command(matches![0].value);
  assert.equal(
    h.calls[0].options.path,
    path.join("docs with spaces", "Plan.MD"),
  );
  assert.deepEqual(await h.completions("missing-directory/"), null);
  await h.command("cancel");
});

test("one active review excludes both entry points, and cancel permits another review", async () => {
  const h = harness();
  await h.command("first.md");
  await h.command("second.md");
  assert.equal(h.calls.length, 1);
  assert.equal(h.notices.at(-1)!.level, "warning");
  await assert.rejects(h.execute({ path: "second.md" }), /already active/);

  await h.command("cancel");
  assert.equal(h.calls[0].options.signal.aborted, true);
  await h.command("second.md");
  assert.equal(h.calls.length, 2);
  h.calls[1].options.onReady?.({
    path: "/project/second.md",
    url: "http://localhost:3000/second",
  });

  // A transport can finish despite abort. It must neither resume Pi nor clear the new review.
  h.calls[0].options.onReady?.({
    path: "/project/first.md",
    url: "http://localhost:3000/first",
  });
  h.calls[0].resolve(completed("/project/first.md"));
  await setImmediate();
  assert.equal(h.messages.length, 0);
  assert.match(h.statuses.get("roughdraft")!, /second\.md/);
  h.calls[1].resolve(completed("/project/second.md"));
  await setImmediate();
  assert.equal(h.messages.length, 1);
  assert.match(String(h.messages[0].message.content), /second\.md/);
});

for (const event of [
  "session_before_switch",
  "session_before_fork",
  "session_before_tree",
  "session_shutdown",
]) {
  test(`${event} cancels a pending review without resuming another conversation branch`, async () => {
    const h = harness();
    await h.command("draft.md");
    h.event(event);
    assert.equal(h.calls[0].options.signal.aborted, true);
    h.calls[0].resolve(completed());
    await setImmediate();
    assert.equal(h.messages.length, 0);
    assert.equal(
      h.notices.filter((notice) => notice.level === "error").length,
      0,
    );
    assert.equal(h.statuses.get("roughdraft"), undefined);
    assert.equal(h.widgets.get("roughdraft"), undefined);
  });
}

test("navigation at the completion boundary does not deliver feedback into the next branch", async () => {
  const h = harness();
  await h.command("draft.md");
  h.calls[0].resolve(completed());
  queueMicrotask(() => {
    h.event("session_before_tree");
  });
  await setImmediate();
  assert.equal(h.messages.length, 0);
});

test("a session identity change suppresses a completed command handoff", async () => {
  const h = harness();
  await h.command("draft.md");
  h.setSession("session-b");
  h.calls[0].resolve(completed());
  await setImmediate();
  assert.equal(h.messages.length, 0);
});

test("receipt is acknowledged only after the waiting Pi command accepts its feedback", async () => {
  const h = harness();
  let acknowledgments = 0;
  await h.command("draft.md");
  h.setIdle(false);
  const result = completed();
  Object.defineProperty(result, "receipt", {
    value: {
      async acknowledge() {
        assert.equal(h.messages.length, 1);
        acknowledgments += 1;
      },
      async cancel() {
        throw new Error("Accepted feedback must not be cancelled");
      },
    },
  });
  h.calls[0].resolve(result);
  await setImmediate();
  assert.equal(acknowledgments, 0);
  h.setIdle(true);
  await setImmediate();
  assert.equal(acknowledgments, 1);
});

test("navigation cancels the pending receipt instead of acknowledging another conversation", async () => {
  const h = harness();
  let acknowledgments = 0;
  let cancellations = 0;
  await h.command("draft.md");
  h.setIdle(false);
  const result = completed();
  Object.defineProperty(result, "receipt", {
    value: {
      async acknowledge() {
        acknowledgments += 1;
      },
      async cancel() {
        cancellations += 1;
      },
    },
  });
  h.calls[0].resolve(result);
  await setImmediate();
  h.event("session_before_tree");
  h.setIdle(true);
  await setImmediate();
  assert.equal(h.messages.length, 0);
  assert.equal(acknowledgments, 0);
  assert.equal(cancellations, 1);
});

test("completed feedback waits for Pi to be idle and stays cancellable until delivery", async () => {
  const h = harness();
  await h.command("draft.md");
  h.setIdle(false);
  h.calls[0].resolve(completed());
  await setImmediate();
  assert.equal(
    h.messages.length,
    0,
    "do not give an uncancellable handoff to Pi's follow-up queue",
  );
  assert.match(h.statuses.get("roughdraft")!, /waiting for Pi/);
  await h.command("status");
  assert.match(h.notices.at(-1)!.text, /feedback ready/);
  assert.ok(
    h.widgets.get("roughdraft")?.some((line) => /Waiting for Pi/.test(line)),
  );
  await assert.rejects(h.execute({ path: "second.md" }), /already active/);

  h.setIdle(true);
  await setImmediate();
  assert.equal(h.messages.length, 1);
  assert.equal(h.statuses.get("roughdraft"), undefined);
});

test("navigation cancels completed feedback while another Pi turn is running", async () => {
  const h = harness();
  await h.command("draft.md");
  h.setIdle(false);
  h.calls[0].resolve(completed());
  await setImmediate();
  h.event("session_before_tree");
  h.setIdle(true);
  await setImmediate();
  assert.equal(h.messages.length, 0);
  assert.equal(h.statuses.get("roughdraft"), undefined);
});

test("cancel releases completed feedback immediately and a subsequent review can start", async () => {
  const h = harness();
  await h.command("first.md");
  h.setIdle(false);
  h.calls[0].resolve(completed("/project/first.md"));
  await setImmediate();
  await h.command("cancel");
  assert.equal(h.calls[0].options.signal.aborted, true);
  const nextReview = h.execute({ path: "second.md" });
  assert.equal(h.calls.length, 2);
  h.calls[1].resolve(completed("/project/second.md"));
  await nextReview;
  h.setIdle(true);
  await setImmediate();
  assert.equal(h.messages.length, 0);
});

test("feedback remains owned if Pi starts more work before idle delivery resumes", async () => {
  const h = harness();
  await h.command("draft.md");
  h.setIdle(false);
  h.calls[0].resolve(completed());
  await setImmediate();
  h.setIdle(true);
  h.setIdle(false);
  await setImmediate();
  assert.equal(h.messages.length, 0);
  h.setIdle(true);
  await setImmediate();
  assert.equal(h.messages.length, 1);
});

test("tool cancellation reaches the review and cannot be returned as successful completion", async () => {
  const h = harness();
  const controller = new AbortController();
  const execution = h.execute({ path: "draft.md" }, controller.signal);
  const rejected = assert.rejects(execution, { name: "AbortError" });
  controller.abort();
  assert.equal(h.calls[0].options.signal.aborted, true);
  h.calls[0].resolve(completed());
  await rejected;
  assert.equal(h.messages.length, 0);
  assert.equal(h.statuses.get("roughdraft"), undefined);
});

test("tool cancellation at the completion boundary does not return a successful handoff", async () => {
  const h = harness();
  const controller = new AbortController();
  const execution = h.execute({ path: "draft.md" }, controller.signal);
  const rejected = assert.rejects(execution, { name: "AbortError" });
  h.calls[0].resolve(completed());
  queueMicrotask(() => {
    controller.abort();
  });
  await rejected;
  assert.equal(h.messages.length, 0);
});

test("tool completion does not escape into another conversation branch", async () => {
  const h = harness();
  const execution = h.execute({ path: "draft.md" });
  const rejected = assert.rejects(execution, { name: "AbortError" });
  h.calls[0].resolve(completed());
  queueMicrotask(() => {
    h.event("session_before_tree");
  });
  await rejected;
  assert.equal(h.messages.length, 0);
});

test("a tool returns progress and the handoff in headless mode without a duplicate follow-up", async () => {
  const h = harness(false);
  const updates: unknown[] = [];
  const execution = h.execute(
    { path: "draft.md", openBrowser: false, timeoutSeconds: 45 },
    undefined,
    (update) => {
      updates.push(update);
    },
  );
  assert.equal(h.calls[0].options.openBrowser, false);
  assert.equal(h.calls[0].options.timeoutSeconds, 45);
  h.calls[0].options.onReady?.({
    path: "/project/draft.md",
    url: "http://localhost:3000/draft",
  });
  assert.equal(updates.length, 1);
  assert.match(JSON.stringify(updates[0]), /http:\/\/localhost:3000\/draft/);
  h.calls[0].resolve(completed());
  const result = await execution;
  assert.deepEqual(result.details, completed());
  assert.match(
    JSON.stringify(result.content),
    /Read the latest Markdown from disk/,
  );
  assert.equal(h.messages.length, 0);
  assert.equal(h.notices.length, 0);
  assert.equal(h.statuses.size, 0);
  assert.equal(h.widgets.size, 0);
});

test("command errors are visible and tool errors reject, with neither reported as completion", async () => {
  const h = harness();
  await h.command("draft.md");
  h.calls[0].reject(new Error("Server disconnected"));
  await setImmediate();
  assert.deepEqual(h.notices.at(-1), {
    text: "Server disconnected",
    level: "error",
  });
  assert.equal(h.messages.length, 0);
  assert.equal(h.statuses.get("roughdraft"), undefined);

  const execution = h.execute({ path: "draft.md" });
  const rejected = assert.rejects(execution, /Server restarted/);
  h.calls[1].reject(new Error("Server restarted"));
  await rejected;
  assert.equal(h.messages.length, 0);
  assert.equal(h.statuses.get("roughdraft"), undefined);
});

test("commands do not start a review while Pi is busy or without an interactive UI", async () => {
  const h = harness();
  h.setIdle(false);
  await h.command("draft.md");
  assert.equal(h.calls.length, 0);
  assert.equal(h.notices.at(-1)!.level, "warning");

  const headless = harness(false);
  await assert.rejects(headless.command("draft.md"), /roughdraft_review/);
  assert.equal(headless.calls.length, 0);
});
