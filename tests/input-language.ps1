param([Parameter(Mandatory = $true)][int]$ProcessId)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LanguageProbe {
    public delegate bool EnumProc(IntPtr window, IntPtr state);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr window, EnumProc callback, IntPtr state);
    [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
    public static void Send(IntPtr window) {
        IntPtr result;
        SendMessageTimeout(window, 0x0051, IntPtr.Zero, new IntPtr(0x04190419), 2, 1000, out result);
    }
    public static void Probe(IntPtr window) {
        Send(window);
        EnumChildWindows(window, (child, _) => { Send(child); return true; }, IntPtr.Zero);
    }
}
'@
$process = Get-Process -Id $ProcessId
if ($process.MainWindowHandle -eq [IntPtr]::Zero) { throw 'No desktop window found.' }
[LanguageProbe]::Probe($process.MainWindowHandle)
'Input-language notifications delivered.'
