# pad.ps1 —— 「对答案」置顶悬浮窗（PowerShell + WinForms，零额外依赖）
#
# 定位：常驻置顶的小窗。点「识别并作答」（或按 Alt+Q）截取当前屏幕 → 交给 AI 找出
#       正在作答的题目并给出答案，供你自己核对。
#
# 边界：只读屏幕，**不点击、不填写、不提交**任何页面元素。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File pad.ps1
#   node zhs.mjs pad
#   powershell ... -File pad.ps1 -Test "C:\path\shot.png"     # 不开窗口，直接识别一张图（自检用）
#
# 为什么不用 Electron：本机 Electron 42 在受限环境里以 0xC0000005 启动即崩（Chromium 子进程被拒），
# 而 WinForms 走 .NET/GDI，实测可正常创建置顶窗口与截屏。

param(
  [string]$Config = '',
  [string]$Test = '',        # 传入 PNG 路径：只做一次识别并打印结果（不开窗口）
  [switch]$NoHotkey          # 跳过全局快捷键注册
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

$SYSTEM = @'
你是一个题目识别与作答助手。你会收到一张屏幕截图或一段页面文本，其中可能包含一道或多道正在显示的题目。
要求：
1. 找出「当前正在作答的那一道题」（若有多道，取最靠上、最完整的一道）。
2. 严格只输出一个 JSON 对象，不要任何解释文字。
3. JSON 结构：
   {"found":true,"type":"单选题|多选题|判断题|填空题|简答题","stem":"题干原文","options":[{"key":"A","text":"选项原文"}],"answer":"答案","reason":"简要解析(<=60字)","confidence":0.0-1.0,"note":""}
4. 作答规则：
   - 单选题：answer 为单个字母，如 "A"
   - 多选题：answer 为字母升序拼接，如 "ABD"，不要分隔符
   - 判断题：answer 取 "A"（正确）或 "B"（错误）
   - 填空题：answer 为按空位顺序用 "；" 分隔的文本
   - 简答题：answer 为要点式参考答案
5. 图中/文本中没有题目时，返回 {"found":false,"note":"未发现题目"}。
6. 题干与选项必须**原样抄录**，不要改写、不要翻译；抄不全就在 note 里说明。
'@

# ------------------------------------------------------------ 截屏 / 调用

function Get-ScreenBase64 {
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try {
    $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
  } finally { $g.Dispose() }
  $ms = New-Object System.IO.MemoryStream
  try {
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    return [Convert]::ToBase64String($ms.ToArray())
  } finally { $bmp.Dispose(); $ms.Dispose() }
}

function Read-PngBase64([string]$path) {
  return [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($path))
}

# 把模型回复里的 JSON 抠出来（容忍 ```json 包裹与前后夹带的说明）
function Convert-ReplyToObject([string]$raw) {
  $t = $raw.Trim()
  $i = $t.IndexOf('{')
  $j = $t.LastIndexOf('}')
  if ($i -ge 0 -and $j -gt $i) { $t = $t.Substring($i, $j - $i + 1) }
  return ($t | ConvertFrom-Json)
}

function Invoke-Ask {
  param(
    [string]$ImageBase64 = '',
    [string]$Text = ''
  )
  if (-not $ApiKey) { throw '未配置 AI：请在 md-ai-answer\config.json 填 apiKey，或设置环境变量 AI_API_KEY' }
  if (-not $BaseUrl) { throw '未配置 AI 接口地址（baseUrl / AI_BASE_URL）' }

  if ($Text) {
    $userContent = "以下是页面可见文本，请找出题目并作答：`n`n" + $Text
  } else {
    $userContent = @(
      @{ type = 'text'; text = '这是一张电脑屏幕截图，里面可能有正在作答的题目。请按系统要求找出题目并作答，只输出 JSON。' },
      @{ type = 'image_url'; image_url = @{ url = 'data:image/png;base64,' + $ImageBase64 } }
    )
  }

  $payload = @{
    model = $Model
    messages = @(
      @{ role = 'system'; content = $script:SYSTEM },
      @{ role = 'user'; content = $userContent }
    )
  }
  $json = $payload | ConvertTo-Json -Depth 12 -Compress

  # 注意：不能用 Invoke-RestMethod —— PowerShell 5.1 在响应头没带 charset 时按 Latin-1
  # 解码 JSON，中文会全部乱码。这里用 HttpWebRequest 显式以 UTF-8 收发。
  $uri = $BaseUrl.TrimEnd('/') + '/chat/completions'
  $req = [System.Net.HttpWebRequest]::Create($uri)
  $req.Method = 'POST'
  $req.ContentType = 'application/json; charset=utf-8'
  $req.Accept = 'application/json'
  $req.Headers.Add('Authorization', 'Bearer ' + $ApiKey)
  $req.Timeout = 180000
  $req.ReadWriteTimeout = 180000

  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
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
    # 把接口返回的错误体也读出来，便于定位（密钥 / 余额 / 模型名）
    $er = $_.Exception.Response
    $detail = $_.Exception.Message
    if ($er) {
      try {
        $sr2 = New-Object System.IO.StreamReader($er.GetResponseStream(), [System.Text.Encoding]::UTF8)
        $detail = $sr2.ReadToEnd()
        $sr2.Close()
      } catch {}
    }
    throw ('AI 接口调用失败：' + $detail)
  }

  $obj = $respText | ConvertFrom-Json
  if ($obj.error) { throw ('AI 接口返回错误：' + ($obj.error | ConvertTo-Json -Compress -Depth 6)) }
  if (-not $obj.choices -or -not $obj.choices[0].message.content) { throw 'AI 接口没有返回内容' }
  return (Convert-ReplyToObject $obj.choices[0].message.content)
}

# 把结果对象整理成要显示的文本（返回 @{Text=..; Answer=..}）
function Format-Result($r) {
  if ($null -eq $r) { return @{ Text = '识别失败：模型没有返回可用内容。'; Answer = '' } }
  if ($r.found -eq $false -or (-not $r.stem -and -not $r.answer)) {
    $note = ''
    if ($r.note) { $note = $r.note }
    if (-not $note) { $note = '未在画面中发现题目。' }
    return @{ Text = $note; Answer = '' }
  }

  $sb = New-Object System.Text.StringBuilder
  $head = ''
  if ($r.type) { $head = '[' + $r.type + ']' }
  if ($r.confidence -ne $null) { $head = $head + '  置信度 ' + [string]$r.confidence }
  if ($head.Trim()) { [void]$sb.AppendLine($head) }
  if ($r.stem) { [void]$sb.AppendLine('题干：' + $r.stem) }
  foreach ($o in $r.options) {
    $k = ''
    if ($o.key) { $k = [string]$o.key + '. ' }
    [void]$sb.AppendLine('    ' + $k + $o.text)
  }
  if ($r.answer) { [void]$sb.AppendLine('') ; [void]$sb.AppendLine('答案：' + $r.answer) }
  if ($r.reason) { [void]$sb.AppendLine('解析：' + $r.reason) }
  if ($r.note) { [void]$sb.AppendLine('备注：' + $r.note) }
  return @{ Text = $sb.ToString().TrimEnd(); Answer = [string]$r.answer }
}

# ---------------------------------------------------------------- 自检模式

if ($Test) {
  $b64 = Read-PngBase64 $Test
  Write-Host ('图片: ' + $Test + '  (' + [math]::Round($b64.Length / 1024) + ' KB base64)')
  Write-Host ('模型: ' + $Model + ' @ ' + $BaseUrl)
  $r = Invoke-Ask -ImageBase64 $b64
  Write-Host '--- 模型返回 ---'
  Write-Host ($r | ConvertTo-Json -Depth 8)
  Write-Host '--- 展示文本 ---'
  Write-Host (Format-Result $r).Text
  exit 0
}

# ---------------------------------------------------------------- 界面

$fontUI = New-Object System.Drawing.Font 'Microsoft YaHei', 9
$fontBig = New-Object System.Drawing.Font 'Microsoft YaHei', 15, ([System.Drawing.FontStyle]::Bold)

$form = New-Object System.Windows.Forms.Form
$form.Text = '对答案 · 悬浮窗（只读，不代填）'
$form.Width = 470
$form.Height = 700
$form.TopMost = $true
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point 40, 40
$form.Font = $fontUI

# 工具条
$bar = New-Object System.Windows.Forms.FlowLayoutPanel
$bar.Dock = 'Top'
$bar.Height = 44
$bar.Padding = New-Object System.Windows.Forms.Padding 6

$btnGo = New-Object System.Windows.Forms.Button
$btnGo.Text = '识别并作答'
$btnGo.Width = 130
$btnGo.Height = 30
$btnGo.FlatStyle = 'System'

$btnShot = New-Object System.Windows.Forms.Button
$btnShot.Text = '重新截图'
$btnShot.Width = 88
$btnShot.Height = 30

$btnClear = New-Object System.Windows.Forms.Button
$btnClear.Text = '清空'
$btnClear.Width = 60
$btnClear.Height = 30

[void]$bar.Controls.Add($btnGo)
[void]$bar.Controls.Add($btnShot)
[void]$bar.Controls.Add($btnClear)

# 截图预览
$pic = New-Object System.Windows.Forms.PictureBox
$pic.Dock = 'Top'
$pic.Height = 180
$pic.SizeMode = 'Zoom'
$pic.BorderStyle = 'FixedSingle'
$pic.BackColor = [System.Drawing.Color]::FromArgb(36, 39, 44)

# 状态
$status = New-Object System.Windows.Forms.Label
$status.Dock = 'Bottom'
$status.Height = 22
$status.Text = '就绪'
$status.ForeColor = [System.Drawing.Color]::FromArgb(90, 96, 104)

# 结果
$rtb = New-Object System.Windows.Forms.RichTextBox
$rtb.Dock = 'Fill'
$rtb.ReadOnly = $true
$rtb.BackColor = [System.Drawing.Color]::FromArgb(24, 26, 30)
$rtb.ForeColor = [System.Drawing.Color]::FromArgb(232, 232, 234)
$rtb.Font = New-Object System.Drawing.Font 'Microsoft YaHei', 10
$rtb.Text = '尚未识别。点「识别并作答」截取当前屏幕。' + [Environment]::NewLine + [Environment]::NewLine +
            '提示：做题时把题目滚到屏幕中间，识别更准；答案仅供参考，请自行核对。'

$form.Controls.Add($rtb)
$form.Controls.Add($status)
$form.Controls.Add($pic)
$form.Controls.Add($bar)

# ---------------------------------------------------------------- 行为

$script:lastShotB64 = ''
$script:busy = $false

function Set-Status([string]$msg) {
  $status.Text = $msg
  [System.Windows.Forms.Application]::DoEvents()
}

function Do-Capture {
  Set-Status '正在截屏…'
  $script:lastShotB64 = Get-ScreenBase64
  $ms = New-Object System.IO.MemoryStream ([Convert]::FromBase64String($script:lastShotB64))
  $img = [System.Drawing.Image]::FromStream($ms)
  if ($pic.Image) { $pic.Image.Dispose() }
  $pic.Image = $img
  Set-Status ('已截取 ' + $img.Width + '×' + $img.Height + '，点「识别并作答」')
}

function Do-Recognize {
  if ($script:busy) { return }
  $script:busy = $true
  $btnGo.Enabled = $false
  try {
    if (-not $script:lastShotB64) { Do-Capture }
    Set-Status '正在识别并作答…'
    $r = Invoke-Ask -ImageBase64 $script:lastShotB64
    $f = Format-Result $r

    $rtb.Clear()
    if (-not $f.Answer) {
      $rtb.SelectionFont = New-Object System.Drawing.Font 'Microsoft YaHei', 10
      $rtb.AppendText($f.Text)
      Set-Status '完成：画面里没找到题目'
    } else {
      # 普通信息用小字，答案那一行用大字加粗
      $lines = $f.Text -split "`r?`n"
      foreach ($ln in $lines) {
        if ($ln.StartsWith('答案：')) {
          $rtb.SelectionFont = $fontBig
          $rtb.SelectionColor = [System.Drawing.Color]::FromArgb(50, 240, 140)
        } else {
          $rtb.SelectionFont = New-Object System.Drawing.Font 'Microsoft YaHei', 10
          $rtb.SelectionColor = [System.Drawing.Color]::FromArgb(232, 232, 234)
        }
        $rtb.AppendText($ln + [Environment]::NewLine)
      }
      $rtb.SelectionColor = $rtb.ForeColor
      Set-Status '完成（答案仅供参考，请自行核对）'
    }
  } catch {
    $rtb.Clear()
    $rtb.SelectionFont = New-Object System.Drawing.Font 'Microsoft YaHei', 10
    $rtb.SelectionColor = [System.Drawing.Color]::FromArgb(232, 70, 58)
    $rtb.AppendText('出错：' + $_.Exception.Message)
    $rtb.SelectionColor = $rtb.ForeColor
    Set-Status '失败：' + $_.Exception.Message
  } finally {
    $script:busy = $false
    $btnGo.Enabled = $true
  }
}

$btnGo.Add_Click({ Do-Recognize })
$btnShot.Add_Click({ if (-not $script:busy) { Do-Capture } })
$btnClear.Add_Click({
  $script:lastShotB64 = ''
  if ($pic.Image) { $pic.Image.Dispose(); $pic.Image = $null }
  $rtb.Clear()
  $rtb.SelectionFont = New-Object System.Drawing.Font 'Microsoft YaHei', 10
  $rtb.SelectionColor = $rtb.ForeColor
  $rtb.AppendText('已清空。')
  Set-Status '就绪'
})

# 全局快捷键 Alt+Q（窗口不在前台也能触发）
if (-not $NoHotkey) {
  try {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public class ZhsHotKey : NativeWindow {
  [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
  [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr hWnd, int id);
  public event EventHandler Pressed;
  public ZhsHotKey(IntPtr handle) { AssignHandle(handle); }
  protected override void WndProc(ref Message m) {
    if (m.Msg == 0x0312) { var h = Pressed; if (h != null) h(this, EventArgs.Empty); }
    base.WndProc(ref m);
  }
}
'@
    [void]$form.Handle
    $hotkey = New-Object ZhsHotKey($form.Handle)
    $hotkey.add_Pressed({ Do-Recognize })
    $okReg = [ZhsHotKey]::RegisterHotKey($form.Handle, 1, 1, 0x51)   # MOD_ALT | VK_Q
    if (-not $okReg) { Set-Status '提示：Alt+Q 被占用，请直接点按钮' }
  } catch {
    # 注册失败不影响使用（窗口本来就是置顶的）
  }
}

Set-Status ('模型 ' + $Model + '　·　Alt+Q 或点按钮识别')
[System.Windows.Forms.Application]::Run($form)
