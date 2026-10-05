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
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Repo = 'HVHBIGNAME/tmcp'
if ($Mode -eq 'auto') {
    $Desktop = [Environment]::UserInteractive -and ((Get-CimInstance Win32_OperatingSystem).ProductType -eq 1)
    $Mode = if ($Desktop) { 'gui' } else { 'cli' }
}
$Temp = Join-Path ([IO.Path]::GetTempPath()) ('tmcp-install-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Temp, $InstallDir -Force | Out-Null
function Download([string]$Url, [string]$Target) { Invoke-WebRequest -Uri $Url -OutFile $Target -UseBasicParsing -TimeoutSec 180 }
function Verify([string]$File, [string]$Hash) {
    if (-not $Hash -or (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash -ne $Hash) { throw "Checksum verification failed: $File" }
}
function RunNode([string[]]$Arguments) { & $script:Node @Arguments; if ($LASTEXITCODE -ne 0) { throw 'TMCP command failed.' } }
try {
    "TMCP - setup for Windows ($Mode)"
    $Node = $null
    $Command = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($Command) {
        $NodeVersion = & $Command.Source --version
        if ($LASTEXITCODE -eq 0 -and [version]$NodeVersion.Trim().TrimStart('v') -ge [version]'22.16.0') { $Node = $Command.Source }
    }
    if (-not $Node) {
        'Installing a private Node.js 24 LTS runtime...'
        Download 'https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt' "$Temp\node-sums.txt"
        $Entry = (Get-Content -LiteralPath "$Temp\node-sums.txt" | Where-Object { $_ -match '\snode-v[\d.]+-win-x64.zip$' })
        if (-not $Entry) { throw 'No compatible Node.js download found.' }
        $Parts = $Entry.Trim() -split '\s+'
        Download "https://nodejs.org/dist/latest-v24.x/$($Parts[1])" "$Temp\node.zip"
        Verify "$Temp\node.zip" $Parts[0]
        Expand-Archive -LiteralPath "$Temp\node.zip" -DestinationPath "$Temp\node"
        $NodeFolder = Get-ChildItem -LiteralPath "$Temp\node" -Directory
        New-Item -ItemType Directory -Path "$InstallDir\runtime" -Force | Out-Null
        Copy-Item -Path "$($NodeFolder.FullName)\*" -Destination "$InstallDir\runtime" -Recurse -Force
        $Node = "$InstallDir\runtime\node.exe"
    }
    $env:PATH = "$(Split-Path -Parent $Node);$env:PATH"
    $Base = if ($Version -eq 'latest') { "https://github.com/$Repo/releases/latest/download" } else { "https://github.com/$Repo/releases/download/$Version" }
    Download "$Base/SHA256SUMS.txt" "$Temp\SHA256SUMS.txt"
    $Sums = Get-Content -LiteralPath "$Temp\SHA256SUMS.txt"
    $Assets = @('tmcp-core.zip')
    if ($Mode -eq 'gui') { $Assets += 'tmcp-windows-x64.zip' }
    foreach ($Asset in $Assets) {
        Download "$Base/$Asset" "$Temp\$Asset"
        $Entry = $Sums | Where-Object { ($_ -split '\s+')[1] -eq $Asset }
        Verify "$Temp\$Asset" (($Entry -split '\s+')[0])
        Expand-Archive -LiteralPath "$Temp\$Asset" -DestinationPath $InstallDir -Force
    }
    & npm.cmd --prefix $InstallDir ci --omit=dev --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
    RunNode @("$InstallDir\dist\src\cli.js", 'setup', '--root', $Root)
    $RuntimeArgs = @("$InstallDir\scripts\install-runtime.mjs")
    if ($Mode -eq 'gui') { $RuntimeArgs += '--gui' }
    RunNode $RuntimeArgs
    New-Item -ItemType Directory -Path "$InstallDir\bin" -Force | Out-Null
    $Wrapper = "@echo off`r`n`"$Node`" `"$InstallDir\dist\src\cli.js`" %*`r`n"
    [IO.File]::WriteAllText("$InstallDir\bin\tmcp.cmd", $Wrapper, [Text.Encoding]::Default)
    if (-not $NoPathUpdate) {
        $UserPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
        if (($UserPath -split ';') -notcontains "$InstallDir\bin") { [Environment]::SetEnvironmentVariable('PATH', "$InstallDir\bin;$UserPath", 'User') }
    }
    if ($Mode -eq 'gui') {
        $Menu = Join-Path ([Environment]::GetFolderPath('Programs')) 'TMCP'
        New-Item -ItemType Directory -Path $Menu -Force | Out-Null
        $Shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut("$Menu\PC MCP.lnk")
        $Shortcut.TargetPath = "$InstallDir\dist-ui\PcMcp.exe"
        $Shortcut.WorkingDirectory = $InstallDir
        $Shortcut.IconLocation = "$InstallDir\dist-ui\PcMcp.exe,0"
        $Shortcut.Save()
    }
    if ($Autostart) { RunNode @("$InstallDir\dist\src\cli.js", 'autostart', 'on') }
    if (-not $NoStart) {
        if ($Mode -eq 'gui') { Start-Process -FilePath "$InstallDir\dist-ui\PcMcp.exe" -WorkingDirectory $InstallDir }
        else { RunNode @("$InstallDir\dist\src\cli.js", 'start') }
    }
    "Installed in $InstallDir. Open a new terminal and run: tmcp"
    'Autostart is optional: tmcp autostart on'
} finally {
    Remove-Item -LiteralPath $Temp -Recurse -Force -ErrorAction SilentlyContinue
}
