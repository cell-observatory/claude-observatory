# Remote development (SSH & devcontainers)

Claude Observatory runs wherever **Claude Code, your transcripts, the edit store, and the status line
cache** live — which on remote setups is the **remote host**, not your laptop. The VS Code extension is
declared `extensionKind: workspace`, and the JetBrains plugin uses only platform APIs (no JCEF), so both
install and run **on the remote**. Everything below is about installing on that host.

← Back to the [README](../README.md).

## Over SSH (no container)

1. Connect the Remote-SSH window to the host.
2. In the **remote** terminal, install the CLI + hooks with the bootstrap one-liner (it pulls the latest
   release — no build toolchain needed on the host):

   ```bash
   curl -fsSL https://raw.githubusercontent.com/cell-observatory/claude-observatory/main/scripts/bootstrap.sh | bash
   ```

   Then run `claude-observatory init` with Claude Code closed. (Prefer not to pipe curl to bash? Clone and
   run `./install.sh`, or copy a release `.tgz` and `npm i -g ./claude-observatory-<ver>.tgz`.)
3. Install the status line **on the remote** so the Usage bars populate — it's bundled with the CLI:
   `claude-observatory statusline` in the remote terminal (no network needed).
4. Install the extension **into the remote**: Extensions view → the `.vsix` → **"Install in SSH: \<host\>"**,
   or run `code --install-extension claude-observatory.vsix` in the remote terminal (VS Code puts `code` on
   the remote PATH there).

## JetBrains Gateway / Toolbox (PyCharm etc.) over SSH

The plugin needs no special build — it uses only platform APIs (and no JCEF), so it installs **"On Host"**
and runs entirely on the backend, next to `~/.claude`, with the tool windows / status bar remoted to the
JetBrains Client. Steps 2–3 above (CLI + hooks + status line **on the remote**) apply unchanged; then:

1. Install the plugin **on the host**: run `./scripts/install-jetbrains.sh` in the remote terminal (it knows
   the desktop-Linux and remote-dev backend plugin dirs), or unzip a release into
   `~/.local/share/JetBrains/<Product><Version>/`. Restart the backend afterwards.
2. The backend is launched by sshd, **not a login shell** — `CLAUDE_CONFIG_DIR` or PATH exports in
   `~/.bashrc` / `~/.zshrc` are invisible to it. If Stats says the CLI is missing or the store looks empty,
   set the CLI path and config dir explicitly in **Settings → Tools → Claude Observatory** (a host-side setting).
3. On some remote-dev layouts host plugins are **per project** — if the tool windows don't appear after
   opening a different remote project, re-run the install script.

## Inside a devcontainer

Copy the ready-to-use template in [devcontainer/](devcontainer/) into your `.devcontainer/`. It sets `TZ`
(so Stats bucket correctly), points `CLAUDE_CONFIG_DIR` at a **persistent volume** (so Edits/Stats survive
rebuilds), and provisions the CLI + status line + hooks via `postCreateCommand`.

## Relocating the config dir

Everything the observatory reads/writes lives under `CLAUDE_CONFIG_DIR` (default `~/.claude`) — the edit
store, transcripts, capture hooks, and the status line cache all follow it. Point it at a mounted volume to
persist history across container rebuilds; set the **same** value for Claude Code, the status line, and the
extension host (a container-level env var covers all three).

## Two gotchas

- The `claude-observatory` CLI (Stats) and `claude` (opt-in Analyze) must be on the **remote** PATH. The
  Stats tab shows an install hint if the CLI is missing, and the Usage bars show one if the status line
  isn't writing on that host.
- Set `TZ` on the remote, or the Stats plots bucket by the remote's timezone (usually UTC in a container)
  instead of yours.
