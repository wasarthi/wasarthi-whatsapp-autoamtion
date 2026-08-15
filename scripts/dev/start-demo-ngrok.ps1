# start-demo-ngrok.ps1 — one-click free demo launcher using ngrok.
#
# Same idea as start-demo.ps1 (which uses Cloudflare's tunnel instead) — pick
# whichever tool you already prefer. Two differences worth knowing about ngrok
# specifically before you're on a call:
#
#   1. ngrok requires a free account + a one-time "authtoken" — cloudflared's
#      quick tunnel does not. Takes ~2 minutes, just an email:
#        - Sign up:      https://dashboard.ngrok.com/signup
#        - Get your token: https://dashboard.ngrok.com/get-started/your-authtoken
#        - Run once:      ngrok config add-authtoken YOUR_TOKEN_HERE
#      Do this BEFORE the call — this script will tell you if it's missing.
#
#   2. ngrok's free plan shows a one-time "click through to continue" warning
#      page to first-time visitors before they reach your app. It's one extra
#      click, not a big deal, but worth mentioning to investors so it doesn't
#      look broken ("that's just ngrok's free-tier landing page, click Visit
#      Site").
#
# Run by right-clicking this file -> "Run with PowerShell",
# or: .\start-demo-ngrok.ps1

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
Set-Location $root

$port = 3000
if (Test-Path ".env") {
    $envLine = Select-String -Path ".env" -Pattern "^PORT=" -ErrorAction SilentlyContinue
    if ($envLine) { $port = ($envLine.Line -split "=", 2)[1].Trim() }
}

# Make sure ngrok is actually installed before doing anything else.
if (-not (Get-Command ngrok -ErrorAction SilentlyContinue)) {
    Write-Host "ngrok isn't installed yet." -ForegroundColor Yellow
    $tryWinget = Get-Command winget -ErrorAction SilentlyContinue
    if ($tryWinget) {
        Write-Host "Installing it via winget (Ngrok.Ngrok)..." -ForegroundColor Yellow
        winget install --id Ngrok.Ngrok -e --silent --accept-package-agreements --accept-source-agreements
    }
    if (-not (Get-Command ngrok -ErrorAction SilentlyContinue)) {
        Write-Host ""
        Write-Host "Could not auto-install ngrok. Please install it manually:" -ForegroundColor Red
        Write-Host "  https://ngrok.com/download" -ForegroundColor White
        Write-Host "Then re-run this script." -ForegroundColor Red
        exit 1
    }
}

Write-Host "Starting WhatsApp Automation on port $port ..." -ForegroundColor Green
Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$root'; npm start"

Write-Host "Waiting for the server to come up..." -ForegroundColor Yellow
Start-Sleep -Seconds 6

Write-Host "Opening your public HTTPS demo link..." -ForegroundColor Green
Start-Process powershell -ArgumentList "-NoExit", "-Command", "ngrok http $port"

Write-Host ""
Write-Host "Two new windows just opened:" -ForegroundColor Cyan
Write-Host "  1) Your server log (leave it running)" -ForegroundColor Cyan
Write-Host "  2) ngrok — look for the 'Forwarding' line, e.g.:" -ForegroundColor Cyan
Write-Host "     https://abcd-1234.ngrok-free.app -> http://localhost:$port" -ForegroundColor White
Write-Host ""
Write-Host "If the ngrok window instead shows an authtoken error, get your free" -ForegroundColor Yellow
Write-Host "token from https://dashboard.ngrok.com/get-started/your-authtoken," -ForegroundColor Yellow
Write-Host "run: ngrok config add-authtoken YOUR_TOKEN_HERE, then re-run this script." -ForegroundColor Yellow
Write-Host ""
Write-Host "Share the https://...ngrok-free.app link, not localhost." -ForegroundColor Cyan
Write-Host "Close both windows when the demo is done." -ForegroundColor Cyan
