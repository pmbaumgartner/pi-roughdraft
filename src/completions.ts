import { readdir, stat } from "node:fs/promises";
import path from "node:path";

const commands = [
  { value: "reopen", label: "reopen", description: "Start another review of the last file in this branch" },
  { value: "status", label: "status", description: "Show the active review" },
  { value: "cancel", label: "cancel", description: "Stop waiting for review feedback" },
  { value: "help", label: "help", description: "Show Roughdraft usage" },
];

/** Pi replaces the entire argument and handles paired double quotes around paths. */
export async function reviewCompletions(prefix: string, cwd: string) {
  // Pi cannot consume a closing single quote after the cursor. Let users type these paths.
  if (prefix.startsWith("'")) return null;
  const suggestions = commands.filter((command) => command.value.startsWith(prefix));
  const quoted = prefix.startsWith('"');
  const input = quoted ? prefix.slice(1, prefix.endsWith('"') && prefix.length > 1 ? -1 : undefined) : prefix;
  const separator = Math.max(input.lastIndexOf(path.sep), input.lastIndexOf("/"));
  const directory = input.slice(0, separator + 1);
  const partialName = input.slice(separator + 1).toLowerCase();
  let entries;
  try {
    entries = await readdir(path.resolve(cwd, directory), { withFileTypes: true });
  } catch {
    // Completion is optional; the review command reports actionable file errors.
    return suggestions.length ? suggestions : null;
  }
  const paths = await Promise.all(entries.map(async (entry) => {
    if (!entry.name.toLowerCase().startsWith(partialName)) return undefined;
    let info: Pick<typeof entry, "isDirectory" | "isFile"> = entry;
    if (entry.isSymbolicLink()) {
      const target = await stat(path.resolve(cwd, directory, entry.name)).catch(() => undefined);
      if (!target) return undefined;
      info = target;
    }
    const isDirectory = info.isDirectory();
    if (!isDirectory && (!info.isFile() || path.extname(entry.name).toLowerCase() !== ".md")) return undefined;
    const label = directory + entry.name + (isDirectory ? path.sep : "");
    return { value: quoted ? `"${label}"` : label, label, description: isDirectory ? "Directory" : "Markdown file" };
  }));
  suggestions.push(...paths.filter((item) => item !== undefined).sort((a, b) => a.value.localeCompare(b.value)));
  return suggestions.length ? suggestions : null;
}
