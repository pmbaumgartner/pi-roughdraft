import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { reviewDocument } from "../src/client.ts";

const execFileAsync = promisify(execFile);
let directory: string;
let env: NodeJS.ProcessEnv;
let serverUrl: string;
const binary = path.resolve("node_modules/.bin/roughdraft");

async function availablePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

before(async () => {
  directory = await mkdtemp(path.join(process.cwd(), ".test-roughdraft-"));
  env = {
    ...process.env,
    ROUGHDRAFT_BIN: binary,
    ROUGHDRAFT_STATE_DIR: path.join(directory, "state"),
    ROUGHDRAFT_STATE_FILE: undefined,
    ROUGHDRAFT_HOST: undefined,
    ROUGHDRAFT_NO_OPEN: "1",
    ROUGHDRAFT_BIND_HOST: "127.0.0.1",
    ROUGHDRAFT_PORT: String(await availablePort()),
  };
  const { stdout } = await execFileAsync(binary, ["start", "--json"], { env });
  serverUrl = JSON.parse(stdout).url;
});

after(async () => {
  if (env) await execFileAsync(binary, ["stop", "--json"], { env });
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function createDocument(name: string): Promise<string> {
  const file = path.join(directory, name);
  await writeFile(file, "# Review me\n\nAn unchanged paragraph.\n");
  return file;
}

async function emitReview(file: string, overallComment?: string) {
  const response = await fetch(new URL("/api/review-events", serverUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectPath: path.dirname(file), path: path.basename(file), overallComment }),
  });
  assert.equal(response.status, 201);
  return response.json() as Promise<{ delivered: boolean; event: { sequence: number } }>;
}

async function waitUntilWatching(file: string): Promise<void> {
  const url = new URL("/api/review-events/status", serverUrl);
  url.searchParams.set("projectPath", path.dirname(file));
  url.searchParams.set("path", path.basename(file));
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const response = await fetch(url);
    if ((await response.json() as { watching: boolean }).watching) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("The real Roughdraft server never registered the review watcher.");
}

test("fresh review ignores old handoffs and delivers persisted overall feedback", async () => {
  const file = await createDocument("with space; and $characters.md");
  const previous = await emitReview(file);
  let ready!: () => void;
  const readyPromise = new Promise<void>((resolve) => { ready = resolve; });
  const controller = new AbortController();
  const pending = reviewDocument({
    path: file, cwd: directory, env, signal: controller.signal, openBrowser: false,
    onReady(info) {
      assert.equal(info.path, file);
      assert.equal(new URL(info.url).hostname, "localhost");
      ready();
    },
  });
  try {
    await readyPromise;
    await waitUntilWatching(file);
    const completed = await emitReview(file, "Please clarify this paragraph.");
    assert.equal(completed.delivered, true);
    const result = await pending;
    assert.equal(result.path, file);
    assert.equal(result.events.length, 1);
    assert.ok(result.events[0].sequence > previous.event.sequence);
    assert.equal(result.events[0].overallComment, "Please clarify this paragraph.");
    assert.equal(result.events[0].summary.comments, 1);
    assert.match(await readFile(file, "utf8"), /Please clarify this paragraph\./);
  } finally {
    controller.abort();
    await pending.catch(() => {});
  }
});

test("a handoff with no edits preserves the Markdown bytes", async () => {
  const file = await createDocument("unchanged.md");
  const original = await readFile(file);
  const controller = new AbortController();
  // Exercise the browser-launch CLI phase while ROUGHDRAFT_NO_OPEN keeps CI headless.
  const pending = reviewDocument({ path: file, cwd: directory, env, signal: controller.signal, openBrowser: true });
  try {
    await waitUntilWatching(file);
    await emitReview(file);
    assert.equal((await pending).events[0].summary.unresolved, 0);
    assert.deepEqual(await readFile(file), original);
  } finally {
    controller.abort();
    await pending.catch(() => {});
  }
});

test("cancel aborts a pending review without stopping the shared Roughdraft server", async () => {
  const file = await createDocument("cancel.md");
  const controller = new AbortController();
  const pending = reviewDocument({ path: file, cwd: directory, env, signal: controller.signal, openBrowser: false });
  void pending.catch(() => {});
  await waitUntilWatching(file);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal((await fetch(new URL("/api/status", serverUrl))).status, 200);
});

test("optional overall timeout is distinguishable from a completed review", async () => {
  const file = await createDocument("timeout.md");
  await assert.rejects(reviewDocument({
    path: file, cwd: directory, env, signal: new AbortController().signal,
    openBrowser: false, timeoutSeconds: 1,
  }), { name: "TimeoutError" });
});

test("remote mode fails before opening or handing file contents to a remote host", async () => {
  await assert.rejects(reviewDocument({
    path: "unused.md", cwd: directory, signal: new AbortController().signal,
    env: { ...env, ROUGHDRAFT_HOST: "https://remote.example" },
  }), /Remote Roughdraft sessions are not supported/);
});
