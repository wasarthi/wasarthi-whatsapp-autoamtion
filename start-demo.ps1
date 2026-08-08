# start-demo.ps1 — one-click free demo launcher for investor calls.
#
# What this does:
#   1. Starts your WhatsApp Automation server locally (same as `npm start`).
#   2. Opens a free Cloudflare Quick Tunnel that gives you a public HTTPS
#      link pointing at your own machine — no account, no signup, no cost.
#
# The link only works while this script's two windows stay open, and it
# changes every time you run this (that's normal for a free quick tunnel).
# When you close the windows, the link dies and your machine is no longer
# exposed. This is meant for a live demo call or a short shareable link —
# not something to leave running unattended for days.
#
# Run it by right-clicking this file -> "Run with PowerShell",
# or from a PowerShell prompt: .\start-demo.ps1

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
Set-Location $root

# Read PORT from .env if it's set there, otherwise default to 3000.
$port = 3000
if (Test-Path ".env") {
    $envLine = Select-String -Path ".env" -Pattern "^PORT=" -ErrorAction SilentlyContinue
    if ($envLine) { $port = ($envLine.Line -split "=", 2)[1].Trim() }
}

Write-Host "Starting WhatsApp Automation on port $port ..." -ForegroundColor Green
Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$root'; npm start"

Write-Host "Waiting for the server to come up..." -ForegroundColor Yellow
Start-Sleep -Seconds 6

# Make sure cloudflared is available — download it once if it isn't.
$cloudflaredExe = Join-Path $root "cloudflared.exe"
if (Test-Path $cloudflaredExe) {
    # already downloaded on a previous run
} elseif (Get-Command cloudflared -ErrorAction SilentlyContinue) {
    $cloudflaredExe = "cloudflared"
} else {
    Write-Host "Downloading cloudflared (one-time, ~30MB, official Cloudflare release from GitHub)..." -ForegroundColor Yellow
    Invoke-WebRequest -Uri "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" -OutFile $cloudflaredExe
}

Write-Host "Opening your public HTTPS demo link..." -ForegroundColor Green
Start-Process powershell -ArgumentList "-NoExit", "-Command", "& '$cloudflaredExe' tunnel --url http://localhost:$port"

Write-Host ""
Write-Host "Two new windows just opened:" -ForegroundColor Cyan
Write-Host "  1) Your server log (leave it running)" -ForegroundColor Cyan
Write-Host "  2) The tunnel — look for a line like:" -ForegroundColor Cyan
Write-Host "     https://random-words-1234.trycloudflare.com" -ForegroundColor White
Write-Host ""
Write-Host "That https://...trycloudflare.com link is your live public demo URL." -ForegroundColor Cyan
Write-Host "Share that link, not localhost. Close both windows when the demo is done." -ForegroundColor Cyan
