param(
    [ValidateSet('auto', 'cli', 'gui')][string]$Mode = 'auto',
    [string]$InstallDir = "$env:LOCALAPPDATA\TMCP",
    [string]$Version = 'latest',
    [string]$Root = $env:USERPROFILE,
    [switch]$NoStart,
    [switch]$NoPathUpdate,
    [switch]$Autostart
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
if (-not [Environment]::Is64BitOperatingSystem) { throw 'TMCP requires 64-bit Windows.' }
if ($Version -notmatch '^(latest|v[0-9]+\.[0-9]+\.[0-9]+(?:[-.][A-Za-z0-9.-]+)?)$') { throw 'Invalid release tag.' }
if ($Mode -eq 'auto') {
    $Mode = if ([Environment]::UserInteractive -and (Get-CimInstance Win32_OperatingSystem).ProductType -eq 1) { 'gui' } else { 'cli' }
}
$InstallDir = [IO.Path]::GetFullPath($InstallDir)
$Temp = Join-Path ([IO.Path]::GetTempPath()) ('tmcp-install-' + [guid]::NewGuid().ToString('N'))
$Utf8 = New-Object Text.UTF8Encoding $false
New-Item -ItemType Directory -Path $Temp, $InstallDir -Force | Out-Null
try {
    $Api = if ($Version -eq 'latest') { 'latest' } else { "tags/$Version" }
    $Release = Invoke-RestMethod "https://api.github.com/repos/HVHBIGNAME/tmcp/releases/$Api" -TimeoutSec 60
    $Asset = $Release.assets | Where-Object { $_.name -eq 'TMCP.exe' }
    if (-not $Asset -or $Asset.digest -notmatch '^sha256:([a-f0-9]{64})$') { throw 'Select a TMCP 2.0+ release with a verified TMCP.exe asset.' }
    $Digest = $Matches[1]
    'Downloading the standalone TMCP.exe...'
    Invoke-WebRequest $Asset.browser_download_url -OutFile "$Temp\TMCP.exe" -UseBasicParsing -TimeoutSec 600
    if ((Get-FileHash "$Temp\TMCP.exe" -Algorithm SHA256).Hash -ne $Digest) { throw 'TMCP.exe checksum mismatch.' }
    $Executable = Join-Path $InstallDir 'TMCP.exe'
    Copy-Item -LiteralPath "$Temp\TMCP.exe" -Destination $Executable -Force
    $EnvFile = Join-Path $InstallDir '.env'
    if (-not (Test-Path -LiteralPath $EnvFile)) {
        $Roots = ConvertTo-Json -InputObject @((Resolve-Path -LiteralPath $Root).Path.Replace('\', '/')) -Compress
        [IO.File]::WriteAllText($EnvFile, "MCP_PORT=18787`nMCP_ROOTS=$Roots`nMCP_ENABLE_SHELL=true`nMCP_ENABLE_SCREENSHOTS=true`nMCP_GATEWAY_DISCOVER=true`nMCP_GATEWAY_MODE=catalog`n", $Utf8)
    }
    $Prepare = Start-Process -FilePath $Executable -ArgumentList @('--prepare-only', '--home', ('"' + $InstallDir.TrimEnd('\') + '"')) -PassThru -Wait
    if ($Prepare.ExitCode -ne 0) { throw 'Component preparation failed. See .mcp-tunnel/ui-error.log.' }
    $App = Get-Content -LiteralPath "$InstallDir\application.json" -Raw | ConvertFrom-Json
    New-Item -ItemType Directory -Path "$InstallDir\bin", $App.data -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $App.data 'install.json'), (ConvertTo-Json @{ mode = $Mode }), $Utf8)
    $Wrapper = @'
$ErrorActionPreference = 'Stop'
$HomeDir = Split-Path -Parent $PSScriptRoot
$App = Get-Content -LiteralPath (Join-Path $HomeDir 'application.json') -Raw | ConvertFrom-Json
$env:MCP_ENV_FILE = $App.envFile
$env:MCP_DATA_DIR = $App.data
$env:MCP_DESKTOP_EXE = Join-Path $HomeDir 'TMCP.exe'
$env:MCP_DESKTOP_MODE = (Get-Content -LiteralPath (Join-Path $App.data 'install.json') -Raw | ConvertFrom-Json).mode
$env:CLOUDFLARED_BIN = Join-Path $App.project 'bin\cloudflared.exe'
& $App.node $App.cli @args
exit $LASTEXITCODE
'@
    [IO.File]::WriteAllText("$InstallDir\bin\tmcp.ps1", $Wrapper, $Utf8)
    [IO.File]::WriteAllText("$InstallDir\bin\tmcp.cmd", "@echo off`r`npowershell.exe -NoProfile -ExecutionPolicy Bypass -File `"%~dp0tmcp.ps1`" %*`r`n", [Text.Encoding]::ASCII)
    & "$InstallDir\bin\tmcp.cmd" setup --root $Root
    if ($LASTEXITCODE -ne 0) { throw 'TMCP setup failed.' }
    if (-not $NoPathUpdate) {
        $UserPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
        if (($UserPath -split ';') -notcontains "$InstallDir\bin") { [Environment]::SetEnvironmentVariable('PATH', "$InstallDir\bin;$UserPath", 'User') }
    }
    if ($Mode -eq 'gui') {
        $Menu = Join-Path ([Environment]::GetFolderPath('Programs')) 'TMCP'
        New-Item -ItemType Directory -Path $Menu -Force | Out-Null
        $Shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut("$Menu\TMCP.lnk")
        $Shortcut.TargetPath = $Executable
        $Shortcut.Arguments = '--home "' + $InstallDir.TrimEnd('\') + '"'
        $Shortcut.WorkingDirectory = $InstallDir
        $Shortcut.IconLocation = "$Executable,0"
        $Shortcut.Save()
    }
    if ($Autostart) {
        & "$InstallDir\bin\tmcp.cmd" autostart on
        if ($LASTEXITCODE -ne 0) { throw 'Autostart registration failed.' }
    }
    if (-not $NoStart) {
        $Launch = @('--home', ('"' + $InstallDir.TrimEnd('\') + '"'))
        if ($Mode -eq 'cli') { $Launch += '--headless' }
        Start-Process -FilePath $Executable -ArgumentList $Launch -WorkingDirectory $InstallDir
    }
    "Installed in $InstallDir. Open a new terminal and run: tmcp"
} finally {
    Remove-Item -LiteralPath $Temp -Recurse -Force
}
