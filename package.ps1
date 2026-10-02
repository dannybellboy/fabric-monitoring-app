# Build a self-contained dg_tool zip for the team.
#
# Produces dist/dg_tool_v<version>.zip containing:
#   dg_tool.bat          <- teammates double-click this
#   python/              Microsoft's embeddable CPython + every dependency
#   app/                 the server, the built UI, and config defaults
#   README-FIRST.txt
#
# Why embeddable Python rather than a PyInstaller .exe: it is Microsoft-signed
# python.exe running a plain script, which is far less likely to be blocked by
# SmartScreen or Intune than a novel unsigned executable, and a teammate hitting a
# problem can actually read what went wrong. Nothing is installed on their machine
# and nothing touches PATH or the registry.
#
# The one thing this cannot bundle is the ODBC Driver 18 for SQL Server: it is a
# system component. The app checks for it on start-up and says how to install it.
#
# The zip is named from the VERSION file: dg_tool_v1.0.1.zip. Bump VERSION before
# packaging a change -- the script refuses to overwrite an existing version.
#
# Usage:  .\package.ps1            (-Force to rebuild the same version)

param(
    [string]$PythonVersion = '3.12.8',
    [string]$OutDir = 'dist',
    # Overwrite an existing zip for this version. Off by default: shipping two
    # different builds under one name is exactly how a teammate ends up running
    # something you think you fixed.
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

# Single source of truth for the version. Bump VERSION before packaging a change.
$versionFile = Join-Path $root 'VERSION'
if (-not (Test-Path $versionFile)) { throw "VERSION file not found at $versionFile" }
$version = (Get-Content $versionFile -Raw).Trim()
if ($version -notmatch '^\d+\.\d+\.\d+$') {
    throw "VERSION must look like 1.2.3 (found '$version')"
}
$builtAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
$staging = Join-Path $env:TEMP "dg_tool_pkg_$(Get-Random)"
$appDir = Join-Path $staging 'app'
$pyDir = Join-Path $staging 'python'

Write-Host "Building dg_tool v$version (Python $PythonVersion)" -ForegroundColor Cyan

$outPath = Join-Path $root $OutDir
$zipFull = Join-Path $outPath "dg_tool_v$version.zip"
if ((Test-Path $zipFull) -and -not $Force) {
    throw ("dg_tool_v$version.zip already exists. Bump VERSION for a new build, " +
           'or pass -Force to overwrite this one.')
}

# ---- 1. build the frontend --------------------------------------------------
Write-Host '  [1/6] Building the web UI...'
Push-Location (Join-Path $root 'web')
if (-not (Test-Path 'node_modules')) { npm install --no-fund --no-audit }
npm run build
Pop-Location

$dist = Join-Path $root 'web\dist\index.html'
if (-not (Test-Path $dist)) { throw 'web/dist/index.html missing - the build did not produce a UI.' }

# ---- 2. fetch embeddable Python --------------------------------------------
Write-Host '  [2/6] Fetching embeddable Python...'
New-Item -ItemType Directory -Force -Path $pyDir | Out-Null
$zipUrl = "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip"
$zipPath = Join-Path $staging 'python-embed.zip'
New-Item -ItemType Directory -Force -Path $staging | Out-Null
Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing
Expand-Archive -Path $zipPath -DestinationPath $pyDir -Force
Remove-Item $zipPath

# The embeddable build ships with site-packages disabled; enabling it is what lets
# pip-installed dependencies be importable.
$pthFile = Get-ChildItem -Path $pyDir -Filter 'python*._pth' | Select-Object -First 1
if ($pthFile) {
    $content = Get-Content $pthFile.FullName
    $content = $content -replace '^#\s*import site', 'import site'
    if ($content -notcontains 'Lib\site-packages') { $content += 'Lib\site-packages' }
    Set-Content -Path $pthFile.FullName -Value $content -Encoding ascii
}

# ---- 3. install dependencies into it ---------------------------------------
Write-Host '  [3/6] Installing dependencies...'
$getPip = Join-Path $staging 'get-pip.py'
Invoke-WebRequest -Uri 'https://bootstrap.pypa.io/get-pip.py' -OutFile $getPip -UseBasicParsing
& (Join-Path $pyDir 'python.exe') $getPip --no-warn-script-location | Out-Null
Remove-Item $getPip

& (Join-Path $pyDir 'python.exe') -m pip install --no-warn-script-location `
    -r (Join-Path $root 'server\requirements.txt') | Out-Null

# ---- 4. copy the app -------------------------------------------------------
Write-Host '  [4/6] Copying the app...'
New-Item -ItemType Directory -Force -Path $appDir | Out-Null
Copy-Item -Recurse (Join-Path $root 'server') (Join-Path $appDir 'server')
New-Item -ItemType Directory -Force -Path (Join-Path $appDir 'web') | Out-Null
Copy-Item -Recurse (Join-Path $root 'web\dist') (Join-Path $appDir 'web\dist')
Copy-Item -Recurse (Join-Path $root 'sql') (Join-Path $appDir 'sql')
Copy-Item (Join-Path $root 'README.md') (Join-Path $appDir 'README.md')

# Never ship caches, and never ship a personal token cache.
Get-ChildItem -Path $appDir -Recurse -Directory -Filter '__pycache__' |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

# config.json carries the environment ids, which are not secrets and are the same
# for everyone, so it ships. Anything genuinely per-user lives in the OS-encrypted
# token cache under %LOCALAPPDATA%, never in the package.
if (-not (Test-Path (Join-Path $appDir 'server\config.json'))) {
    Write-Warning '  server/config.json not found - UAT/PRD will show as unconfigured.'
}

$stamp = [ordered]@{ version = $version; builtAt = $builtAt; python = $PythonVersion }
$stamp | ConvertTo-Json | Set-Content -Path (Join-Path $appDir 'server\build.json') -Encoding ascii

# ---- 5. launcher + readme --------------------------------------------------
Write-Host '  [5/6] Writing the launcher...'

$launcher = @'
@echo off
title dg_tool
cd /d "%~dp0"

rem Keep the token cache and any stray writes out of the app folder, so the whole
rem thing stays replaceable on an update.
set PYTHONDONTWRITEBYTECODE=1
rem dg_tool uses no pydantic plugins; skipping the scan avoids a class of
rem transient import failure on OneDrive-synced folders.
set PYDANTIC_DISABLE_PLUGINS=1

echo.
echo   Starting dg_tool __VERSION__...
echo   Leave this window open while you use it. Close it to stop.
echo.

start "" http://127.0.0.1:8000
python\python.exe -m uvicorn main:app --host 127.0.0.1 --port 8000 --app-dir app\server

echo.
echo   dg_tool has stopped. Press any key to close.
pause > nul
'@
$launcher = $launcher -replace '__VERSION__', "v$version"
Set-Content -Path (Join-Path $staging 'dg_tool.bat') -Value $launcher -Encoding ascii

$readme = @'
dg_tool __VERSION__
===================

WHAT IT IS
  Source-to-target spec (HDX), the orchestrator dependency graph, process lineage,
  and process health across DEV / QA / UAT / PRD.

HOW TO RUN
  1. Unzip this folder somewhere on your machine (not inside OneDrive if you can
     avoid it - it starts faster outside a synced folder).
  2. Double-click  dg_tool.bat
  3. Your browser opens http://127.0.0.1:8000
  4. Click "Sign in with your Hanger account". It opens a browser tab; you only
     do this once on this machine.

  Leave the black console window open while you use the app. Closing it stops it.

IF SIGN-IN DOES NOT WORK
  Use the "Browser sign-in blocked? Use a device code instead" link on the
  sign-in screen. It shows a short code to type at microsoft.com/devicelogin.

IF IT SAYS THE ODBC DRIVER IS MISSING
  Install "Microsoft ODBC Driver 18 for SQL Server" - a small MSI from Microsoft:
  https://learn.microsoft.com/sql/connect/odbc/download-odbc-driver-for-sql-server
  You may already have it if you use Power BI Desktop, SSMS, or Azure Data Studio.
  Restart dg_tool afterwards.

WHAT IT CAN CHANGE
  - S2T tab writes directly to WH_HDX_DE_Silver.HDX (the live spec). Saves are
    checked against the row version, so you cannot silently overwrite a colleague.
  - Dependency Graph tab writes to a staging table in DEV, not to the Lakehouse
    the orchestrator reads.
  - Health and Lineage are read-only. All four environments are read-only there.

  Everything you change is stamped with your name, so edits are attributable.

NOTHING IS INSTALLED
  This folder is self-contained. Delete it to remove dg_tool. Your sign-in is
  cached under %LOCALAPPDATA%\dg_tool.
'@
$readme = $readme -replace '__VERSION__', "v$version"
Set-Content -Path (Join-Path $staging 'README-FIRST.txt') -Value $readme -Encoding ascii

# ---- 6. zip ----------------------------------------------------------------
Write-Host '  [6/6] Zipping...'
New-Item -ItemType Directory -Force -Path $outPath | Out-Null
if (Test-Path $zipFull) { Remove-Item $zipFull -Force }
Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zipFull

$sizeMb = [math]::Round((Get-Item $zipFull).Length / 1MB, 1)
Remove-Item -Recurse -Force $staging

Write-Host ''
Write-Host "  Built dg_tool v$version -> $zipFull ($sizeMb MB)" -ForegroundColor Green
Write-Host '  Share that zip. Recipients unzip it and double-click dg_tool.bat.'
Write-Host "  The running app reports its version in the header, so you can confirm"
Write-Host '  which build someone is on when they report a problem.'
Write-Host ''
