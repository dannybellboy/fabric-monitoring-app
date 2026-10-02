# Start both halves of dg_tool: the FastAPI backend and the Vite dev server.
#
# The backend opens in its own window because the first sign-in may print a
# device code you have to read and act on. If you are already `az login`-ed it
# starts silently.
#
# Usage:
#   .\run.ps1

$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$server = Join-Path $root 'server'
$web = Join-Path $root 'web'

# OneDrive occasionally hydrates a file inside .venv mid-import, and pydantic's
# plugin loader dies with OSError: [Errno 22]. dg_tool uses no pydantic plugins,
# so skipping the plugin scan removes that whole class of transient failure.
$env:PYDANTIC_DISABLE_PLUGINS = '1'

# Windows reports a port that is already bound on loopback as
# "[WinError 10013] ... socket ... forbidden by its access permissions" rather than
# the clearer 10048/address-in-use, so check first and say what is actually wrong.
function Assert-PortFree {
    param([int]$Port, [string]$Purpose)

    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($conn) {
        $owner = Get-Process -Id ($conn.OwningProcess | Select-Object -First 1) -ErrorAction SilentlyContinue
        $name = if ($owner) { "$($owner.ProcessName) (PID $($owner.Id)), started $($owner.StartTime)" } else { "PID $($conn.OwningProcess -join ',')" }
        throw "Port $Port ($Purpose) is already in use by $name. Stop that process, or start this half on a different port."
    }

    # A port inside a Hyper-V/WSL reservation also surfaces as WinError 10013, and no
    # amount of stopping processes will free it -- only a different port will do.
    $excluded = (netsh interface ipv4 show excludedportrange protocol=tcp) -join "`n"
    foreach ($line in $excluded -split "`n") {
        if ($line -match '^\s*(\d+)\s+(\d+)') {
            if ([int]$Matches[1] -le $Port -and $Port -le [int]$Matches[2]) {
                throw "Port $Port ($Purpose) falls inside a Windows reserved range ($($Matches[1])-$($Matches[2])). Pick a different port."
            }
        }
    }
}

Assert-PortFree -Port 8000 -Purpose 'dg_tool API'
Assert-PortFree -Port 5173 -Purpose 'dg_tool UI'

if (-not (Test-Path (Join-Path $web 'node_modules'))) {
    Write-Host 'Installing frontend dependencies...'
    Push-Location $web
    npm install --no-fund --no-audit
    Pop-Location
}

Write-Host 'Starting API on http://127.0.0.1:8000 ...'
Start-Process powershell -ArgumentList @(
    '-NoExit', '-Command',
    "Set-Location '$server'; " +
    "`$env:PYDANTIC_DISABLE_PLUGINS='1'; " +
    "python -m uvicorn main:app --reload --port 8000"
)

Write-Host 'Starting UI on http://localhost:5173 ...'
Write-Host 'Press Ctrl+C to stop the UI; close the other window to stop the API.'
Set-Location $web
npm run dev
