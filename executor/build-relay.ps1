$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'build-device.ps1') -Target relay
