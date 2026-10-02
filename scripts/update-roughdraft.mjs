import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const temporary = mkdtempSync(path.join(tmpdir(), "roughdraft-update-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 120000,
    shell: process.platform === "win32" && command.endsWith(".cmd"),
  });
  assert.equal(
    result.status,
    0,
    `${command} failed: ${result.error || result.stderr}`,
  );
  return result.stdout;
}
async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  assert.ok(response.ok, `Download failed: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}
try {
  const specified = process.argv[2];
  const localIndex = process.argv.indexOf("--archive");
  const localArchive =
    localIndex === -1 ? undefined : process.argv[localIndex + 1];
  assert.ok(
    !localArchive || specified,
    "Local release preparation requires an explicit version",
  );
  const version =
    specified ||
    JSON.parse(
      (
        await download(
          "https://api.github.com/repos/pmbaumgartner/roughdraft/releases/latest",
        )
      ).toString(),
    ).tag_name.replace(/^v/, "");
  assert.match(version, /^\d+\.\d+\.\d+-pmbaumgartner\.\d+$/);
  const filename = `roughdraft-${version}.tgz`;
  const url = `https://github.com/pmbaumgartner/roughdraft/releases/download/v${version}/${filename}`;
  const checksums = localArchive
    ? readFileSync(
        path.join(path.dirname(path.resolve(localArchive)), "SHA256SUMS"),
        "utf8",
      )
    : (
        await download(
          `https://github.com/pmbaumgartner/roughdraft/releases/download/v${version}/SHA256SUMS`,
        )
      ).toString();
  const expected = checksums
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .find((entry) => entry[1] === filename)?.[0];
  assert.match(expected || "", /^[a-f0-9]{64}$/);
  const archive = localArchive
    ? readFileSync(path.resolve(localArchive))
    : await download(url);
  assert.equal(
    createHash("sha256").update(archive).digest("hex"),
    expected,
    "Release checksum mismatch",
  );
  const archivePath = path.join(temporary, filename);
  writeFileSync(archivePath, archive);
  const previousVersion = JSON.parse(
    readFileSync(path.join(root, "package-lock.json"), "utf8"),
  ).packages["node_modules/roughdraft"].version;
  run(npm, [
    "install",
    "--save-dev",
    "--save-exact",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    archivePath,
  ]);
  const packagePath = path.join(root, "package.json");
  const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
  manifest.devDependencies.roughdraft = url;
  writeFileSync(packagePath, `${JSON.stringify(manifest, null, 2)}\n`);
  const lockPath = path.join(root, "package-lock.json");
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  lock.packages[""].devDependencies.roughdraft = url;
  lock.packages["node_modules/roughdraft"].resolved = url;
  assert.equal(
    lock.packages["node_modules/roughdraft"].version,
    version,
    "Archive version mismatch",
  );
  assert.equal(
    lock.packages["node_modules/roughdraft"].integrity,
    `sha512-${createHash("sha512").update(archive).digest("base64")}`,
    "Lock integrity must describe the verified bytes",
  );
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  run(process.execPath, ["scripts/sync-skill.mjs"]);
  const readmePath = path.join(root, "README.md");
  writeFileSync(
    readmePath,
    readFileSync(readmePath, "utf8")
      .replaceAll(previousVersion, version)
      .replace(
        /https:\/\/github\.com\/pmbaumgartner\/roughdraft\/releases\/download\/v[^/\s]+\/roughdraft-[^\s`]+\.tgz/g,
        url,
      ),
  );
  console.log(
    `Updated verified Roughdraft dependency and skill to ${version}. Run checks and acceptance before merging.`,
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
