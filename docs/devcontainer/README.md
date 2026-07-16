# Devcontainer template

A copy-paste starting point for running Claude Observatory (and
[claude-statusline](https://github.com/cell-observatory/claude-statusline)) inside a
[devcontainer](https://containers.dev). It solves the three things that break when Claude Code runs
in a container instead of on your laptop:

| Problem | Fix in this template |
| --- | --- |
| **Stats plots bucket by the wrong day/hour** — the container runs UTC. | `TZ` in `containerEnv`. |
| **Edits / Stats reset to empty on every rebuild** — the store lives on the throwaway layer. | `CLAUDE_CONFIG_DIR` on a named **volume** (`mounts`). |
| **Usage bars stay blank** — the status line isn't installed in the container. | `setup.sh` installs it into the same config dir. |

## Use it

1. Copy `devcontainer.json` **and** `setup.sh` into your project's `.devcontainer/` directory.
2. Edit the marked lines: set `TZ` to your timezone, keep `CLAUDE_CONFIG_DIR` and the volume `target`
   in sync, and swap the base `image`/`features` for whatever your project already uses.
3. Rebuild the container. `setup.sh` (via `postCreateCommand`) installs `jq`, the `claude-observatory`
   CLI, the status line, and the capture hooks under the persistent config dir.
4. Install the extension into the container (it's a private `.vsix`, not on the Marketplace) — the
   command is printed at the end of `setup.sh`.
5. Smoke-test the setup without Claude: `claude-observatory demo` works inside the container (the store
   honors `CLAUDE_CONFIG_DIR`) — watch the panels fill in live, then `claude-observatory demo --clean`
   removes every trace.

See the repo [README](../../README.md#remote-development-ssh--devcontainers) for the full remote /
SSH story, including setups **without** a devcontainer.
