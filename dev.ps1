# Starts the FastAPI backend and the Next.js dashboard together.
#
#   .\dev.ps1            # production build (fast pages) — default
#   .\dev.ps1 -Dev       # next dev with Turbopack (hot reload, slower first paint)
#
# Development mode recompiles each route on demand, which made page loads take
# seconds to minutes. Production mode (`next build` + `next start`) serves
# pre-compiled pages and is what you want for day-to-day use.

param([switch]$Dev)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$python = Join-Path $root ".venv\Scripts\python.exe"

if (-not (Test-Path $python)) {
    Write-Host "Virtual environment not found at $python" -ForegroundColor Red
    Write-Host "Create it with:  python -m venv .venv; .\.venv\Scripts\Activate.ps1; pip install -r backend\requirements.txt"
    exit 1
}

if (-not (Test-Path (Join-Path $root "frontend\node_modules"))) {
    Write-Host "Installing frontend dependencies..." -ForegroundColor Yellow
    Push-Location (Join-Path $root "frontend")
    npm install
    Pop-Location
}

if (-not $Dev -and -not (Test-Path (Join-Path $root "frontend\.next-build\BUILD_ID"))) {
    Write-Host "No production build found — building now (one-time)..." -ForegroundColor Yellow
    Push-Location (Join-Path $root "frontend")
    npm run build
    Pop-Location
}

Write-Host "Starting backend on http://127.0.0.1:8080 ..." -ForegroundColor Cyan
$backend = Start-Process -FilePath $python `
    -ArgumentList "-m", "uvicorn", "app.main:app", "--app-dir", (Join-Path $root "backend"), "--host", "127.0.0.1", "--port", "8080" `
    -WorkingDirectory $root -PassThru -NoNewWindow

Start-Sleep -Seconds 2

$frontendArgs = if ($Dev) { @("run", "dev") } else { @("run", "start") }
$mode = if ($Dev) { "dev" } else { "production" }
Write-Host "Starting dashboard on http://localhost:3000 ($mode) ..." -ForegroundColor Cyan
$frontend = Start-Process -FilePath "npm" -ArgumentList $frontendArgs `
    -WorkingDirectory (Join-Path $root "frontend") -PassThru -NoNewWindow

Write-Host ""
Write-Host "Backend  : http://127.0.0.1:8080/docs  (pid $($backend.Id))" -ForegroundColor Green
Write-Host "Dashboard: http://localhost:3000" -ForegroundColor Green
Write-Host "Press Ctrl+C to stop both processes."

try {
    Wait-Process -Id $backend.Id, $frontend.Id
} finally {
    foreach ($proc in @($backend, $frontend)) {
        if ($proc -and -not $proc.HasExited) {
            Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        }
    }
}
