import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { reviewDocument } from "../src/client.ts";

test("a missing Markdown file reports its resolved path and the next step", async (t) => {
  const cwd = await mkdtemp(path.join(process.cwd(), ".test-input-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await assert.rejects(reviewDocument({
    path: "missing.md", cwd, signal: new AbortController().signal,
    env: { ...process.env, ROUGHDRAFT_HOST: undefined },
  }), (error: Error) => {
    assert.ok(error.message.includes(path.join(cwd, "missing.md")));
    assert.match(error.message, /save.*file/i);
    return true;
  });
});

test("a missing CLI points to fork setup and identifies the attempted executable", async (t) => {
  const cwd = await mkdtemp(path.join(process.cwd(), ".test-input-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(path.join(cwd, "draft.md"), "# Draft\n");
  const binary = path.join(cwd, "missing-roughdraft");
  await assert.rejects(reviewDocument({
    path: "draft.md", cwd, signal: new AbortController().signal,
    env: { ...process.env, ROUGHDRAFT_HOST: undefined, ROUGHDRAFT_BIN: binary },
  }), (error: Error) => {
    assert.ok(error.message.includes(binary));
    assert.match(error.message, /https:\/\/github\.com\/pmbaumgartner\/roughdraft/);
    assert.match(error.message, /ROUGHDRAFT_BIN/);
    return true;
  });
});
