import assert from "node:assert/strict";
import { cpSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const source =
  process.argv[2] && process.argv[2] !== "--check"
    ? path.resolve(process.argv[2])
    : fileURLToPath(
        new URL(
          "../node_modules/roughdraft/packages/skill/roughdraft/",
          import.meta.url,
        ),
      );
const destination = fileURLToPath(
  new URL("../skills/roughdraft/", import.meta.url),
);
if (process.argv.includes("--check")) {
  function compare(relative = "") {
    for (const entry of readdirSync(path.join(source, relative), {
      withFileTypes: true,
    })) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) compare(name);
      else
        assert.equal(
          readFileSync(path.join(destination, name), "utf8"),
          readFileSync(path.join(source, name), "utf8"),
          `Bundled skill differs: ${name}`,
        );
    }
  }
  compare();
  console.log("Bundled skill matches the tested Roughdraft package.");
} else {
  // Read first so an unavailable source cannot erase the current bundled skill.
  readFileSync(path.join(source, "SKILL.md"), "utf8");
  rmSync(destination, { recursive: true, force: true });
  cpSync(source, destination, { recursive: true });
  console.log("Synced the canonical Roughdraft skill.");
}
