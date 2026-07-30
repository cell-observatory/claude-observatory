<#
.SYNOPSIS
  Claude Observatory — one-command install / update for Windows. No bash, no Git Bash, no WSL.

.DESCRIPTION
  The PowerShell peer of scripts/bootstrap.sh: downloads a GitHub Release and installs the CLI, then
  the editor extensions for whatever editors are on this machine, then optionally the capture hooks.

  Everything after the CLI is one call to `claude-observatory install-extensions`, so editor detection,
  asset download, sha256 verification and the Windows `.cmd` shim rules all live in the CLI rather than
  being reimplemented here. That is the whole reason this file can be short.

  There was no native Windows install path before this. The documented one-liner was
  `curl … | bash`, which on Windows either fails ("bash is not recognized") or — worse, if WSL is
  installed — silently installs everything INSIDE WSL, where Claude Code on the Windows side can never
  see it.

.PARAMETER Channel
  stable (default) = tagged releases. dev = the rolling pre-release built from the dev branch: newest
  features, less soak. The choice is PERSISTED, so later `claude-observatory update` follows it.

.PARAMETER Yes
  Install the capture hooks without asking. Piped invocations (`irm … | iex`) cannot prompt reliably,
  because the pipeline owns stdin — so without this the script prints the command instead of hanging.

.EXAMPLE
  irm https://raw.githubusercontent.com/cell-observatory/claude-observatory/main/install.ps1 | iex

.EXAMPLE
  # With options, the pipe form needs a scriptblock:
  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/cell-observatory/claude-observatory/main/install.ps1))) -Channel dev
#>
[CmdletBinding()]
param(
    [ValidateSet('stable', 'dev', 'pre', 'prerelease', 'main', 'release')]
    [string]$Channel = 'stable',
    [switch]$Yes
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest's progress bar is very slow in a pipe
$Repo = 'cell-observatory/claude-observatory'

function Say  { param($m) Write-Host "▸ $m" -ForegroundColor Cyan }
function Warn { param($m) Write-Host "! $m" -ForegroundColor Yellow }
function Ok   { param($m) Write-Host "✓ $m" -ForegroundColor Green }
function Dim  { param($m) Write-Host "  $m" -ForegroundColor DarkGray }

switch ($Channel) {
    'main'       { $Channel = 'stable' }
    'release'    { $Channel = 'stable' }
    'pre'        { $Channel = 'dev' }
    'prerelease' { $Channel = 'dev' }
}

# --- prerequisites -------------------------------------------------------------------------------
# Get-Command resolves npm.cmd through PATHEXT natively — the very thing Node's spawn cannot do, and
# the reason the CLI has to route its own npm calls through cmd.exe.
$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npm) {
    Warn 'npm not found — install Node.js 18 or newer first: https://nodejs.org/en/download'
    Dim  'or: winget install OpenJS.NodeJS.LTS'
    exit 1
}
$nodeVersion = (& node --version) -replace '^v', ''
# Parenthesised deliberately: `[int](expr)[0]` relies on cast-vs-index precedence, which is a coin flip
# to read and a real PowerShell gotcha.
if ([int](($nodeVersion -split '\.')[0]) -lt 18) {
    Warn "Node $nodeVersion is too old — this needs 18 or newer."
    exit 1
}

$tmp = Join-Path $env:TEMP ("claude-observatory-" + [System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
try {
    # --- resolve the release ---------------------------------------------------------------------
    # The rolling pre-release keeps a FIXED `dev-latest` tag so its URLs never move; stable is whatever
    # `releases/latest` serves. Same rule the CLI's channel resolver uses.
    if ($Channel -eq 'dev') {
        Say 'Finding the newest pre-release…'
        $relUrl = "https://api.github.com/repos/$Repo/releases/tags/dev-latest"
    } else {
        Say 'Finding the latest release…'
        $relUrl = "https://api.github.com/repos/$Repo/releases/latest"
    }
    try {
        $rel = Invoke-RestMethod -Uri $relUrl -Headers @{ Accept = 'application/vnd.github+json' } -UseBasicParsing
    } catch {
        Warn "Could not reach the release API for $Repo (channel: $Channel): $($_.Exception.Message)"
        exit 1
    }
    $tgz = $rel.assets | Where-Object { $_.name -like '*.tgz' } | Select-Object -First 1
    if (-not $tgz) { Warn "Release $($rel.tag_name) has no CLI tarball."; exit 1 }
    Say "Release: $($rel.tag_name)  (channel: $Channel)"

    # --- CLI ------------------------------------------------------------------------------------
    $dest = Join-Path $tmp $tgz.name
    Say 'Downloading the claude-observatory CLI…'
    Invoke-WebRequest -Uri $tgz.browser_download_url -OutFile $dest -UseBasicParsing

    # Verify the tarball before npm runs its install scripts as this user — parity with the CLI's own
    # assertDigest, which bootstrap.sh never had. GitHub publishes `sha256:<hex>` in the asset metadata.
    if ($tgz.digest -and $tgz.digest.StartsWith('sha256:')) {
        $expected = $tgz.digest.Substring(7)
        $actual = (Get-FileHash -Path $dest -Algorithm SHA256).Hash.ToLower()
        if ($actual -ne $expected.ToLower()) {
            Warn "Integrity check FAILED for $($tgz.name)"
            Dim  "sha256 $actual != $expected — refusing to install."
            exit 1
        }
        Dim "sha256 verified ($($tgz.name))"
    } else {
        Warn "No published checksum for $($tgz.name) — skipping the integrity check."
    }

    Say 'Installing it globally (npm i -g)…'
    & npm i -g $dest --silent
    if ($LASTEXITCODE -ne 0) {
        Warn "Global install failed. Try an elevated prompt, or: npm i -g `"$dest`""
        exit 1
    }
    $cli = Get-Command claude-observatory -ErrorAction SilentlyContinue
    if ($cli) { Ok "CLI ready: $($cli.Source)" }
    else {
        Warn 'claude-observatory is not on PATH yet.'
        Dim  'Open a NEW terminal (PATH is read at start-up), or check: npm prefix -g'
        exit 1
    }

    # --- editor extensions ----------------------------------------------------------------------
    # One call for the VS Code family AND JetBrains: detection, download, sha256, and the cmd.exe rules
    # that a .cmd shim needs. Nothing about editors is implemented in this script.
    Say 'Installing the editor extensions…'
    & claude-observatory install-extensions --channel $Channel
    if ($LASTEXITCODE -ne 0) { Warn 'Some editor surfaces could not be installed — see the notes above.' }

    # --- status line ----------------------------------------------------------------------------
    # Say the true thing rather than skipping quietly. The bundled status line IS a bash script that
    # parses its input with jq (and uses python3 for the token estimates), so it needs both on PATH.
    # There is no PowerShell port; porting it is a separate piece of work.
    $bash = Get-Command bash -ErrorAction SilentlyContinue
    $jq   = Get-Command jq -ErrorAction SilentlyContinue
    if ($bash -and $jq) {
        Say 'Installing the bundled status line…'
        & claude-observatory statusline | Out-Null
        if ($LASTEXITCODE -eq 0) { Ok 'Status line installed — it appears next session, if Claude Code can reach bash.' }
        else { Warn 'The status line did not install. Everything else still works.' }
    } else {
        $missing = @()
        if (-not $bash) { $missing += 'bash (Git for Windows)' }
        if (-not $jq)   { $missing += 'jq' }
        Warn "Skipped the bundled status line: $($missing -join ' and ') not found."
        Dim  'Consequence: the sidebar Usage bars and the terminal status line stay empty. Everything else works.'
        if (-not $jq)   { Dim 'winget install jqlang.jq' }
        if (-not $bash) { Dim 'winget install Git.Git' }
        Dim  'Then: claude-observatory statusline'
    }

    # --- capture hooks --------------------------------------------------------------------------
    Write-Host ''
    Warn 'Install the capture hooks with Claude Code CLOSED — a running session reverts mid-session hook edits.'
    if ($Yes) {
        & claude-observatory init
    } else {
        # `irm … | iex` gives the pipeline stdin, so Read-Host here is unreliable. Print, do not prompt.
        Dim 'Then run:  claude-observatory init      (or re-run this installer with -Yes)'
    }

    Write-Host ''
    Say 'Health check:'
    & claude-observatory doctor
    Write-Host ''
    Ok "Done. Update anytime with: claude-observatory update"
}
finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
