# Kompl one-line installer for Windows (native PowerShell).
#
# Usage (the friendly path):
#   irm https://raw.githubusercontent.com/tuirk/Kompl/main/install.ps1 | iex
#
# Usage (download and inspect first — recommended for security-conscious users):
#   iwr https://raw.githubusercontent.com/tuirk/Kompl/main/install.ps1 -OutFile install.ps1
#   notepad install.ps1
#   .\install.ps1
#
# Optional argument: target directory name (defaults to "kompl"):
#   .\install.ps1 my-kompl

#Requires -Version 5.1
$ErrorActionPreference = "Stop"

function Write-Ok   { param($Msg) Write-Host "  ✓ $Msg" -ForegroundColor Green }
function Write-Warn { param($Msg) Write-Host "  ! $Msg" -ForegroundColor Yellow }
function Write-Fail { param($Msg) Write-Host "  ✗ $Msg" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "Kompl — installer" -ForegroundColor Cyan
Write-Host ""

# ── Docker ──────────────────────────────────────────────────────────────────
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Fail "Docker not installed. Install Docker Desktop: https://www.docker.com/products/docker-desktop/"
}
& docker info *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Fail "Docker is installed but not running. Start Docker Desktop and re-run."
}
Write-Ok "Docker running"

& docker compose version *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Fail "Docker Compose v2 not available. Reinstall Docker Desktop (recent versions bundle Compose v2)."
}
Write-Ok "Docker Compose v2"

# ── Node.js ─────────────────────────────────────────────────────────────────
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host ""
    Write-Warn "Node.js not installed. Install Node 24 first:"
    Write-Host "    winget install OpenJS.NodeJS    # or download from https://nodejs.org/"
    exit 1
}

$nodeVersion = (& node --version) -replace '^v',''
$nodeMajor = [int]($nodeVersion -split '\.')[0]
if ($nodeMajor -lt 24) {
    Write-Fail "Node ≥ 24 required (you have v$nodeVersion). Upgrade: 'winget upgrade OpenJS.NodeJS' or via nvm-windows."
}
Write-Ok "Node v$nodeVersion"

# ── Disk & RAM ──────────────────────────────────────────────────────────────
try {
    $driveLetter = (Get-Location).Drive.Name
    $freeGB = [math]::Round((Get-PSDrive $driveLetter).Free / 1GB, 1)
    if ($freeGB -lt 5) {
        Write-Warn "Low disk space: $freeGB GB free on ${driveLetter}:. Recommended: 5 GB+ for Docker images."
    } else {
        Write-Ok "Disk: $freeGB GB free on ${driveLetter}:"
    }
} catch { }

try {
    $os = Get-CimInstance Win32_OperatingSystem
    $freeRamGB = [math]::Round($os.FreePhysicalMemory / 1MB, 1)
    if ($freeRamGB -lt 4) {
        Write-Warn "Low RAM: $freeRamGB GB free. Kompl needs ~4 GB; expect slowness."
    } else {
        Write-Ok "RAM: $freeRamGB GB free"
    }
} catch { }

# ── Clone ───────────────────────────────────────────────────────────────────
$target = if ($args.Count -gt 0) { $args[0] } else { "kompl" }
if (Test-Path $target) {
    Write-Fail "'$target' already exists. Pass a different name: .\install.ps1 my-kompl"
}

Write-Host ""
Write-Host "  Cloning into .\$target ..."
& git clone --depth=1 https://github.com/tuirk/Kompl.git $target *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Fail "git clone failed. Is git installed? Network OK?"
}
Write-Ok "Cloned"

# ── Hand off to setup.js ────────────────────────────────────────────────────
Set-Location $target
Write-Host ""
Write-Host "  Handing off to setup.js (interactive — needs your Gemini + Firecrawl API keys and a deployment-mode choice)."
Write-Host ""
& node setup.js
