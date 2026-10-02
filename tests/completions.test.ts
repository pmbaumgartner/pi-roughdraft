import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { reviewCompletions } from "../src/completions.ts";

// Use the same TUI version as the installed Pi host, without relying on its package layout.
const hostRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { CombinedAutocompleteProvider } = await import(pathToFileURL(hostRequire.resolve("@earendil-works/pi-tui")).href);

test("Pi applies quoted directory and file completions without duplicating the closing quote", async (t) => {
  const cwd = await mkdtemp(path.join(process.cwd(), ".test-completion-ui-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(path.join(cwd, "docs with spaces"));
  await writeFile(path.join(cwd, "docs with spaces", "Plan.md"), "# Plan\n");
  const provider = new CombinedAutocompleteProvider([{
    name: "roughdraft", getArgumentCompletions: (prefix: string) => reviewCompletions(prefix, cwd),
  }], cwd);
  const line = '/roughdraft "do"';
  const suggestions = await provider.getSuggestions([line], 0, line.length - 1, {});
  assert.equal(suggestions.items.length, 1);
  const directory = provider.applyCompletion([line], 0, line.length - 1, suggestions.items[0], suggestions.prefix);
  assert.equal(directory.lines[0], `/roughdraft "docs with spaces${path.sep}"`);
  assert.equal(directory.cursorCol, directory.lines[0].length - 1);

  const nextLine = `${directory.lines[0].slice(0, directory.cursorCol)}Pl"`;
  const files = await provider.getSuggestions([nextLine], 0, nextLine.length - 1, {});
  const file = provider.applyCompletion([nextLine], 0, nextLine.length - 1, files.items[0], files.prefix);
  assert.equal(file.lines[0], `/roughdraft "${path.join("docs with spaces", "Plan.md")}"`);
  assert.equal(file.cursorCol, file.lines[0].length);
});
