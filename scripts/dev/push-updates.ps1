# push-updates.ps1 — commit the current working copy to a new branch and push it.
#
# Creates branch "updated-WA" off whatever you have checked out now, commits
# everything that changed, and pushes it to origin. Your main branch is left
# exactly as it is — nothing here touches it.
#
# A note on the branch name: you asked for "updated WA", but git does not
# allow spaces in branch names (it rejects the ref outright). "updated-WA" is
# the closest valid form, so that's what this uses.
#
# Run by right-clicking this file -> "Run with PowerShell",
# or from the project root: .\push-updates.ps1

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$branch = "updated-WA"

function Fail($msg) {
    Write-Host ""
    Write-Host $msg -ForegroundColor Red
    Write-Host ""
    Read-Host "Press Enter to close"
    exit 1
}

# ─── Sanity checks ────────────────────────────────────────────
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Fail "git isn't installed or isn't on your PATH. Install it from https://git-scm.com/download/win and re-run."
}
if (-not (Test-Path ".git")) {
    Fail "This folder isn't a git repository. Run this script from the project root (the folder containing server.js)."
}

Write-Host "Repo    : $((git remote get-url origin).Trim())" -ForegroundColor Cyan
Write-Host "Now on  : $((git rev-parse --abbrev-ref HEAD).Trim())" -ForegroundColor Cyan
Write-Host ""

# ─── Make sure no secret is tracked before we commit ──────────
# .gitignore covers .env and data/, but .gitignore only stops files from being
# ADDED — anything already tracked from an earlier commit stays tracked and
# would keep going up. data/.session_secret signs every login cookie, so this
# check matters more than it looks.
$tracked = git ls-files
$leaks = @($tracked | Where-Object { $_ -eq ".env" -or $_ -like "data/*" -or $_ -like ".wwebjs_auth/*" })

if ($leaks.Count -gt 0) {
    Write-Host "These files are tracked by git but should never be committed:" -ForegroundColor Yellow
    $leaks | ForEach-Object { Write-Host "  $_" -ForegroundColor Yellow }
    Write-Host "Removing them from git's index (the files stay on your disk)." -ForegroundColor Yellow
    foreach ($f in $leaks) { git rm --cached --quiet -- "$f" }
    Write-Host ""
}

# ─── Create or switch to the branch ───────────────────────────
$exists = git branch --list $branch
if ($exists) {
    Write-Host "Branch '$branch' already exists — switching to it." -ForegroundColor Yellow
    git checkout $branch
} else {
    Write-Host "Creating branch '$branch'..." -ForegroundColor Green
    git checkout -b $branch
}
if ($LASTEXITCODE -ne 0) { Fail "Could not switch to '$branch'. Nothing has been committed." }

# ─── Stage and review ─────────────────────────────────────────
git add -A

$staged = git diff --cached --name-only
if (-not $staged) {
    Write-Host ""
    Write-Host "Nothing to commit — the branch already matches your working copy." -ForegroundColor Green
    Write-Host ""
    Read-Host "Press Enter to close"
    exit 0
}

Write-Host ""
Write-Host "Files going into this commit:" -ForegroundColor Cyan
$staged | ForEach-Object { Write-Host "  $_" }
Write-Host ""

$msg = @"
Deployment stack, admin tooling, and bug fixes

Deployment:
- Dockerfile + .dockerignore (Chromium deps for whatsapp-web.js)
- docker-compose.yml (local/demo) and docker-compose.prod.yml (Caddy overlay)
- Caddyfile for automatic HTTPS on a real domain
- start-demo.ps1 (Cloudflare tunnel) and start-demo-ngrok.ps1 (ngrok)
- DEPLOY.md: demo-now and go-live-later paths
- scripts/backup-db.sh: nightly DB + session-secret backup with 14-day retention

Server:
- trust proxy enabled only when TRUST_PROXY is set, so the rate limiter reads
  real client IPs behind Caddy/nginx without being spoofable in direct setups
- TRUST_PROXY documented in .env.example

Admin tooling:
- check-users.js: read-only dump of accounts, roles, and the DB path in use
- make-admin.js: promote an existing account to the admin role

Fixes:
- scheduled messages: datetime/timezone handling
- clear message history
- global search
- fix_db.js now scopes changes to one account instead of every tenant
- .gitignore: ignore all of data/, not just *.db, so the session-signing
  secret can never be committed
"@

git commit -q -m $msg
if ($LASTEXITCODE -ne 0) { Fail "Commit failed. Nothing was pushed." }

Write-Host "Committed." -ForegroundColor Green
Write-Host ""

# ─── Push ─────────────────────────────────────────────────────
Write-Host "Pushing '$branch' to origin..." -ForegroundColor Green
Write-Host "(If this is your first push from this machine, git will open a" -ForegroundColor DarkGray
Write-Host " GitHub sign-in window. That's expected.)" -ForegroundColor DarkGray
Write-Host ""

git push -u origin $branch
if ($LASTEXITCODE -ne 0) {
    Fail "Push failed — but your commit is safe on the local '$branch' branch. Fix the auth/network issue and run: git push -u origin $branch"
}

Write-Host ""
Write-Host "Done. Branch '$branch' is on GitHub." -ForegroundColor Green
Write-Host "Open a pull request into main here:" -ForegroundColor Cyan
Write-Host "  https://github.com/vedicagrawal12/whatsapp-automation/compare/$branch?expand=1" -ForegroundColor White
Write-Host ""
Write-Host "Your main branch was not modified." -ForegroundColor Cyan
Write-Host ""
Read-Host "Press Enter to close"
