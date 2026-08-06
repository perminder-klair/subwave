[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PackageRoot = Split-Path -Parent $ScriptDir
$DestinationParent = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'GitHub'
$Destination = Join-Path $DestinationParent 'subwave'

function Test-Command([string]$Name) { return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue) }
function Run([string]$File, [string[]]$Args) {
    & $File @Args
    if ($LASTEXITCODE -ne 0) { throw ('Ошибка команды: {0} {1}' -f $File, ($Args -join ' ')) }
}
function Ensure-App([string]$Command, [string]$WingetId) {
    if (Test-Command $Command) { return }
    if (-not (Test-Command 'winget.exe')) { throw ('Не найден {0} и отсутствует winget.' -f $Command) }
    Write-Host ('Устанавливаю {0}...' -f $WingetId) -ForegroundColor Cyan
    Run 'winget.exe' @('install','--exact','--id',$WingetId,'--accept-package-agreements','--accept-source-agreements')
    $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
}

Write-Host 'SUB/WAVE Windows Edition — публикация настоящего GitHub-форка' -ForegroundColor Cyan
Write-Host 'Скрипт создаст форк в аккаунте, где выполнен вход через GitHub CLI.' -ForegroundColor DarkGray
Write-Host ''

Ensure-App 'git.exe' 'Git.Git'
Ensure-App 'gh.exe' 'GitHub.cli'

& gh.exe auth status *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Host 'Откроется вход в GitHub.' -ForegroundColor Yellow
    Run 'gh.exe' @('auth','login','--web','--git-protocol','https')
}

if (-not (Test-Path $DestinationParent)) { New-Item -ItemType Directory -Path $DestinationParent -Force | Out-Null }
if (Test-Path $Destination) {
    throw ('Папка уже существует: {0}. Переименуй или удали её и запусти скрипт снова.' -f $Destination)
}

Push-Location $DestinationParent
try {
    Run 'gh.exe' @('repo','fork','perminder-klair/subwave','--clone','--remote')
    Set-Location $Destination
    Run 'git.exe' @('checkout','-b','windows-edition')

    $windowsDir = Join-Path $Destination 'windows'
    New-Item -ItemType Directory -Path $windowsDir -Force | Out-Null
    Copy-Item -Path (Join-Path $PackageRoot '*') -Destination $windowsDir -Recurse -Force
    if (Test-Path (Join-Path $windowsDir '.git')) { Remove-Item (Join-Path $windowsDir '.git') -Recurse -Force }

    $readme = @'
# Windows Edition

One-click Windows launcher is in [`windows/`](windows/README.md).

It runs the official SUB/WAVE production images through Docker Desktop with Linux containers. Runtime data is stored in `%LOCALAPPDATA%\SUBWAVE` and is not committed.
'@
    [System.IO.File]::WriteAllText((Join-Path $Destination 'README-WINDOWS.md'), $readme, (New-Object System.Text.UTF8Encoding($false)))

    $workflowSource = Join-Path $PackageRoot '.github\workflows\package-windows.yml'
    if (Test-Path $workflowSource) {
        $workflowTargetDir = Join-Path $Destination '.github\workflows'
        New-Item -ItemType Directory -Path $workflowTargetDir -Force | Out-Null
        Copy-Item -LiteralPath $workflowSource -Destination (Join-Path $workflowTargetDir 'package-windows.yml') -Force
    }

    Run 'git.exe' @('add','windows','README-WINDOWS.md','.github/workflows/package-windows.yml')
    Run 'git.exe' @('commit','-m','feat(windows): add one-click Docker Desktop installer and manager')
    Run 'git.exe' @('push','-u','origin','windows-edition')
    $repoUrl = (& gh.exe repo view --json url --jq '.url').Trim()
    Write-Host ''
    Write-Host ('Готово: {0}/tree/windows-edition' -f $repoUrl) -ForegroundColor Green
    Start-Process ('{0}/tree/windows-edition' -f $repoUrl)
} finally {
    Pop-Location
}
