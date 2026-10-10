# pad-controller.ps1 —— 「接管模式」悬浮窗（PowerShell + WinForms）
#
# 与 pad.ps1 的区别：
#   · pad.ps1：纯只读，截屏识别给答案；
#   · 本脚本：接管模式，列出待完成作业，用户手动打开后模拟人类点击回填。
#
# 边界：只点「保存 / 下一题」，绝不点「提交作业 / 暂存作业」。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File pad-controller.ps1
#   powershell ... -File pad-controller.ps1 -DryRun    # 只高亮预选，不点击

param(
  [switch]$DryRun,           # 干跑模式：只高亮，不点击
  [string]$Config = '',      # 配置文件路径（默认读取 md-ai-answer/config.json）
  [string]$Delay = '600'     # 操作间隔(ms)，模拟人类节奏
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

Add-Type -AssemblyName System.Windows.Forms, System.Drawing

# ---------------------------------------------------------------- 配置

$PadDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PkgDir = Split-Path -Parent $PadDir
if (-not $Config) { $Config = Join-Path $PkgDir 'config.json' }

$cfg = $null
if (Test-Path $Config) {
  try { $cfg = Get-Content -Raw -Encoding UTF8 $Config | ConvertFrom-Json } catch { $cfg = $null }
}
$BaseUrl = ''
$ApiKey = ''
$Model = 'deepseek-chat'
if ($cfg) {
  if ($cfg.baseUrl) { $BaseUrl = $cfg.baseUrl }
  if ($cfg.apiKey) { $ApiKey = $cfg.apiKey }
  if ($cfg.model) { $Model = $cfg.model }
}
if ($env:AI_BASE_URL) { $BaseUrl = $env:AI_BASE_URL }
if ($env:AI_API_KEY) { $ApiKey = $env:AI_API_KEY }
if ($env:AI_MODEL) { $Model = $env:AI_MODEL }

# 工作区根（papers.json / courses-resolved.json 所在）
$RootDir = Split-Path -Parent $PkgDir
$ExportDir = Join-Path $RootDir 'export'

# ---------------------------------------------------------------- 数据

function Get-PendingHomework {
  $papersPath = Join-Path $ExportDir 'papers.json'
  if (-not (Test-Path $papersPath)) { return @() }

  $papers = Get-Content -Raw -Encoding UTF8 $papersPath | ConvertFrom-Json
  $resolvedPath = Join-Path $ExportDir 'courses-resolved.json'
  $resolved = @{}
  if (Test-Path $resolvedPath) {
    $resolved = Get-Content -Raw -Encoding UTF8 $resolvedPath | ConvertFrom-Json
  }

  $out = @()
  foreach ($course in $papers.PSObject.Properties) {
    $courseName = $course.Name
    $recruitId = $resolved.$courseName.recruitId
    foreach ($item in $course.Value) {
      if ($item.state -ne 1 -or $item.score -ne $null) { continue }
      $url = "https://onlineexamh5new.zhihuishu.com/stuExamWeb.html#/webExamList/dohomework/$recruitId/$($item.id)/$($item.examId)/$($item.courseId)/5371/$($item.meetCourseType)"
      $out += [PSCustomObject]@{
        Course = $courseName
        Exam   = $item.examName
        Count  = $item.problemNum
        Url    = $url
      }
    }
  }
  return $out
}

# ---------------------------------------------------------------- AI 调用

$SYSTEM_ASK = @'
你是答题助手。严格只输出 JSON：{"answer":"答案字母","reason":"简要解析"}。
单选填一个字母，多选填字母升序（如"ABD"），判断填"A"（正确）或"B"（错误）。
'@

function Invoke-Ask([string]$prompt) {
  if (-not $ApiKey) { throw '未配置 AI' }
  if (-not $BaseUrl) { throw '未配置 AI 接口地址' }

  $payload = @{
    model = $Model
    messages = @(
      @{ role = 'system'; content = $SYSTEM_ASK },
      @{ role = 'user'; content = $prompt }
    )
    temperature = 0.2
  } | ConvertTo-Json -Depth 10 -Compress

  $uri = $BaseUrl.TrimEnd('/') + '/chat/completions'
  $req = [System.Net.HttpWebRequest]::Create($uri)
  $req.Method = 'POST'
  $req.ContentType = 'application/json; charset=utf-8'
  $req.Accept = 'application/json'
  $req.Headers.Add('Authorization', 'Bearer ' + $ApiKey)
  $req.Timeout = 60000

  $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
  $req.ContentLength = $bytes.Length
  $rs = $req.GetRequestStream()
  try { $rs.Write($bytes, 0, $bytes.Length) } finally { $rs.Close() }

  $respText = ''
  try {
    $resp = $req.GetResponse()
    try {
      $sr = New-Object System.IO.StreamReader($resp.GetResponseStream(), [System.Text.Encoding]::UTF8)
      try { $respText = $sr.ReadToEnd() } finally { $sr.Close() }
    } finally { $resp.Close() }
  } catch [System.Net.WebException] {
    throw ('AI 调用失败：' + $_.Exception.Message)
  }

  $obj = $respText | ConvertFrom-Json
  $content = $obj.choices[0].message.content
  $match = [regex]::Match($content, '\{[\s\S]*\}')
  if (-not $match.Success) { throw 'AI 返回格式异常' }
  return ($match.Value | ConvertFrom-Json)
}

# ---------------------------------------------------------------- 界面

$fontUI = New-Object System.Drawing.Font 'Microsoft YaHei', 9

$form = New-Object System.Windows.Forms.Form
$form.Text = '智慧树接管 · 悬浮窗'
$form.Width = 480
$form.Height = 600
$form.TopMost = $true
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point 40, 40
$form.Font = $fontUI

# 列表
$list = New-Object System.Windows.Forms.ListBox
$list.Dock = 'Fill'
$list.Font = New-Object System.Drawing.Font 'Microsoft YaHei', 10
$list.DisplayMember = 'Display'

# 按钮条
$bar = New-Object System.Windows.Forms.FlowLayoutPanel
$bar.Dock = 'Bottom'
$bar.Height = 48
$bar.Padding = New-Object System.Windows.Forms.Padding 6

$btnRefresh = New-Object System.Windows.Forms.Button
$btnRefresh.Text = '刷新列表'
$btnRefresh.Width = 90
$btnRefresh.Height = 32

$btnOpen = New-Object System.Windows.Forms.Button
$btnOpen.Text = '打开选中作业'
$btnOpen.Width = 110
$btnOpen.Height = 32

$btnStart = New-Object System.Windows.Forms.Button
$btnStart.Text = '开始接管'
$btnStart.Width = 90
$btnStart.Height = 32
$btnStart.Enabled = $false

$btnStop = New-Object System.Windows.Forms.Button
$btnStop.Text = '停止'
$btnStop.Width = 60
$btnStop.Height = 32
$btnStop.Enabled = $false

[void]$bar.Controls.Add($btnRefresh)
[void]$bar.Controls.Add($btnOpen)
[void]$bar.Controls.Add($btnStart)
[void]$bar.Controls.Add($btnStop)

# 状态
$status = New-Object System.Windows.Forms.Label
$status.Dock = 'Bottom'
$status.Height = 24
$status.Text = '就绪'
$status.ForeColor = [System.Drawing.Color]::FromArgb(90, 96, 104)

$form.Controls.Add($list)
$form.Controls.Add($status)
$form.Controls.Add($bar)

# ---------------------------------------------------------------- 行为

$script:pending = @()
$script:selected = $null
$script:running = $false

function Set-Status([string]$msg) {
  $status.Text = $msg
  [System.Windows.Forms.Application]::DoEvents()
}

function Refresh-List {
  Set-Status '正在读取待完成作业…'
  $script:pending = Get-PendingHomework
  $list.Items.Clear()
  foreach ($p in $script:pending) {
    $display = "$($p.Course) / $($p.Exam)（$($p.Count) 题）"
    $list.Items.Add([PSCustomObject]@{ Display = $display; Data = $p }) | Out-Null
  }
  Set-Status ("共 " + $script:pending.Count + " 份待完成。选中后点「打开选中作业」。")
}

$btnRefresh.Add_Click({ Refresh-List })

$list.Add_SelectedIndexChanged({
  if ($list.SelectedItem) {
    $script:selected = $list.SelectedItem.Data
    $btnStart.Enabled = $true
  }
})

$btnOpen.Add_Click({
  if (-not $script:selected) { return }
  Start-Process $script:selected.Url
  Set-Status '已在浏览器打开，请在页面加载完成后点「开始接管」'
  $btnStart.Enabled = $true
})

$btnStart.Add_Click({
  if ($script:running) { return }
  $script:running = $true
  $btnStart.Enabled = $false
  $btnStop.Enabled = $true
  $btnRefresh.Enabled = $false

  try {
    Set-Status '接管中…（请在浏览器里保持页面在前台）'
    # 注意：这里只是演示结构，实际需要 CDP/Playwright 连接浏览器
    # 当前版本：提示用户手动操作，悬浮窗只负责列清单和给答案
    [System.Windows.Forms.MessageBox]::Show(
      "接管模式需要浏览器调试端口已开启。`n`n" +
      "请确保 Edge 已用 --remote-debugging-port=9222 启动，`n" +
      "然后运行：node src\apply-homework.mjs --apply`n`n" +
      "悬浮窗仅用于列出作业与显示答案。",
      "提示", 'OK', 'Information')
    Set-Status '请运行 node src\apply-homework.mjs --apply'
  } finally {
    $script:running = $false
    $btnStart.Enabled = $true
    $btnStop.Enabled = $false
    $btnRefresh.Enabled = $true
  }
})

$btnStop.Add_Click({
  $script:running = $false
  Set-Status '已停止'
  $btnStart.Enabled = $true
  $btnStop.Enabled = $false
  $btnRefresh.Enabled = $true
})

# 初始化
Refresh-List
Set-Status ('模型 ' + $Model + '　·　选中作业后打开并接管')
[System.Windows.Forms.Application]::Run($form)
