# Security Policy

Claude Observatory is a local-first, zero-token review + observability layer over
Claude Code. It never makes model calls or network requests on its own (the only
network paths are the opt-in `analyze`/`recap`/`suggest` commands, which run your
local `claude` CLI, and `update`, which fetches a GitHub Release). Its data — the
content-addressed snapshot store — lives entirely on your machine under
`~/.claude/claude-observatory/`.

Because the store holds whole-file snapshots (often of secret-bearing files), we
take its handling seriously and welcome reports of anything that weakens it.

## Supported versions

Only the latest release line receives security fixes. We ship via GitHub
Releases (the marketplaces are unpublished), so "supported" means "the newest
tag."

| Version            | Supported          |
| ------------------ | ------------------ |
| Latest release (≥ 0.7.x) | ✅            |
| Older releases     | ❌ (please update: `claude-observatory update`) |

## Reporting a vulnerability

**Please do not open a public issue for security problems.** Instead, use one of
these private channels:

1. **GitHub Private Vulnerability Reporting** (preferred) — on the repository,
   go to the **Security** tab → **Report a vulnerability**. This opens a private
   advisory only you and the maintainers can see.
2. **Email** — **cell_observatory@berkeley.edu** with the subject line
   `SECURITY: claude-observatory`.

Please include:

- The version (`claude-observatory --version`) and OS.
- A description of the issue and its impact.
- Steps to reproduce, or a proof-of-concept, if you have one.

We aim to acknowledge a report within **3 business days** and to ship a fix or a
mitigation plan for confirmed, in-scope issues as promptly as we can. We'll keep
you updated through the private channel and credit you in the release notes
unless you prefer to remain anonymous.

## Scope

Things we especially want to hear about:

- A path that lets a crafted session id, file path, or CLI argument read, write,
  or delete outside the store (path traversal / `rm -rf` escape).
- The store or its blobs being created world- or group-readable (they are meant
  to be `0700` dirs / `0600` files).
- A capture path that persists a secret the redaction sweep should have filtered.
- The `siblings` / fleet digest leaking one session's file *contents* to another
  agent (by design it is read-only and path-only — it exposes counts, statuses,
  and file paths across sibling sessions in the same project, never file bodies).
- Any way the capture hooks could be coerced into executing attacker-controlled
  code.

Out of scope: vulnerabilities in Claude Code itself, the `claude` CLI, or your
editor — please report those to their respective projects.

## Good to know

- Capture, review, and all observability (actions, risk, egress, subagents,
  fleet, metrics) are **zero-token and local** — no telemetry, no network.
- Risk scoring and the egress report are themselves defensive features: they
  surface destructive/privileged shell commands and off-machine destinations a
  session touched, so you can audit what an agent did.
