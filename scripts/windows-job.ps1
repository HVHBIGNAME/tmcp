param([Parameter(Mandatory = $true)][string]$Executable, [Parameter(Mandatory = $true)][string]$ArgumentsBase64)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class TmcpJob {
    [StructLayout(LayoutKind.Sequential)] struct Limits {
        public long ProcessTime, JobTime; public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet; public uint ActiveProcesses;
        public UIntPtr Affinity; public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct Io {
        public ulong ReadCount, WriteCount, OtherCount, ReadBytes, WriteBytes, OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)] struct Extended {
        public Limits Basic; public Io Counters;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)] struct Startup {
        public uint Size; public IntPtr Reserved, Desktop, Title;
        public uint X, Y, Width, Height, XChars, YChars, Fill, Flags;
        public ushort Show, ReservedSize; public IntPtr ReservedBytes, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
        public IntPtr Process, Thread; public uint Pid, Tid;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int info, ref Extended value, uint length);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string application, StringBuilder command, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr environment, string cwd, ref Startup startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll")] static extern bool SetStdHandle(int kind, IntPtr handle);
    [DllImport("kernel32.dll")] static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AllocConsole();
    [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
    [DllImport("kernel32.dll")] static extern bool SetConsoleOutputCP(uint codepage);
    [DllImport("kernel32.dll")] static extern bool SetConsoleCP(uint codepage);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int show);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    static void Require(bool value) { if (!value) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    static string Quote(string value) {
        return "\"" + System.Text.RegularExpressions.Regex.Replace(
            System.Text.RegularExpressions.Regex.Replace(value, "(\\\\*)\"", "$1$1\\\""), "(\\\\+)$", "$1$1") + "\"";
    }
    public static int Run(string executable, string[] args) {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        Require(job != IntPtr.Zero);
        ProcessInfo process = new ProcessInfo();
        try {
            Extended limits = new Extended(); limits.Basic.Flags = 0x2000;
            Require(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(Extended))));
            Startup start = new Startup(); start.Size = (uint)Marshal.SizeOf(typeof(Startup)); start.Flags = 0x101; start.Show = 0;
            start.Input = GetStdHandle(-10); start.Output = GetStdHandle(-11); start.Error = GetStdHandle(-12);
            FreeConsole();
            Require(AllocConsole());
            ShowWindow(GetConsoleWindow(), 0);
            Require(SetConsoleOutputCP(65001)); Require(SetConsoleCP(65001));
            Require(SetStdHandle(-10, start.Input)); Require(SetStdHandle(-11, start.Output)); Require(SetStdHandle(-12, start.Error));
            foreach (IntPtr handle in new IntPtr[] { start.Input, start.Output, start.Error }) Require(SetHandleInformation(handle, 1, 1));
            StringBuilder command = new StringBuilder(Quote(executable));
            if (System.IO.Path.GetFileName(executable).Equals("cmd.exe", StringComparison.OrdinalIgnoreCase))
                command.Append(" /d /s /c \"").Append(args[args.Length - 1]).Append("\"");
            else foreach (string arg in args) command.Append(" ").Append(Quote(arg));
            Require(CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, true, 0x00000004, IntPtr.Zero, null, ref start, out process));
            if (!AssignProcessToJobObject(job, process.Process)) {
                int error = Marshal.GetLastWin32Error(); TerminateProcess(process.Process, 1); throw new Win32Exception(error);
            }
            Require(ResumeThread(process.Thread) != 0xffffffff);
            Require(WaitForSingleObject(process.Process, 0xffffffff) == 0);
            uint code; Require(GetExitCodeProcess(process.Process, out code));
            return unchecked((int)code);
        } finally {
            CloseHandle(job);
            if (process.Thread != IntPtr.Zero) CloseHandle(process.Thread);
            if (process.Process != IntPtr.Zero) CloseHandle(process.Process);
            FreeConsole();
        }
    }
}
'@
$Arguments = ConvertFrom-Json -InputObject ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ArgumentsBase64)))
exit [TmcpJob]::Run($Executable, [string[]]$Arguments)
