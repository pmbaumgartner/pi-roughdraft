# Environment setup

Use Node.js 24 and npm. Install the built fork release linked in the Roughdraft README for normal use; source archives need a build. `roughdraft agent-setup` prints installation guidance. `roughdraft skill install <supported-skill-root>/roughdraft` installs this skill at an explicitly chosen directory; `--force` updates that skill. Restart or reload the agent's skills afterward. Choose its documented skill root (for example a project's `.agents/skills` for Pi/Codex, or `.claude/skills` for Claude Code). Never substitute a global instruction file.

Pi can discover the extension and this skill together:

```bash
pi install git:github.com/pmbaumgartner/pi-roughdraft
```

For source development, run the following from the directory that should contain both repositories:

```bash
workspace_root="$PWD"
git clone https://github.com/pmbaumgartner/roughdraft.git
git clone https://github.com/pmbaumgartner/pi-roughdraft.git
mkdir -p "$workspace_root/.tooling/package-manager" "$workspace_root/.tooling/bin" "$workspace_root/tmp"
npm install --prefix "$workspace_root/.tooling/package-manager" --no-audit --no-fund pnpm@10.11.0
export PATH="$workspace_root/.tooling/package-manager/node_modules/.bin:$workspace_root/.tooling/bin:$PATH"
export TMPDIR="$workspace_root/tmp"
export ROUGHDRAFT_DEV_BIN_DIR="$workspace_root/.tooling/bin"
export ROUGHDRAFT_DEV_STATE_BASE_DIR="$workspace_root/.tooling/roughdraft-state"
cd "$workspace_root/roughdraft"
pnpm run setup
export ROUGHDRAFT_BIN="$ROUGHDRAFT_DEV_BIN_DIR/roughdraft-dev-$(basename "$PWD")"
cd "$workspace_root/pi-roughdraft"
npm ci
export PATH="$PWD/node_modules/.bin:$PATH"
export PI_CODING_AGENT_DIR="$workspace_root/.tooling/pi-agent"
export PI_TELEMETRY=0
export PI_OFFLINE=1
unset ROUGHDRAFT_HOST
pi install "$PWD"
```

Reuse existing clones instead of cloning over them. Keep these exports in a workspace-local shell profile if needed. The development wrapper and Pi config are isolated from the user's normal installation. Do not copy credentials into that profile.

Verify:

```bash
cd "$workspace_root/roughdraft"
env -u ROUGHDRAFT_NO_OPEN -u ROUGHDRAFT_BIN pnpm check
pnpm test:package
pnpm exec playwright install --with-deps chromium
pnpm test:smoke
cd "$workspace_root/pi-roughdraft"
npm run check
node --import tsx --test tests/*.test.ts
npm run test:acceptance
```

Some managed runtimes block Unix sockets used by the `tsx` executable. Invoke TypeScript scripts with `node --import tsx` there. If fixture shebangs fail because `process.execPath` reports a relative `node`, use the runtime's absolute Node binary or a workspace-local wrapper. Keep temporary test documents in a non-hidden temporary directory: Express's default dotfile policy can otherwise hide served assets.

Browser launch must actually succeed before claiming browser verification. A runtime that exits Chromium before assertions needs the normal-runner CI smoke/acceptance gate. Model-backed acceptance additionally needs an already configured provider; `pi auth check --provider <provider> --json --no-refresh` reports readiness without exposing credentials. Do not pass `--credentials`. The default acceptance test uses an explicit deterministic provider and needs no paid API calls.
