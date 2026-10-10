param([Parameter(Mandatory = $true)][string]$PipeName)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class RestrictedPipeProbe {
    [StructLayout(LayoutKind.Sequential)] struct SidAndAttributes { public IntPtr Sid; public uint Attributes; }
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ConvertStringSidToSid(string text, out IntPtr sid);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool CreateRestrictedToken(IntPtr token, uint flags, uint disabledCount, IntPtr disabled, uint deletedCount, IntPtr deleted, uint restrictedCount, ref SidAndAttributes restricted, out IntPtr result);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool ImpersonateLoggedOnUser(IntPtr token);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool RevertToSelf();
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    public static int OpenWithoutOwnerRights(string name, uint access) {
        IntPtr token = IntPtr.Zero, restricted = IntPtr.Zero, sid = IntPtr.Zero;
        bool impersonating = false;
        try {
            if (!OpenProcessToken(GetCurrentProcess(), 0x0A, out token)) throw new Win32Exception(Marshal.GetLastWin32Error());
            if (!ConvertStringSidToSid("S-1-1-0", out sid)) throw new Win32Exception(Marshal.GetLastWin32Error());
            var entry = new SidAndAttributes { Sid = sid };
            if (!CreateRestrictedToken(token, 1, 0, IntPtr.Zero, 0, IntPtr.Zero, 1, ref entry, out restricted)) throw new Win32Exception(Marshal.GetLastWin32Error());
            if (!ImpersonateLoggedOnUser(restricted)) throw new Win32Exception(Marshal.GetLastWin32Error());
            impersonating = true;
            var pipe = CreateFile(@"\\.\pipe\" + name, access, 0, IntPtr.Zero, 3, 0, IntPtr.Zero);
            if (pipe == new IntPtr(-1)) return Marshal.GetLastWin32Error();
            CloseHandle(pipe);
            return 0;
        } finally {
            if (impersonating && !RevertToSelf()) Environment.FailFast("Cannot restore test identity");
            if (sid != IntPtr.Zero) LocalFree(sid);
            if (restricted != IntPtr.Zero) CloseHandle(restricted);
            if (token != IntPtr.Zero) CloseHandle(token);
        }
    }
}
'@
$pipe = New-Object System.IO.Pipes.NamedPipeClientStream('.', $PipeName, [System.IO.Pipes.PipeDirection]::InOut)
try {
    $pipe.Connect(3000)
    $acl = $pipe.GetAccessControl()
    $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
        @{ sid = $_.IdentityReference.Value; type = $_.AccessControlType.ToString(); rights = [int]$_.PipeAccessRights }
    })
    @{
        owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
        user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        protected = $acl.AreAccessRulesProtected
        rules = $rules
        restrictedRead = [RestrictedPipeProbe]::OpenWithoutOwnerRights($PipeName, [uint32]2147483648)
        restrictedWrite = [RestrictedPipeProbe]::OpenWithoutOwnerRights($PipeName, [uint32]1073741824)
    } | ConvertTo-Json -Depth 4 -Compress
} finally { $pipe.Dispose() }
