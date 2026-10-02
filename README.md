# pi-roughdraft v1

A local document-review handoff for Pi. Run `/roughdraft draft.md`, review in Roughdraft, and click **Done Reviewing** to bring the feedback back to the same Pi conversation.

## Recommendation

Roughdraft works with Pi's ordinary shell and file tools without an extension. Its CLI already opens a Markdown file, waits for a review handoff, and leaves feedback in the file. For occasional reviews, asking Pi to run `roughdraft open /absolute/path/draft.md --json` and then reread the file is sufficient.

This small extension is worthwhile for repeated use: it makes the workflow discoverable, shows the local review URL and status, supports cancellation, and protects against delivering feedback into a different session or conversation branch. It returns a compact handoff and lets Pi read the current file instead of copying the whole document into another tool response. It does not implement a Markdown parser or replace Roughdraft's editor.

Pi 1.0 includes native MCP support. However, Roughdraft 0.1.10's experimental MCP is **not directly interoperable** with that client: Roughdraft expects `Content-Length` framing while Pi sends newline-delimited JSON. A real connection attempt with Pi's MCP client timed out. Merely adding `roughdraft mcp` to Pi's configuration does not fix this release. This extension bypasses that transport; it is not a general MCP bridge.

Findings and version checks: October 2, 2026. Tested against `@earendil-works/pi-coding-agent@1.0.0`, `roughdraft@0.1.11-pmbaumgartner.1` (our packaging-only fork of 0.1.10), and Node 24.19 on Linux. Requires Node 22.19 or newer. Older `@mariozechner` Pi releases and Windows are not certified by this v1.

## Install

Install the tested Roughdraft fork:

```bash
npm install -g https://github.com/pmbaumgartner/roughdraft/releases/download/v0.1.11-pmbaumgartner.1/roughdraft-0.1.11-pmbaumgartner.1.tgz
roughdraft --version
```

This [temporary fork](https://github.com/pmbaumgartner/roughdraft) declares `yaml` as a runtime dependency, fixing the clean-install crash in upstream 0.1.10. The release includes the built app and server; no separate `yaml` installation or source build is needed. The application and review protocol are unchanged. `roughdraft --version` should print `0.1.11-pmbaumgartner.1`. If Roughdraft was already running, finish any active review and run `roughdraft stop` once so the next review starts the installed version.

The fork is a temporary packaging fix. To return to upstream after it publishes a verified fix, run `npm install -g roughdraft@<fixed-version>`; the extension will continue using the `roughdraft` executable on your `PATH`.

Then register the extension with your existing Pi 1.0 installation:

```bash
pi install git:github.com/pmbaumgartner/pi-roughdraft
```

Start Pi, or run `/reload` in a running session. No build or manual `npm install` in this extension folder is required for ordinary use; Pi supplies its extension API and TypeBox. Git installation does not install development dependencies, so Roughdraft remains a separate prerequisite.

To remove it, use `pi remove git:github.com/pmbaumgartner/pi-roughdraft` and reload. Run `pi update --extensions` to update installed extensions.

For a downloaded source archive or local checkout, use `pi install /absolute/path/to/pi-roughdraft` instead. Keep that folder somewhere permanent: Pi links to local packages rather than copying them. Remove a local installation with `pi remove /absolute/path/to/pi-roughdraft`.

## Use

```text
/roughdraft ./docs/plan.md
/roughdraft "./docs/plan with spaces.md"
/roughdraft status
/roughdraft cancel
```

The full argument is a file path, so unquoted spaces also work. Relative paths use Pi's session directory. Use a prefix such as `./` if a path could be confused with a subcommand. Save an existing `.md` file first. A bare `/roughdraft` shows help.

The command requires an idle interactive Pi session. The TUI stays usable during review. Leave the reviewed file alone until the handoff; this extension does not lock files or block other programs from editing them.

The agent also gets a sequential `roughdraft_review` tool:

```json
{
  "path": "docs/plan.md",
  "openBrowser": true,
  "timeoutSeconds": 1800
}
```

`openBrowser` defaults to true. Omit `timeoutSeconds` to wait indefinitely for the human; there is no model turn polling. Setting `openBrowser` to false returns the local URL in the tool's progress output. The tool supports Pi's cancellation signal and works without a TUI. The command keeps completed feedback under its control until Pi is idle, checks that the review still belongs to this session, then starts the follow-up with a custom extension message. The tool returns feedback in its existing turn.

After Done Reviewing, Pi is instructed to reread the current Markdown, address feedback within the original request, and preserve review metadata and unrelated edits. Suggestions remain review input; finishing review does not mean the user approved implementing the entire plan. The extension itself never edits, accepts, resolves, or deletes feedback.

Only one review is active per extension instance, including feedback waiting for Pi to become idle. Cancellation, reload, session switching, forking, and tree navigation stop the local handoff. Pending reviews do not survive restarting Pi; open the file again. Cancel leaves the browser and shared Roughdraft server open; finish saving any pending edits in Roughdraft. A canceled navigation attempt also ends the review conservatively.

## Configuration and boundaries

- `ROUGHDRAFT_BIN`: optional executable path, useful for a local install or development wrapper. It is one executable, not a shell command. Defaults to `roughdraft` on `PATH`.
- `ROUGHDRAFT_NO_OPEN=1`: keep browser launching disabled and use the displayed URL.
- Roughdraft's normal port and state-directory environment variables are inherited.
- `ROUGHDRAFT_HOST` must be unset. Remote/SSE sessions use a different protocol and are outside v1; the adapter rejects them before opening a document.

Pi, Roughdraft, and the file must run on the same computer for the default browser workflow. SSH/container use needs browser access or port forwarding arranged separately. No document contents are sent to a hosted Roughdraft service by this adapter. Once Pi reads the file, its configured model/provider handles that content under Pi's normal settings.

The adapter bootstraps through the CLI, establishes a review cursor, then waits on Roughdraft's local HTTP review-event API with 15-second long polls. The cursor catches handoffs between requests and excludes previous reviews. Polls run locally without LLM calls. A server restart fails the review rather than silently reconnecting to a fresh event history.

The HTTP endpoints are an upstream implementation contract, not a promised stable external API. Changes to Roughdraft may require updating `src/client.ts`; use the tested version for predictable behavior. The server currently does not remove a watcher on client disconnect, so its UI can still show an active watcher for up to 15 seconds after cancellation. The extension will not resume a canceled review. Roughdraft retains only 100 events, so it cannot recover arbitrarily long gaps or server restarts.

## Develop and verify

```bash
npm ci --ignore-scripts
npm run check
npm test
```

Tests use an isolated state directory and a real Roughdraft local server, stop that server afterward, and do not launch a browser. They need permission to spawn local processes and bind loopback ports. The development dependency uses the same pinned fork release as the installation instructions; `yaml` is supplied by Roughdraft itself.

The integration tests exercise fresh handoffs, exclusion of old events, persisted overall comments, unusual filenames, byte preservation when no edits occur, cancellation without stopping the shared server, review deadlines, and rejection of remote mode. Protocol-boundary tests cover malformed feedback, wrong documents, restarted servers, and watcher failure during a blocked browser launch. Pi registration tests exercise command/tool behavior, delivery after Pi becomes idle, and lifecycle races. No provider credentials or model calls are required.

Validation also included a real Pi package install/load and a direct native MCP connection attempt. Desktop browser launching and a paid model completing the reply loop were not exercised in this environment. On your machine, open a short document, add a comment, click Done Reviewing, and verify Pi reads the updated file. This is the remaining desktop acceptance check.

## Sources and design dependencies

- [Tested Roughdraft fork](https://github.com/pmbaumgartner/roughdraft), [upstream Roughdraft](https://www.roughdraft.md/), and its [README / CLI reference](https://github.com/Lex-Inc/roughdraft).
- [Roughdraft source inspected at commit 686919e](https://github.com/Lex-Inc/roughdraft/tree/686919ec0a3a0648fd2f1fdb2665816fb4b10608): `packages/server/src/cli.ts`, `index.ts`, `review-events.ts`, and `mcp.ts`.
- [Roughdraft Flavored Markdown specification](https://roughdraft.md/spec/roughdraft-flavored-markdown.md).
- [Pi native MCP documentation](https://pi.dev/docs/latest/mcp), [extensions](https://pi.dev/docs/latest/extensions), and [packages](https://pi.dev/docs/latest/packages).
- [Pi stdio transport implementation](https://github.com/earendil-works/pi/blob/main/packages/mcp/src/transports/stdio.ts); published `@earendil-works/pi-mcp@1.0.0` was used for the interoperability probe.

If Roughdraft fixes its MCP framing and adds a reliable native open/review handoff, reassess whether this extension still earns its upkeep. Until then, the CLI alone is the lowest-maintenance baseline; this extension adds the Pi-specific interaction and lifecycle handling.
