import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { reviewDocument, type ReviewEvent, type ReviewOptions } from "../src/client.ts";

interface ServerScenario {
  event?: Partial<ReviewEvent>;
  restarted?: boolean;
  watchErrorDuringLaunch?: boolean;
}

async function fixture(t: TestContext, scenario: ServerScenario = {}): Promise<ReviewOptions> {
  const directory = await mkdtemp(path.join(process.cwd(), ".test-boundary-"));
  const file = path.join(directory, "draft.md");
  const binary = path.join(directory, "roughdraft-fixture.mjs");
  let launchStarted!: () => void;
  const launched = new Promise<void>((resolve) => { launchStarted = resolve; });
  let watchCount = 0;
  let statusCount = 0;
  const server = http.createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/launch") {
      launchStarted();
      response.end("{}");
      return;
    }
    if (request.url === "/api/status") {
      statusCount += 1;
      response.end(JSON.stringify({ backend: "local-files", pid: scenario.restarted && statusCount > 1 ? 2 : 1 }));
      return;
    }
    assert.equal(request.url, "/api/review-events/watch");
    watchCount += 1;
    if (watchCount === 1) {
      response.end(JSON.stringify({ events: [], timedOut: true, nextSequence: 2 }));
      return;
    }
    if (scenario.watchErrorDuringLaunch) {
      await launched;
      response.writeHead(503).end("{}");
      return;
    }
    response.end(JSON.stringify({
      events: [{
        type: "review.completed", documentPath: file, projectPath: directory, relativePath: "draft.md",
        version: "test-version", sequence: 2, createdAt: "2026-10-02T12:00:00.000Z",
        summary: { comments: 1, replies: 0, suggestions: 0, unresolved: 1 },
        ...scenario.event,
      }],
      timedOut: false,
      nextSequence: 3,
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(file, "# Review me\n");
  await writeFile(binary, `#!${process.execPath}
const serverUrl = process.env.TEST_SERVER_URL;
if (!process.argv.includes("--no-open")) {
  await fetch(new URL("/launch", serverUrl));
  await new Promise(() => setInterval(() => {}, 1000));
}
console.log(JSON.stringify({ opened: true, path: process.argv[3], serverUrl, url: serverUrl + "/review" }));
`, { mode: 0o700 });
  return {
    path: file, cwd: directory, signal: new AbortController().signal,
    openBrowser: false, timeoutSeconds: 2,
    env: { ...process.env, ROUGHDRAFT_HOST: undefined, ROUGHDRAFT_BIN: binary, TEST_SERVER_URL: url },
  };
}

test("watch failure ends a review even while the browser launcher is blocked", { timeout: 5_000 }, async (t) => {
  const options = await fixture(t, { watchErrorDuringLaunch: true });
  await assert.rejects(reviewDocument({ ...options, openBrowser: true }), /HTTP 503/);
});

test("feedback for another file cannot complete the requested review", async (t) => {
  const options = await fixture(t, { event: { documentPath: "/another/draft.md" } });
  await assert.rejects(reviewDocument(options), /invalid or mismatched review event/);
});

test("a server restart cannot deliver feedback from a new event history", async (t) => {
  const options = await fixture(t, { restarted: true });
  await assert.rejects(reviewDocument(options), /Roughdraft restarted/);
});

test("feedback older than the review cursor cannot complete the review", async (t) => {
  const options = await fixture(t, { event: { sequence: 1 } });
  await assert.rejects(reviewDocument(options), /earlier review/);
});

test("invalid feedback counts cannot reach the review handoff", async (t) => {
  const options = await fixture(t, { event: { summary: { comments: -1, replies: 0, suggestions: 0, unresolved: 0 } } });
  await assert.rejects(reviewDocument(options), /invalid/);
});
