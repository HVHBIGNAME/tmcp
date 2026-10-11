param([Parameter(Mandatory = $true)][string]$Manifest)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Import-Module "$PSHOME\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1" -ErrorAction Stop
$Utf8 = New-Object Text.UTF8Encoding $false
$Plan = Get-Content -LiteralPath $Manifest -Raw | ConvertFrom-Json
$HomeDir = [IO.Path]::GetFullPath($Plan.home)
$UpdateDir = Join-Path $HomeDir '.updates'
$Stage = Split-Path -Parent ([IO.Path]::GetFullPath($Manifest))
$Prefix = $UpdateDir.TrimEnd('\') + '\'
if (-not $Stage.StartsWith($Prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Update manifest is outside the managed update directory.' }
if ([IO.Path]::GetFullPath($Plan.candidate) -ne (Join-Path $Stage 'TMCP.exe')) { throw 'Invalid update candidate path.' }
if ($Plan.sha256 -notmatch '^[a-f0-9]{64}$' -or $Plan.version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid update identity.' }
foreach ($Directory in @($UpdateDir, $Stage)) {
    if (([IO.DirectoryInfo]::new($Directory)).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Update directories must not be links.' }
}
$Target = Join-Path $HomeDir 'TMCP.exe'
$Backup = Join-Path $Stage 'previous.exe'
$Ready = Join-Path $Stage 'application.ready'
$Abort = Join-Path $Stage 'abort'
$StatusFile = Join-Path $UpdateDir 'status.json'
$Changed = $false
$NewProcess = $null
function Save-Status([string]$Status, [string]$Message) {
    $Value = @{ status = $Status; version = $Plan.version; message = $Message; at = [DateTime]::UtcNow.ToString('o'); pid = if ($NewProcess) { $NewProcess.Id } else { $null } } | ConvertTo-Json -Compress
    $Temporary = $StatusFile + '.' + [guid]::NewGuid().ToString('N')
    [IO.File]::WriteAllText($Temporary, $Value, $Utf8)
    if ([IO.File]::Exists($StatusFile)) { [IO.File]::Replace($Temporary, $StatusFile, [NullString]::Value) }
    else { [IO.File]::Move($Temporary, $StatusFile) }
}
function Start-App([bool]$Updated) {
    $env:TMCP_UPDATE_READY_FILE = if ($Updated) { $Ready } else { $null }
    $env:MCP_ENV_FILE = $Plan.envFile
    $env:MCP_DATA_DIR = $Plan.data
    $Args = '--home "' + $HomeDir.TrimEnd('\') + '"'
    if ($Plan.headless) { $Args += ' --headless' }
    elseif ($Plan.show) { $Args += ' --show' }
    else { $Args += ' --background' }
    if ($Plan.local) { $Args += ' --local' }
    $Info = New-Object Diagnostics.ProcessStartInfo
    $Info.FileName = $Target
    $Info.Arguments = $Args
    $Info.WorkingDirectory = $HomeDir
    $Info.UseShellExecute = $false
    $Info.CreateNoWindow = $true
    return [Diagnostics.Process]::Start($Info)
}
function Stop-NewBackend {
    $env:MCP_ENV_FILE = $Plan.envFile
    $env:MCP_DATA_DIR = $Plan.data
    & $Plan.node $Plan.cli stop
    if ($LASTEXITCODE -ne 0) { throw 'Cannot stop the updated backend for rollback.' }
}
function Remove-OldUpdates {
    $Stages = @(Get-ChildItem -LiteralPath $UpdateDir -Directory | Where-Object {
        $_.Name -match '^[a-f0-9]{32}$' -and $_.FullName -ne $Stage -and [IO.File]::Exists((Join-Path $_.FullName 'plan.json'))
    } | Sort-Object LastWriteTimeUtc -Descending)
    foreach ($Folder in ($Stages | Select-Object -Skip 1)) {
        $Saved = Get-Content -LiteralPath (Join-Path $Folder.FullName 'plan.json') -Raw | ConvertFrom-Json
        if ($Saved.home -eq $HomeDir) { Remove-Item -LiteralPath $Folder.FullName -Recurse -Force }
    }
    $Current = (Get-Content -LiteralPath (Join-Path $HomeDir 'application.json') -Raw | ConvertFrom-Json).project
    $Previous = [IO.Directory]::GetParent([IO.Path]::GetDirectoryName($Plan.node)).FullName
    $Processes = @(Get-Process node,msedgewebview2 -ErrorAction SilentlyContinue)
    foreach ($Folder in (Get-ChildItem -LiteralPath (Join-Path $HomeDir 'app') -Directory)) {
        if ($Folder.FullName -eq $Current -or $Folder.FullName -eq $Previous -or $Folder.Name -notmatch '^[a-f0-9]{20}$') { continue }
        $Marker = Join-Path $Folder.FullName 'payload.ready'
        if (-not [IO.File]::Exists($Marker)) { continue }
        $HashValue = [IO.File]::ReadAllText($Marker)
        if ($HashValue -notmatch '^[a-f0-9]{64}$' -or -not $HashValue.StartsWith($Folder.Name)) { continue }
        $InUse = @($Processes | Where-Object { $_.Path -and $_.Path.StartsWith($Folder.FullName + '\', [StringComparison]::OrdinalIgnoreCase) })
        if ($InUse.Count -eq 0) { Remove-Item -LiteralPath $Folder.FullName -Recurse -Force }
    }
}
$Hash = [Security.Cryptography.SHA256]::Create()
try { $Identity = [BitConverter]::ToString($Hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($HomeDir.ToUpperInvariant()))).Replace('-', '') }
finally { $Hash.Dispose() }
$Mutex = New-Object Threading.Mutex($false, ('Local\TMCP.Update.' + $Identity))
$Owned = $Mutex.WaitOne(0)
if (-not $Owned) { $Mutex.Dispose(); throw 'Another update installer is running.' }
try {
    if ((Get-FileHash -LiteralPath $Plan.candidate -Algorithm SHA256).Hash -ne $Plan.sha256) { throw 'Update SHA-256 mismatch.' }
    if (-not [IO.File]::Exists($Target)) { throw 'Installed executable is missing.' }
    [IO.File]::WriteAllText((Join-Path $Stage 'installer.ready'), 'ready', $Utf8)
    $Old = Get-Process -Id $Plan.oldPid -ErrorAction SilentlyContinue
    if ($Old -and $Old.Path -eq $Plan.oldExecutable) {
        $Deadline = [DateTime]::UtcNow.AddSeconds(120)
        while (-not $Old.HasExited) {
            if ([IO.File]::Exists($Abort)) { return }
            if ([DateTime]::UtcNow -gt $Deadline) { throw 'The previous application did not exit.' }
            Start-Sleep -Milliseconds 200
            $Old.Refresh()
        }
    }
    if ([IO.File]::Exists($Abort)) { return }
    Save-Status 'installing' 'Installing the verified update.'
    [IO.File]::Replace($Plan.candidate, $Target, $Backup)
    $Changed = $true
    $NewProcess = Start-App $true
    $Deadline = [DateTime]::UtcNow.AddMinutes(5)
    $Healthy = $false
    while ([DateTime]::UtcNow -lt $Deadline) {
        if ([IO.File]::Exists($Ready)) {
            try {
                $Health = Get-Content -LiteralPath $Ready -Raw | ConvertFrom-Json
                if ($Health.version -eq $Plan.version) { $Healthy = $true; break }
            } catch { }
        }
        if ($NewProcess.HasExited -and $NewProcess.ExitCode -ne 0) { break }
        Start-Sleep -Milliseconds 250
    }
    if (-not $Healthy) { throw 'The updated application did not report readiness.' }
    Save-Status 'installed' 'Update installed and startup verified.'
    try { Remove-OldUpdates } catch { Write-Warning ('Old update cleanup: ' + $_.Exception.Message) }
} catch {
    $Failure = $_.Exception.Message
    if ($Changed) {
        try {
            if ($NewProcess -and -not $NewProcess.HasExited) { $NewProcess.Kill(); $NewProcess.WaitForExit(10000) | Out-Null }
            Stop-NewBackend
            [IO.File]::Replace($Backup, $Target, (Join-Path $Stage 'failed.exe'))
            Save-Status 'failed' $Failure
            $NewProcess = Start-App $false
        } catch { Save-Status 'failed' ($Failure + ' Rollback: ' + $_.Exception.Message); throw }
    } else { Save-Status 'failed' $Failure }
    exit 1
} finally {
    if ($Owned) { $Mutex.ReleaseMutex() }
    $Mutex.Dispose()
}
