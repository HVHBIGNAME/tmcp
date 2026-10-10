param([int]$ProcessId, [ValidateSet('state', 'invoke', 'click', 'close')][string]$Action, [string]$Name)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class DesktopWindow {
  public delegate bool Visitor(IntPtr window, IntPtr parameter);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Visitor visitor, IntPtr parameter);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] private static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] private static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  public static void Click(int x, int y, int restoreX, int restoreY) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(120);
    mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
    mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(120);
    SetCursorPos(restoreX, restoreY);
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
} elseif ($Action -eq 'click') {
    # Items that open a modal dialog block their click handler, so InvokePattern would never
    # return. They are clicked with the mouse instead, at the reported element position.
    $bounds = (Find-Control).Current.BoundingRectangle
    if ($bounds.IsEmpty) { throw "Native control has no clickable bounds: $Name" }
    $cursor = [System.Windows.Forms.Cursor]::Position
    [DesktopWindow]::Click([int]($bounds.X + $bounds.Width / 2), [int]($bounds.Y + $bounds.Height / 2), $cursor.X, $cursor.Y)
} else {
    (Find-Control).GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
}
