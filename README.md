# pi-roughdraft v1

A local document-review handoff for Pi. Run `/roughdraft draft.md`, review in Roughdraft, and click **Finish review** to bring the feedback back to the same Pi conversation.

## Recommendation

Roughdraft works with Pi's ordinary shell and file tools without an extension. Its CLI already opens a Markdown file, waits for a review handoff, and leaves feedback in the file. For occasional reviews, asking Pi to run `roughdraft open /absolute/path/draft.md --json` and then reread the file is sufficient.

This small extension is worthwhile for repeated use: it makes the workflow discoverable, shows the local review URL and status, supports cancellation, and protects against delivering feedback into a different session or conversation branch. It returns a compact handoff and lets Pi read the current file instead of copying the whole document into another tool response. It does not implement a Markdown parser or replace Roughdraft's editor.

Pi 1.0's native MCP client works with the tested fork's newline-delimited stdio transport. The extension adds the browser review handoff, progress, conversation ownership, cancellation, and receipt confirmation; it remains useful alongside native MCP.

Tested with `@earendil-works/pi-coding-agent@1.0.0` and the Roughdraft fork linked below. Use Node 24 for development; the extension requires Node 22.19 or newer.

## Install

Install the tested Roughdraft fork:

```bash
npm install -g https://github.com/pmbaumgartner/roughdraft/releases/download/v0.1.11-pmbaumgartner.3/roughdraft-0.1.11-pmbaumgartner.3.tgz
roughdraft --version
```

This [fork](https://github.com/pmbaumgartner/roughdraft) declares `yaml` as a runtime dependency, fixing the clean-install crash in upstream 0.1.10. The release includes the built app and server; no separate `yaml` installation or source build is needed. It also includes review workflow fixes for reply visibility, code-block preservation, and watch cancellation. `roughdraft --version` should print `0.1.11-pmbaumgartner.3`. If Roughdraft was already running, finish any active review and run `roughdraft stop` once so the next review starts the installed version.

To return to upstream after it includes and verifies the fixes you need, run `npm install -g roughdraft@<fixed-version>`; the extension will continue using the `roughdraft` executable on your `PATH`.

Then register the extension with your existing Pi 1.0 installation:

```bash
pi install git:github.com/pmbaumgartner/pi-roughdraft
```

Start Pi, or run `/reload` in a running session. No build or manual `npm install` in this extension folder is required for ordinary use; Pi supplies its extension API and TypeBox. Git installation does not install development dependencies, so Roughdraft remains a separate prerequisite. The package also installs the portable `roughdraft` Agent Skill, including environment setup instructions. It does not edit user AGENTS.md or other global instruction files.

To remove it, use `pi remove git:github.com/pmbaumgartner/pi-roughdraft` and reload. Run `pi update --extensions` to update installed extensions.

For a downloaded source archive or local checkout, use `pi install /absolute/path/to/pi-roughdraft` instead. Keep that folder somewhere permanent: Pi links to local packages rather than copying them. Remove a local installation with `pi remove /absolute/path/to/pi-roughdraft`.

## Use

```text
/roughdraft ./docs/plan.md
/roughdraft "./docs/plan with spaces.md"
/roughdraft reopen
/roughdraft status
/roughdraft cancel
```

The full argument is a file path, so unquoted spaces also work. Relative paths use Pi's session directory. Use a prefix such as `./` if a path could be confused with a subcommand. Save an existing `.md` file first. A bare `/roughdraft` shows help. Tab completion offers subcommands, directories, and Markdown files, including paths with spaces; use unquoted paths or double quotes for completion.

`/roughdraft reopen` starts a fresh review of the last successfully opened file in the current conversation branch. It also works after `/roughdraft cancel`; it waits for a new handoff and does not resume canceled feedback. Reopen history is kept in memory and cleared on reload, session switching, forking, or tree navigation, including canceled navigation attempts. If there is no previous file, the command explains how to start a review.

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

After Finish review, Pi is instructed to reread the current Markdown, address feedback within the original request, and preserve review metadata and unrelated edits. Suggestions remain review input; finishing review does not mean the user approved implementing the entire plan. The extension itself never edits, accepts, resolves, or deletes feedback.

Only one review is active per extension instance, including feedback waiting for Pi to become idle. Cancellation, reload, session switching, forking, and tree navigation stop the local handoff. Pending reviews do not survive restarting Pi; open the file again. Cancel leaves the browser and shared Roughdraft server open; finish saving any pending edits in Roughdraft. A canceled navigation attempt also ends the review conservatively.

## Configuration and boundaries

- `ROUGHDRAFT_BIN`: optional executable path, useful for a local install or development wrapper. It is one executable, not a shell command. Defaults to `roughdraft` on `PATH`.
- `ROUGHDRAFT_NO_OPEN=1`: keep browser launching disabled and use the displayed URL.
- Roughdraft's normal port and state-directory environment variables are inherited.
- `ROUGHDRAFT_HOST` must be unset. Remote/SSE sessions use a different protocol and are outside v1; the adapter rejects them before opening a document.

Pi, Roughdraft, and the file must run on the same computer for the default browser workflow. SSH/container use needs browser access or port forwarding arranged separately. No document contents are sent to a hosted Roughdraft service by this adapter. Once Pi reads the file, its configured model/provider handles that content under Pi's normal settings.

The adapter bootstraps quietly through the CLI, creates a scoped review identity before exposing its browser URL, establishes a review cursor, then waits on Roughdraft's local HTTP review-event API with 15-second long polls. The cursor catches handoffs between requests and excludes previous reviews. Polls run locally without LLM calls. A server restart fails the review rather than silently reconnecting to a fresh event history.

The HTTP endpoints are an upstream implementation contract, not a promised stable external API. Changes to Roughdraft may require updating `src/client.ts`; use the tested version for predictable behavior. The tested fork removes a watcher when its client disconnects. The extension will not resume a canceled review. Scoped sessions retain their own completion until receipt/cancellation and terminal-session eviction; the legacy queue retains only 100 events. Server restarts require a fresh review. Older servers still use the legacy document watcher and cannot confirm receipt.

## Develop and verify

```bash
npm ci --ignore-scripts
npm run check
npm test
```

Tests use an isolated state directory and a real Roughdraft local server, stop that server afterward, and do not launch a browser. They need permission to spawn local processes and bind loopback ports. The development dependency uses the same pinned fork release as the installation instructions; `yaml` is supplied by Roughdraft itself.

The integration tests exercise fresh handoffs, exclusion of old events, persisted overall comments, unusual filenames, byte preservation when no edits occur, cancellation without stopping the shared server, review deadlines, and rejection of remote mode. Protocol-boundary tests cover malformed feedback, wrong documents, restarted servers, and watcher failure during a blocked browser launch. Pi registration tests exercise command/tool behavior, explicit reopening, file completion, delivery after Pi becomes idle, and lifecycle races. Input tests check actionable missing-file and fork-setup errors. No provider credentials or model calls are required.

Run the actual Pi host and native MCP acceptance check without provider credentials:

```bash
npm run skill:check
npm run test:acceptance
npx playwright install --with-deps chromium
npm run test:acceptance:browser
```

The default acceptance provider is explicitly deterministic: the real Pi agent calls the extension, waits for completion, and uses Pi's read tool to reread saved feedback. Browser acceptance opens the actual built Roughdraft app, submits an overall comment, and waits for **Received by Pi**. CI runs both. Managed runtimes that block Chromium launch must use the normal-runner CI gate.

For a bounded live-model check with an already configured provider, select the provider and model explicitly. This makes model API calls:

```bash
pi auth check --provider <provider> --json --no-refresh
npm run test:acceptance:browser -- --live --provider <provider> --model <model-id>
```

Receipt confirms acceptance by the owning Pi job, not that a model finished processing feedback. Queued feedback remains cancellable while Pi is busy; navigating to another conversation cancels the handoff. Saved Markdown remains available.

## Refresh the tested Roughdraft release

```bash
npm run roughdraft:update -- <fork-version>
npm run check
npm test
npm run skill:check
npm run test:acceptance:browser
```

Omit the version to use GitHub Latest. The update verifies SHA256SUMS before installing exact archive bytes, regenerates lockfile integrity, updates install links, and copies the canonical skill from that package. The **Update Roughdraft dependency** workflow performs these steps and opens a checked update PR with one dispatch. This does not require a token shared between repositories; dispatch it after a fork release. GitHub's workflow setting must allow its GITHUB_TOKEN to create pull requests.

## Sources and design dependencies

- [Tested Roughdraft fork](https://github.com/pmbaumgartner/roughdraft), [upstream Roughdraft](https://www.roughdraft.md/), and its [README / CLI reference](https://github.com/Lex-Inc/roughdraft).
- [Roughdraft source inspected at commit 686919e](https://github.com/Lex-Inc/roughdraft/tree/686919ec0a3a0648fd2f1fdb2665816fb4b10608): `packages/server/src/cli.ts`, `index.ts`, `review-events.ts`, and `mcp.ts`.
- [Roughdraft Flavored Markdown specification](https://roughdraft.md/spec/roughdraft-flavored-markdown.md).
- [Pi native MCP documentation](https://pi.dev/docs/latest/mcp), [extensions](https://pi.dev/docs/latest/extensions), and [packages](https://pi.dev/docs/latest/packages).
- [Pi stdio transport implementation](https://github.com/earendil-works/pi/blob/main/packages/mcp/src/transports/stdio.ts); published `@earendil-works/pi-mcp@1.0.0` was used for the interoperability probe.

Use native MCP for review-index, reply, and resolution tools. Use this extension for the scoped Pi/browser handoff and lifecycle handling.
