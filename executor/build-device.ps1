param(
    [ValidateSet('device', 'relay')]
    [string]$Target = 'device'
)

$ErrorActionPreference = 'Stop'
$ExecutorRoot = $PSScriptRoot
Push-Location $ExecutorRoot

try {
    $NodeCommand = Get-Command node -ErrorAction SilentlyContinue
    $NeedsInstall = $true
    if ($NodeCommand) {
        $NodeVersionText = (& node -p "process.versions.node").Trim()
        $NodeVersion = [version]$NodeVersionText
        $NeedsInstall = $NodeVersion -lt [version]'22.12.0'
    }

    if ($NeedsInstall) {
        $Winget = Get-Command winget -ErrorAction SilentlyContinue
        if (-not $Winget) {
            throw 'Node.js 22.12+ is required. Install it from https://nodejs.org/ or install winget, then rerun this script.'
        }
        Write-Host 'Installing/upgrading Node.js LTS with winget...'
        & $Winget.Source install --id OpenJS.NodeJS.LTS --exact --silent `
            --accept-package-agreements --accept-source-agreements --force
        if ($LASTEXITCODE -ne 0) {
            throw "winget failed to install Node.js (exit code $LASTEXITCODE)."
        }

        $NodeInstall = Join-Path $env:ProgramFiles 'nodejs'
        if (Test-Path (Join-Path $NodeInstall 'node.exe')) {
            $env:Path = "$NodeInstall;$env:Path"
        }
        $NodeCommand = Get-Command node -ErrorAction SilentlyContinue
        if (-not $NodeCommand) {
            throw 'Node.js was installed, but node.exe is not available in this PowerShell process. Open a new PowerShell window and rerun this script.'
        }
        $NodeVersionText = (& node -p "process.versions.node").Trim()
        if ([version]$NodeVersionText -lt [version]'22.12.0') {
            throw "Node.js $NodeVersionText is still too old; version 22.12+ is required."
        }
    }

    Write-Host 'Installing locked executor dependencies...'
    & npm.cmd ci --include=dev --include=optional
    if ($LASTEXITCODE -ne 0) {
        throw "npm ci failed (exit code $LASTEXITCODE)."
    }

    Write-Host "Building standalone Windows $Target app..."
    & node (Join-Path $ExecutorRoot 'build-device.mjs') $Target
    if ($LASTEXITCODE -ne 0) {
        throw "$Target app build failed (exit code $LASTEXITCODE)."
    }
}
finally {
    Pop-Location
}
