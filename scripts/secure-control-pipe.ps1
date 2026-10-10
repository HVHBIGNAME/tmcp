param(
    [Parameter(Mandatory = $true)][string]$Directory,
    [Parameter(Mandatory = $true)][string]$PipeName
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
$network = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-2')
$allow = [System.Security.AccessControl.AccessControlType]::Allow
$deny = [System.Security.AccessControl.AccessControlType]::Deny

$folder = New-Object System.IO.DirectoryInfo($Directory)
if (($folder.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'The IPC directory must not be a link.'
}
$previous = $folder.GetAccessControl()
$owner = $previous.GetOwner([System.Security.Principal.SecurityIdentifier])
$identity = New-Object System.Security.Principal.WindowsPrincipal([System.Security.Principal.WindowsIdentity]::GetCurrent())
if ($owner -ne $user -and -not ($owner.Value -eq 'S-1-5-32-544' -and $identity.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator))) {
    throw 'The IPC directory belongs to another user.'
}
$inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
$propagate = [System.Security.AccessControl.PropagationFlags]::None
$directoryAcl = New-Object System.Security.AccessControl.DirectorySecurity
$directoryAcl.SetAccessRuleProtection($true, $false)
$directoryAcl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($network, 'FullControl', $inherit, $propagate, $deny)))
foreach ($sid in @($user, $system)) {
    $directoryAcl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', $inherit, $propagate, $allow)))
}
try { $folder.SetAccessControl($directoryAcl) }
catch { throw "Cannot protect the IPC directory: $($_.Exception.GetType().Name)" }

# The server dispatches no requests and publishes no endpoint until this succeeds.
# A default Windows pipe allows other users to read, but never to write requests.
$rights = [System.IO.Pipes.PipeAccessRights]'ReadWrite, ReadPermissions, ChangePermissions, TakeOwnership'
$pipe = New-Object System.IO.Pipes.NamedPipeClientStream('.', $PipeName, $rights, [System.IO.Pipes.PipeOptions]::None, [System.Security.Principal.TokenImpersonationLevel]::Identification, [System.IO.HandleInheritability]::None)
try {
    $pipe.Connect(5000)
    $pipeAcl = New-Object System.IO.Pipes.PipeSecurity
    $pipeAcl.SetOwner($user)
    $pipeAcl.SetAccessRuleProtection($true, $false)
    $pipeAcl.AddAccessRule((New-Object System.IO.Pipes.PipeAccessRule($network, 'FullControl', $deny)))
    foreach ($sid in @($user, $system)) {
        $pipeAcl.AddAccessRule((New-Object System.IO.Pipes.PipeAccessRule($sid, 'FullControl', $allow)))
    }
    try { $pipe.SetAccessControl($pipeAcl) }
    catch { throw "Cannot protect the IPC pipe: $($_.Exception.GetType().Name)" }
    $saved = $pipe.GetAccessControl()
    if ($saved.GetOwner([System.Security.Principal.SecurityIdentifier]) -ne $user -or -not $saved.AreAccessRulesProtected) {
        throw 'Cannot verify the private pipe ACL.'
    }
} finally {
    $pipe.Dispose()
}
