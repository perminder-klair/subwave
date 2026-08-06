[CmdletBinding()]
param(
    [ValidateSet('menu','install','start','stop','restart','update','logs','status','open','doctor','credentials')]
    [string]$Action = 'menu'
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $OutputEncoding = [Console]::OutputEncoding
} catch { }
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

$SelfPath = $MyInvocation.MyCommand.Path
$ScriptDir = Split-Path -Parent $SelfPath
$PackageRoot = Split-Path -Parent $ScriptDir
$InstallRoot = Join-Path $env:LOCALAPPDATA 'SUBWAVE'
$ComposeFile = Join-Path $InstallRoot 'docker-compose.yml'
$EnvFile = Join-Path $InstallRoot '.env'
$StateDir = Join-Path $InstallRoot 'state'
$BackupsDir = Join-Path $InstallRoot 'backups'
$DiagnosticsDir = Join-Path $InstallRoot 'diagnostics'
$ManagerDir = Join-Path $InstallRoot 'windows-manager'
$BundledCompose = Join-Path $PackageRoot 'assets\docker-compose.yml'
$BundledEnvExample = Join-Path $PackageRoot 'assets\.env.example'
$UpstreamComposeUrl = 'https://raw.githubusercontent.com/perminder-klair/subwave/refs/heads/main/docker-compose.yml'
$UpstreamEnvUrl = 'https://raw.githubusercontent.com/perminder-klair/subwave/refs/heads/main/.env.example'
function Get-DockerDesktopExe {
    $candidates = @(
        (Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\Docker Desktop.exe'),
        (Join-Path $env:LOCALAPPDATA 'Docker\Docker Desktop.exe')
    )
    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) { return $candidate }
    }
    return $null
}

function Get-DockerCliExe {
    $candidates = @(
        (Join-Path $env:ProgramFiles 'Docker\Docker\DockerCli.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\DockerCli.exe')
    )
    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) { return $candidate }
    }
    return $null
}

function Add-DockerToPath {
    if (Test-Command 'docker.exe') { return }
    $candidates = @(
        (Join-Path $env:ProgramFiles 'Docker\Docker\resources\bin'),
        (Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\resources\bin')
    )
    foreach ($candidate in $candidates) {
        if (Test-Path (Join-Path $candidate 'docker.exe')) {
            $env:Path = $candidate + ';' + $env:Path
            return
        }
    }
}

function Write-Title {
    Clear-Host
    Write-Host '============================================================' -ForegroundColor DarkCyan
    Write-Host '               SUB/WAVE — Windows Edition' -ForegroundColor Cyan
    Write-Host '============================================================' -ForegroundColor DarkCyan
    Write-Host ('Рабочая папка: {0}' -f $InstallRoot) -ForegroundColor DarkGray
    Write-Host ''
}

function Write-Ok([string]$Text) { Write-Host ('[OK]  {0}' -f $Text) -ForegroundColor Green }
function Write-Warn([string]$Text) { Write-Host ('[!]   {0}' -f $Text) -ForegroundColor Yellow }
function Write-Step([string]$Text) { Write-Host ('[..]  {0}' -f $Text) -ForegroundColor Cyan }
function Write-Fail([string]$Text) { Write-Host ('[X]   {0}' -f $Text) -ForegroundColor Red }

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Restart-Elevated([string]$NextAction) {
    if (Test-IsAdministrator) { return $false }
    Write-Step 'Для установки компонентов Windows нужны права администратора.'
    $arguments = @(
        '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', ('"{0}"' -f $SelfPath),
        '-Action', $NextAction
    ) -join ' '
    Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $arguments | Out-Null
    return $true
}

function Test-Command([string]$Name) {
    return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Invoke-External {
    param(
        [Parameter(Mandatory=$true)][string]$FilePath,
        [Parameter(Mandatory=$false)][string[]]$Arguments = @(),
        [switch]$IgnoreExitCode
    )
    & $FilePath @Arguments
    $code = $LASTEXITCODE
    if ((-not $IgnoreExitCode) -and $code -ne 0) {
        throw ('Команда завершилась с кодом {0}: {1} {2}' -f $code, $FilePath, ($Arguments -join ' '))
    }
    $script:LastExternalExitCode = $code
}

function Invoke-Compose {
    param(
        [Parameter(Mandatory=$true)][string[]]$Arguments,
        [switch]$IgnoreExitCode
    )
    if (-not (Test-Path $ComposeFile)) { throw 'Не найден docker-compose.yml. Сначала запусти INSTALL.cmd.' }
    if (-not (Test-Path $EnvFile)) { throw 'Не найден .env. Сначала запусти INSTALL.cmd.' }
    $allArgs = @('compose','--project-name','subwave','--file',$ComposeFile,'--env-file',$EnvFile) + $Arguments
    return Invoke-External -FilePath 'docker' -Arguments $allArgs -IgnoreExitCode:$IgnoreExitCode
}

function Get-EnvValue([string]$Name, [string]$Default = '') {
    if (-not (Test-Path $EnvFile)) { return $Default }
    $line = Get-Content -LiteralPath $EnvFile -ErrorAction SilentlyContinue |
        Where-Object { $_ -match ('^{0}=' -f [regex]::Escape($Name)) } |
        Select-Object -Last 1
    if ($null -eq $line) { return $Default }
    return ($line -replace ('^{0}=' -f [regex]::Escape($Name)), '').Trim()
}

function Set-Utf8NoBom([string]$Path, [string[]]$Lines) {
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllLines($Path, $Lines, $encoding)
}

function New-RandomPassword {
    $bytes = New-Object byte[] 20
    $rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
}

function Test-PortAvailable([int]$Port) {
    try {
        $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $Port)
        $listener.Start()
        $listener.Stop()
        return $true
    } catch {
        return $false
    }
}

function Get-FreePort {
    param([int]$StartPort = 7700, [int]$EndPort = 7799)
    for ($port = $StartPort; $port -le $EndPort; $port++) {
        if (Test-PortAvailable $port) { return $port }
    }
    throw ('Не найден свободный порт в диапазоне {0}-{1}.' -f $StartPort, $EndPort)
}

function Ensure-InstallFolders {
    foreach ($path in @($InstallRoot,$StateDir,$BackupsDir,$DiagnosticsDir)) {
        if (-not (Test-Path $path)) { New-Item -ItemType Directory -Path $path -Force | Out-Null }
    }
}

function Install-ManagerFiles {
    if ([System.IO.Path]::GetFullPath($PackageRoot).TrimEnd('\') -eq [System.IO.Path]::GetFullPath($ManagerDir).TrimEnd('\')) {
        return
    }
    if (-not (Test-Path $ManagerDir)) { New-Item -ItemType Directory -Path $ManagerDir -Force | Out-Null }
    foreach ($dirName in @('scripts','assets')) {
        $sourceDir = Join-Path $PackageRoot $dirName
        $targetDir = Join-Path $ManagerDir $dirName
        if (Test-Path $targetDir) { Remove-Item -LiteralPath $targetDir -Recurse -Force }
        Copy-Item -LiteralPath $sourceDir -Destination $targetDir -Recurse -Force
    }
    $files = @(
        'SUBWAVE WINDOWS.cmd','INSTALL.cmd','START.cmd','STOP.cmd','UPDATE.cmd',
        'LOGS.cmd','OPEN PANEL.cmd','DIAGNOSTICS.cmd','PUBLISH FORK TO GITHUB.cmd',
        'README.md','FORK_SETUP.md','THIRD_PARTY_NOTICES.md','UPSTREAM_SNAPSHOT.txt','LICENSE','VERSION'
    )
    foreach ($fileName in $files) {
        $sourceFile = Join-Path $PackageRoot $fileName
        if (Test-Path $sourceFile) { Copy-Item -LiteralPath $sourceFile -Destination (Join-Path $ManagerDir $fileName) -Force }
    }
    Write-Ok ('Менеджер установлен в {0}' -f $ManagerDir)
}

function New-ManagerShortcuts {
    $target = Join-Path $ManagerDir 'SUBWAVE WINDOWS.cmd'
    if (-not (Test-Path $target)) { return }
    $shell = New-Object -ComObject WScript.Shell
    $desktop = [Environment]::GetFolderPath('Desktop')
    $desktopLink = Join-Path $desktop 'SUBWAVE Windows.lnk'
    $shortcut = $shell.CreateShortcut($desktopLink)
    $shortcut.TargetPath = $target
    $shortcut.WorkingDirectory = $ManagerDir
    $shortcut.Description = 'SUB/WAVE Windows Edition manager'
    $shortcut.Save()

    $startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
    if (Test-Path $startMenu) {
        $startLink = Join-Path $startMenu 'SUBWAVE Windows.lnk'
        $shortcut2 = $shell.CreateShortcut($startLink)
        $shortcut2.TargetPath = $target
        $shortcut2.WorkingDirectory = $ManagerDir
        $shortcut2.Description = 'SUB/WAVE Windows Edition manager'
        $shortcut2.Save()
    }
    Write-Ok 'Созданы ярлыки на рабочем столе и в меню «Пуск».'
}

function Ensure-Wsl {
    if (-not (Test-Command 'wsl.exe')) {
        throw 'Команда WSL отсутствует. Установи актуальные обновления Windows 10/11.'
    }
    & wsl.exe --status *> $null
    if ($LASTEXITCODE -eq 0) {
        Write-Ok 'WSL 2 доступен.'
        & wsl.exe --set-default-version 2 *> $null
        & wsl.exe --update *> $null
        $oldMarker = Join-Path $InstallRoot 'REBOOT-REQUIRED.txt'
        if (Test-Path $oldMarker) { Remove-Item -LiteralPath $oldMarker -Force -ErrorAction SilentlyContinue }
        return $true
    }

    if (-not (Test-IsAdministrator)) {
        Restart-Elevated 'install' | Out-Null
        return $false
    }

    Write-Step 'Включаю WSL 2 и компонент виртуальной машины...'
    Invoke-External -FilePath 'dism.exe' -Arguments @('/online','/enable-feature','/featurename:Microsoft-Windows-Subsystem-Linux','/all','/norestart') -IgnoreExitCode | Out-Null
    if ($script:LastExternalExitCode -ne 0 -and $script:LastExternalExitCode -ne 3010) { throw ('Не удалось включить WSL. Код DISM: {0}' -f $script:LastExternalExitCode) }
    Invoke-External -FilePath 'dism.exe' -Arguments @('/online','/enable-feature','/featurename:VirtualMachinePlatform','/all','/norestart') -IgnoreExitCode | Out-Null
    if ($script:LastExternalExitCode -ne 0 -and $script:LastExternalExitCode -ne 3010) { throw ('Не удалось включить VirtualMachinePlatform. Код DISM: {0}' -f $script:LastExternalExitCode) }
    Invoke-External -FilePath 'wsl.exe' -Arguments @('--set-default-version','2') -IgnoreExitCode | Out-Null
    $marker = Join-Path $InstallRoot 'REBOOT-REQUIRED.txt'
    Set-Utf8NoBom -Path $marker -Lines @(
        'Перезагрузи Windows, затем снова запусти INSTALL.cmd.',
        ('Создано: {0}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
    )
    Write-Warn 'Компоненты WSL включены. Перезагрузи Windows и снова запусти INSTALL.cmd.'
    return $false
}

function Install-DockerDesktop {
    Add-DockerToPath
    if ((Test-Command 'docker.exe') -or ($null -ne (Get-DockerDesktopExe))) { return }
    if (-not (Test-Command 'winget.exe')) {
        Start-Process 'https://www.docker.com/products/docker-desktop/'
        throw 'winget не найден. Открыта страница Docker Desktop; установи его и снова запусти INSTALL.cmd.'
    }
    Write-Step 'Устанавливаю Docker Desktop через winget...'
    Invoke-External -FilePath 'winget.exe' -Arguments @(
        'install','--exact','--id','Docker.DockerDesktop',
        '--accept-package-agreements','--accept-source-agreements',
        '--silent','--disable-interactivity'
    ) | Out-Null
    $machinePath = [Environment]::GetEnvironmentVariable('Path','Machine')
    $userPath = [Environment]::GetEnvironmentVariable('Path','User')
    $env:Path = $machinePath + ';' + $userPath
    Write-Ok 'Docker Desktop установлен.'
}

function Start-DockerDesktop {
    Add-DockerToPath
    if (-not (Test-Command 'docker.exe')) { throw 'docker.exe не найден после установки Docker Desktop.' }

    & docker.exe info *> $null
    if ($LASTEXITCODE -eq 0) { return }

    Write-Step 'Запускаю Docker Desktop...'
    & docker.exe desktop start --detach *> $null
    if ($LASTEXITCODE -ne 0) {
        $desktopExe = Get-DockerDesktopExe
        if ($null -ne $desktopExe) { Start-Process -FilePath $desktopExe | Out-Null }
    }

    for ($i = 0; $i -lt 120; $i++) {
        Start-Sleep -Seconds 2
        & docker.exe info *> $null
        if ($LASTEXITCODE -eq 0) { Write-Ok 'Docker Engine запущен.'; return }
    }
    throw 'Docker Engine не запустился. Открой Docker Desktop и прими его условия/проверь сообщение об ошибке.'
}

function Ensure-LinuxContainers {
    $osType = (& docker.exe info --format '{{.OSType}}' 2>$null).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Не удалось определить режим Docker.' }
    if ($osType -eq 'linux') {
        Write-Ok 'Docker использует Linux-контейнеры.'
        return
    }
    Write-Step 'Переключаю Docker Desktop на Linux-контейнеры...'
    & docker.exe desktop engine use linux *> $null
    if ($LASTEXITCODE -ne 0) {
        $legacyCli = Get-DockerCliExe
        if ($null -eq $legacyCli) {
            throw 'Docker работает в режиме Windows containers, а переключатель Linux containers не найден.'
        }
        & $legacyCli -SwitchLinuxEngine | Out-Null
    }
    Start-Sleep -Seconds 3
    Start-DockerDesktop
    $osType = (& docker.exe info --format '{{.OSType}}' 2>$null).Trim()
    if ($osType -ne 'linux') { throw 'Не удалось переключить Docker на Linux-контейнеры.' }
    Write-Ok 'Режим Linux-контейнеров включён.'
}

function Ensure-DockerReady {
    Add-DockerToPath
    if (-not (Test-Command 'docker.exe')) { Install-DockerDesktop }
    Start-DockerDesktop
    Ensure-LinuxContainers
    & docker.exe compose version *> $null
    if ($LASTEXITCODE -ne 0) { throw 'Docker Compose v2 недоступен.' }
    Write-Ok 'Docker Compose доступен.'
}

function New-EnvironmentFile {
    Ensure-InstallFolders
    if (Test-Path $EnvFile) {
        Write-Ok 'Существующий .env сохранён без изменений.'
        return
    }

    $defaultUser = 'admin'
    $enteredUser = Read-Host ('Логин администратора [{0}]' -f $defaultUser)
    if ([string]::IsNullOrWhiteSpace($enteredUser)) { $enteredUser = $defaultUser }
    if ($enteredUser -notmatch '^[A-Za-z0-9_.-]{1,64}$') {
        throw 'Логин может содержать только латинские буквы, цифры, точку, дефис и подчёркивание.'
    }

    $port = Get-FreePort
    $defaultTz = 'Asia/Nicosia'
    $enteredTz = Read-Host ('Часовой пояс IANA [{0}]' -f $defaultTz)
    if ([string]::IsNullOrWhiteSpace($enteredTz)) { $enteredTz = $defaultTz }
    if ($enteredTz -notmatch '^[A-Za-z0-9_+\-/]+$') { throw 'Некорректный часовой пояс.' }

    $password = New-RandomPassword
    $lines = @(
        '# Generated by SUB/WAVE Windows Edition',
        ('# {0}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')),
        ('ADMIN_USER={0}' -f $enteredUser),
        ('ADMIN_PASS={0}' -f $password),
        ('SITE_URL=http://localhost:{0}' -f $port),
        ('CADDY_PORT={0}' -f $port),
        'STATE_DIR=./state',
        ('TZ={0}' -f $enteredTz),
        'SUBWAVE_VERSION=latest',
        'SUBWAVE_HOMEPAGE=player'
    )
    Set-Utf8NoBom -Path $EnvFile -Lines $lines
    Write-Ok ('.env создан; выбран порт {0}.' -f $port)
    Write-Host ''
    Write-Host 'Данные входа:' -ForegroundColor Cyan
    Write-Host ('  Логин:  {0}' -f $enteredUser) -ForegroundColor White
    Write-Host ('  Пароль: {0}' -f $password) -ForegroundColor White
    Write-Host 'Пароль также можно посмотреть через пункт «Показать данные входа».' -ForegroundColor DarkGray
}

function Install-SubWave {
    Write-Title
    Ensure-InstallFolders
    Install-ManagerFiles
    New-ManagerShortcuts
    if (-not (Ensure-Wsl)) { return }
    Install-DockerDesktop
    Ensure-DockerReady

    if (-not (Test-Path $ComposeFile)) {
        Copy-Item -LiteralPath $BundledCompose -Destination $ComposeFile -Force
        Write-Ok 'Стабильный docker-compose.yml установлен.'
    }
    if (-not (Test-Path (Join-Path $InstallRoot '.env.example'))) {
        Copy-Item -LiteralPath $BundledEnvExample -Destination (Join-Path $InstallRoot '.env.example') -Force
    }
    New-EnvironmentFile

    Write-Step 'Загружаю официальные контейнеры SUB/WAVE...'
    Invoke-Compose -Arguments @('pull')
    Write-Step 'Запускаю SUB/WAVE...'
    Invoke-Compose -Arguments @('up','-d','--no-build','--remove-orphans')
    Show-Status
    Wait-WebPanel | Out-Null
    Open-Panel -Onboarding
}

function Start-SubWave {
    Write-Title
    Ensure-DockerReady
    if (-not (Test-Path $EnvFile)) { throw 'SUB/WAVE ещё не установлен. Запусти INSTALL.cmd.' }
    Write-Step 'Запускаю контейнеры...'
    Invoke-Compose -Arguments @('up','-d','--no-build','--remove-orphans')
    Show-Status
    Wait-WebPanel | Out-Null
}

function Stop-SubWave {
    Write-Title
    Ensure-DockerReady
    Write-Step 'Останавливаю SUB/WAVE без удаления данных...'
    Invoke-Compose -Arguments @('stop')
    Write-Ok 'SUB/WAVE остановлен. Музыка и настройки сохранены.'
}

function Restart-SubWave {
    Write-Title
    Ensure-DockerReady
    Invoke-Compose -Arguments @('restart')
    Show-Status
}

function Update-SubWave {
    Write-Title
    Ensure-DockerReady
    Ensure-InstallFolders
    if (-not (Test-Path $EnvFile)) { throw 'SUB/WAVE ещё не установлен. Запусти INSTALL.cmd.' }

    if (Test-Path $ComposeFile) {
        $backup = Join-Path $BackupsDir ('docker-compose-{0}.yml' -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
        Copy-Item -LiteralPath $ComposeFile -Destination $backup -Force
        Write-Ok ('Резервная копия compose: {0}' -f $backup)
    }

    $tempCompose = Join-Path $InstallRoot 'docker-compose.download.yml'
    Write-Step 'Получаю стабильный compose из официальной ветки main...'
    Invoke-WebRequest -UseBasicParsing -Uri $UpstreamComposeUrl -OutFile $tempCompose
    if ((Get-Item $tempCompose).Length -lt 1000) { throw 'Загруженный docker-compose.yml выглядит повреждённым.' }
    Move-Item -LiteralPath $tempCompose -Destination $ComposeFile -Force
    try { Invoke-WebRequest -UseBasicParsing -Uri $UpstreamEnvUrl -OutFile (Join-Path $InstallRoot '.env.example') } catch { Write-Warn 'Не удалось обновить .env.example; рабочий .env не затронут.' }

    Write-Step 'Загружаю новые образы...'
    Invoke-Compose -Arguments @('pull')
    Write-Step 'Пересоздаю только изменившиеся контейнеры...'
    Invoke-Compose -Arguments @('up','-d','--no-build','--remove-orphans')
    Write-Ok 'SUB/WAVE обновлён; .env и state не изменялись.'
    Show-Status
    Wait-WebPanel | Out-Null
}

function Show-Status {
    Write-Host ''
    Write-Host 'Состояние контейнеров:' -ForegroundColor Cyan
    Invoke-Compose -Arguments @('ps') -IgnoreExitCode
    $port = Get-EnvValue 'CADDY_PORT' '7700'
    Write-Host ''
    Write-Host ('Панель: http://localhost:{0}' -f $port) -ForegroundColor Green
}

function Show-Logs {
    Write-Title
    Ensure-DockerReady
    Write-Host 'Для выхода из логов нажми Ctrl+C.' -ForegroundColor Yellow
    Invoke-Compose -Arguments @('logs','--tail','250','--follow') -IgnoreExitCode
}

function Wait-WebPanel {
    $port = Get-EnvValue 'CADDY_PORT' '7700'
    $url = 'http://localhost:{0}/' -f $port
    Write-Step 'Проверяю готовность веб-панели...'
    for ($i = 0; $i -lt 60; $i++) {
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 4
            if ([int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 500) {
                Write-Ok 'Веб-панель отвечает.'
                return $true
            }
        } catch { }
        Start-Sleep -Seconds 3
    }
    Write-Warn 'Контейнеры запущены, но веб-панель пока не ответила. Проверь LOGS.cmd.'
    return $false
}

function Open-Panel {
    param([switch]$Onboarding)
    if (-not (Test-Path $EnvFile)) { throw 'SUB/WAVE ещё не установлен. Запусти INSTALL.cmd.' }
    $port = Get-EnvValue 'CADDY_PORT' '7700'
    $path = if ($Onboarding) { '/onboarding' } else { '/' }
    $url = 'http://localhost:{0}{1}' -f $port, $path
    Start-Process $url
    Write-Ok ('Открыт адрес {0}' -f $url)
}

function Show-Credentials {
    Write-Title
    if (-not (Test-Path $EnvFile)) { throw 'Файл .env не найден.' }
    Write-Host ('Логин:  {0}' -f (Get-EnvValue 'ADMIN_USER')) -ForegroundColor White
    Write-Host ('Пароль: {0}' -f (Get-EnvValue 'ADMIN_PASS')) -ForegroundColor White
    Write-Host ('Адрес:  {0}' -f (Get-EnvValue 'SITE_URL')) -ForegroundColor White
}

function Run-Doctor {
    Write-Title
    Ensure-InstallFolders
    $report = New-Object System.Collections.Generic.List[string]
    $report.Add('SUB/WAVE Windows Edition diagnostics')
    $report.Add(('Created: {0}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')))
    $report.Add(('Windows: {0}' -f [Environment]::OSVersion.VersionString))
    $report.Add(('InstallRoot: {0}' -f $InstallRoot))
    $report.Add(('PowerShell: {0}' -f $PSVersionTable.PSVersion.ToString()))
    $report.Add(('WSL command: {0}' -f (Test-Command 'wsl.exe')))
    $report.Add(('Docker command: {0}' -f (Test-Command 'docker.exe')))
    $report.Add(('Compose file: {0}' -f (Test-Path $ComposeFile)))
    $report.Add(('Env file: {0}' -f (Test-Path $EnvFile)))

    if (Test-Command 'wsl.exe') {
        $wslText = (& wsl.exe --status 2>&1 | Out-String).Trim()
        $report.Add('--- WSL STATUS ---')
        $report.Add($wslText)
    }
    if (Test-Command 'docker.exe') {
        $dockerVersion = (& docker.exe version 2>&1 | Out-String).Trim()
        $dockerInfo = (& docker.exe info 2>&1 | Out-String).Trim()
        $report.Add('--- DOCKER VERSION ---')
        $report.Add($dockerVersion)
        $report.Add('--- DOCKER INFO ---')
        $report.Add($dockerInfo)
        if ((Test-Path $ComposeFile) -and (Test-Path $EnvFile)) {
            $composePs = (& docker.exe compose --project-name subwave --file $ComposeFile --env-file $EnvFile ps 2>&1 | Out-String).Trim()
            $composeConfig = (& docker.exe compose --project-name subwave --file $ComposeFile --env-file $EnvFile config --quiet 2>&1 | Out-String).Trim()
            $report.Add('--- COMPOSE PS ---')
            $report.Add($composePs)
            $report.Add('--- COMPOSE CONFIG CHECK ---')
            $report.Add($composeConfig)
        }
    }

    if (Test-Path $EnvFile) {
        $port = Get-EnvValue 'CADDY_PORT' '7700'
        $report.Add(('CADDY_PORT: {0}' -f $port))
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri ('http://localhost:{0}/' -f $port) -TimeoutSec 8
            $report.Add(('HTTP status: {0}' -f [int]$response.StatusCode))
        } catch {
            $report.Add(('HTTP error: {0}' -f $_.Exception.Message))
        }
    }

    $file = Join-Path $DiagnosticsDir ('subwave-doctor-{0}.txt' -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
    Set-Utf8NoBom -Path $file -Lines $report.ToArray()
    Write-Ok ('Диагностика сохранена: {0}' -f $file)
    Write-Host 'Этот TXT можно отправить для разбора ошибки.' -ForegroundColor DarkGray
    Start-Process explorer.exe -ArgumentList ('/select,"{0}"' -f $file)
}

function Show-Menu {
    while ($true) {
        Write-Title
        $installed = (Test-Path $EnvFile) -and (Test-Path $ComposeFile)
        if ($installed) {
            Write-Host 'Статус установки: установлено' -ForegroundColor Green
            Write-Host ('Адрес: {0}' -f (Get-EnvValue 'SITE_URL' 'http://localhost:7700')) -ForegroundColor DarkGray
        } else {
            Write-Host 'Статус установки: не установлено' -ForegroundColor Yellow
        }
        Write-Host ''
        Write-Host '  1. Установить / восстановить'
        Write-Host '  2. Запустить'
        Write-Host '  3. Остановить'
        Write-Host '  4. Перезапустить'
        Write-Host '  5. Открыть панель'
        Write-Host '  6. Обновить'
        Write-Host '  7. Показать состояние'
        Write-Host '  8. Открыть логи'
        Write-Host '  9. Диагностика'
        Write-Host '  0. Показать данные входа'
        Write-Host '  Q. Выход'
        Write-Host ''
        $choice = (Read-Host 'Выбери действие').Trim().ToUpperInvariant()
        try {
            switch ($choice) {
                '1' { Install-SubWave }
                '2' { Start-SubWave }
                '3' { Stop-SubWave }
                '4' { Restart-SubWave }
                '5' { Open-Panel }
                '6' { Update-SubWave }
                '7' { Write-Title; Ensure-DockerReady; Show-Status }
                '8' { Show-Logs }
                '9' { Run-Doctor }
                '0' { Show-Credentials }
                'Q' { return }
                default { Write-Warn 'Неизвестный пункт.' }
            }
        } catch {
            Write-Fail $_.Exception.Message
        }
        Write-Host ''
        Read-Host 'Нажми Enter, чтобы вернуться в меню' | Out-Null
    }
}

try {
    switch ($Action) {
        'menu' { Show-Menu }
        'install' { Install-SubWave }
        'start' { Start-SubWave }
        'stop' { Stop-SubWave }
        'restart' { Restart-SubWave }
        'update' { Update-SubWave }
        'logs' { Show-Logs }
        'status' { Write-Title; Ensure-DockerReady; Show-Status }
        'open' { Write-Title; Open-Panel }
        'doctor' { Run-Doctor }
        'credentials' { Show-Credentials }
    }
} catch {
    Write-Host ''
    Write-Fail $_.Exception.Message
    Write-Host ''
    Write-Host 'Запусти DIAGNOSTICS.cmd, если ошибка повторяется.' -ForegroundColor Yellow
    exit 1
}
