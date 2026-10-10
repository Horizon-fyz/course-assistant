Add-Type -Namespace W -Name U -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, System.IntPtr lParam);
public delegate bool EnumWindowsProc(System.IntPtr hWnd, System.IntPtr lParam);
[DllImport("user32.dll")] public static extern int GetWindowTextLength(System.IntPtr hWnd);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(System.IntPtr hWnd, System.Text.StringBuilder s, int n);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool IsZoomed(System.IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool GetWindowRect(System.IntPtr hWnd, out RECT r);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint pid);
public struct RECT { public int Left, Top, Right, Bottom; }
'@

$wins = New-Object System.Collections.ArrayList
$cb = [W.U+EnumWindowsProc]{
  param($h, $l)
  $len = [W.U]::GetWindowTextLength($h)
  if ($len -gt 0) {
    $sb = New-Object System.Text.StringBuilder ($len + 2)
    [W.U]::GetWindowText($h, $sb, $sb.Capacity) | Out-Null
    $title = $sb.ToString()
    $pid = 0
    [W.U]::GetWindowThreadProcessId($h, [ref]$pid) | Out-Null
    $r = New-Object W.U+RECT
    [W.U]::GetWindowRect($h, [ref]$r) | Out-Null
    $null = $wins.Add([PSCustomObject]@{
      PID       = $pid
      Title     = $title
      Visible   = [W.U]::IsWindowVisible($h)
      Minimized = [W.U]::IsIconic($h)
      Maximized = [W.U]::IsZoomed($h)
      Left      = $r.Left
      Top       = $r.Top
      Width     = $r.Right - $r.Left
      Height    = $r.Bottom - $r.Top
    })
  }
  return $true
}
[W.U]::EnumWindows($cb, [System.IntPtr]::Zero) | Out-Null

"=== 所有 Edge 窗口 ==="
$edgePids = (Get-CimInstance Win32_Process -Filter "Name='msedge.exe'").ProcessId
$wins | Where-Object { $edgePids -contains $_.PID } | Format-Table -AutoSize

"=== 屏幕分辨率 ==="
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
  "  $($_.DeviceName)  bounds=$($_.Bounds)  primary=$($_.Primary)"
}
