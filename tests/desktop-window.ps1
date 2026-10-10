param([int]$ProcessId, [ValidateSet('state', 'invoke', 'post-click', 'close')][string]$Action, [string]$Name)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DesktopWindow {
  public delegate bool Visitor(IntPtr window, IntPtr parameter);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Visitor visitor, IntPtr parameter);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X; public int Y; }
  [DllImport("user32.dll")] private static extern bool ScreenToClient(IntPtr window, ref Point point);
  [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
  public static void PostClick(IntPtr window, uint expectedProcess, int x, int y) {
    uint owner;
    GetWindowThreadProcessId(window, out owner);
    if (owner != expectedProcess || !IsWindowVisible(window)) throw new InvalidOperationException("Wrong native window");
    var point = new Point { X = x, Y = y };
    if (!ScreenToClient(window, ref point)) throw new InvalidOperationException("Cannot map native coordinates");
    var position = new IntPtr(((point.Y & 0xffff) << 16) | (point.X & 0xffff));
    SetForegroundWindow(window);
    if (!PostMessage(window, 0x0200, IntPtr.Zero, position) ||
        !PostMessage(window, 0x0201, new IntPtr(1), position) ||
        !PostMessage(window, 0x0202, IntPtr.Zero, position)) throw new InvalidOperationException("Cannot post native click");
  }
}
'@

function Find-Control {
    # Walking every descendant of the desktop root is slow enough to time out on a busy
    # machine, so only the top-level windows of this process (menus included) are searched.
    $byName = [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::NameProperty, $Name)
    $byProcess = [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $ProcessId)
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
            [System.Windows.Automation.TreeScope]::Children, $byProcess)
        foreach ($window in $windows) {
            $found = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $byName)
            if ($found) { return $found }
        }
        Start-Sleep -Milliseconds 250
    }
    throw "Native control not found: $Name"
}

if ($Action -eq 'state') {
    $script:Visible = 0
    [DesktopWindow]::EnumWindows({ param($window, $parameter)
            [uint32]$owner = 0
            [void][DesktopWindow]::GetWindowThreadProcessId($window, [ref]$owner)
            if ($owner -eq $ProcessId -and [DesktopWindow]::IsWindowVisible($window)) { $script:Visible++ }
            return $true
        }, [IntPtr]::Zero) | Out-Null
    @{ visible = $script:Visible; running = [bool](Get-Process -Id $ProcessId -ErrorAction SilentlyContinue) } | ConvertTo-Json -Compress
} elseif ($Action -eq 'close') {
    if (-not (Get-Process -Id $ProcessId).CloseMainWindow()) { throw 'No visible application window.' }
} elseif ($Action -eq 'post-click') {
    # InvokePattern holds the WinForms provider while a modal menu handler runs. Post
    # native input to its verified HWND instead; never move or click the global pointer.
    $control = Find-Control
    $bounds = $control.Current.BoundingRectangle
    $window = $control
    while ($window -and $window.Current.NativeWindowHandle -eq 0) { $window = [System.Windows.Automation.TreeWalker]::RawViewWalker.GetParent($window) }
    if (-not $window -or $bounds.IsEmpty) { throw "No native window for $Name" }
    [DesktopWindow]::PostClick([IntPtr]$window.Current.NativeWindowHandle, $ProcessId, [int]($bounds.X + $bounds.Width / 2), [int]($bounds.Y + $bounds.Height / 2))
} else {
    (Find-Control).GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
}
