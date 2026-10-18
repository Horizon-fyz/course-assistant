# build-portable.ps1 —— 组装便携版「智慧树助手」（WinForms + WebView2 外壳）
#
# 产物：dist\智慧树助手\  （整个文件夹可拷走，双击「智慧树助手.exe」运行）
#
# 依赖（全部取自本机，不联网下载）：
#   · node.exe                —— 内置后端运行时
#   · WebView2 运行时          —— 系统已安装（Edge 自带）
#   · WebView2 SDK 三个 DLL    —— 从本机已有软件中提取（版本 1.0.3179.45）
#   · csc.exe                 —— .NET Framework 自带编译器
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File packaging\build-portable.ps1

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

# 脚本位于 packaging\，仓库根在上一级
$Root   = Split-Path -Parent $PSScriptRoot
$Dist   = Join-Path $Root 'dist'
$AppDir = Join-Path $Dist '智慧树助手'

# —— 外部依赖来源（本机既有文件）——
$NodeExe = Join-Path $env:ProgramFiles 'nodejs\node.exe'
$Csc     = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'

function Resolve-File($p) {
  if ($p -and (Test-Path -LiteralPath $p -PathType Leaf)) { return (Resolve-Path -LiteralPath $p).Path }
  return $null
}

# WebView2 SDK 三个 DLL 不写死某个软件的安装路径：按候选目录探测。
# 可显式指定：
#   ZHS_WV2_DIR    含 Microsoft.Web.WebView2.Core.dll / .WinForms.dll 的目录
#   ZHS_WV2_LOADER WebView2Loader.dll 的完整路径
$sdkDirs = @()
if ($env:ZHS_WV2_DIR) { $sdkDirs += $env:ZHS_WV2_DIR }
if ($env:ProgramFiles) { $sdkDirs += (Join-Path $env:ProgramFiles 'SakuraFrpLauncher') }
if (${env:ProgramFiles(x86)}) { $sdkDirs += (Join-Path ${env:ProgramFiles(x86)} 'SakuraFrpLauncher') }
if ($env:LOCALAPPDATA) { $sdkDirs += (Join-Path $env:LOCALAPPDATA 'SakuraFrpLauncher') }

# NuGet 缓存里的 WebView2 SDK（版本目录倒序，优先新版）
$nugetDirs = @()
$nugetRoot = Join-Path $env:USERPROFILE '.nuget\packages\microsoft.web.webview2'
if (Test-Path $nugetRoot) {
  foreach ($v in (Get-ChildItem $nugetRoot -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending)) {
    $nugetDirs += $v.FullName
    $sdkDirs += (Join-Path $v.FullName 'lib\net45')
  }
}

$Wv2Core = $null
$Wv2WinFrm = $null
foreach ($d in $sdkDirs) {
  $c = Resolve-File (Join-Path $d 'Microsoft.Web.WebView2.Core.dll')
  $w = Resolve-File (Join-Path $d 'Microsoft.Web.WebView2.WinForms.dll')
  if ($c -and $w) { $Wv2Core = $c; $Wv2WinFrm = $w; break }
}

$loaderCandidates = @()
if ($env:ZHS_WV2_LOADER) { $loaderCandidates += $env:ZHS_WV2_LOADER }
if ($Wv2Core) { $loaderCandidates += (Join-Path (Split-Path -Parent $Wv2Core) 'WebView2Loader.dll') }
if ($env:ProgramFiles) { $loaderCandidates += (Join-Path $env:ProgramFiles 'WSL\wslsettings\WebView2Loader.dll') }
foreach ($root in $nugetDirs) {
  $loaderCandidates += (Join-Path $root 'runtimes\win-x64\native\WebView2Loader.dll')
  $loaderCandidates += (Join-Path $root 'build\native\x64\WebView2Loader.dll')
}
$Wv2Loader = $null
foreach ($p in $loaderCandidates) { $r = Resolve-File $p; if ($r) { $Wv2Loader = $r; break } }

function Step($m) { Write-Host ("  " + $m) }
function Head($m) { Write-Host ("`n=== " + $m + " ===") -ForegroundColor Cyan }

Head '检查依赖'
$CfgTemplate = Join-Path $Root 'packaging\config.portable.json'
$missing = @()
foreach ($f in @($NodeExe, $Wv2Core, $Wv2WinFrm, $Wv2Loader, $Csc, $CfgTemplate)) {
  if (-not $f) { $missing += '（未探测到）'; continue }
  if (-not (Test-Path -LiteralPath $f)) { $missing += $f }
}
if ($missing.Count) {
  Write-Host "以下依赖缺失，无法打包：" -ForegroundColor Red
  $missing | ForEach-Object { Write-Host ("  " + $_) }
  if (-not $Wv2Core -or -not $Wv2WinFrm -or -not $Wv2Loader) {
    Write-Host '  WebView2 SDK DLL 未找到。可显式指定后重试：' -ForegroundColor Yellow
    Write-Host '    $env:ZHS_WV2_DIR    = "含 Microsoft.Web.WebView2.Core.dll / .WinForms.dll 的目录"' -ForegroundColor Yellow
    Write-Host '    $env:ZHS_WV2_LOADER = "WebView2Loader.dll 的完整路径"' -ForegroundColor Yellow
  }
  throw '缺少依赖'
}
Step "WebView2 Core : $Wv2Core"
Step "WebView2 Loader: $Wv2Loader"
Step "node.exe      : $([math]::Round((Get-Item $NodeExe).Length/1MB,1)) MB"
Step "WebView2 SDK  : $((Get-Item $Wv2Core).VersionInfo.FileVersion)"
Step "csc.exe       : $Csc"

Head '清理旧产物（保留用户配置与登录态）'
# 用户数据先挪到暂存目录（同盘 move，很快），构建完成后再挪回来
$Stage = Join-Path $Dist '_keep_portable'
$KeepItems = @('config.json', 'data', 'webview-data')

function Move-Keep($fromRoot, $toRoot) {
  foreach ($f in $KeepItems) {
    $s = Join-Path $fromRoot $f
    if (-not (Test-Path -LiteralPath $s)) { continue }
    Move-Item -LiteralPath $s -Destination (Join-Path $toRoot $f) -Force -ErrorAction Stop
  }
}

# 上次构建若中途失败，$Stage 里还留着用户数据——先原样搬回；
# 只要有一项搬不回去就中止构建并保留暂存，绝不能用 SilentlyContinue 吞掉错误后删目录。
if (Test-Path $Stage) {
  New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
  try { Move-Keep $Stage $AppDir }
  catch { throw ("上次构建残留的用户数据无法恢复，已原样保留在 $Stage：" + $_.Exception.Message) }
  Remove-Item -Recurse -Force $Stage -ErrorAction Stop
  Step '已恢复上次未完成构建残留的用户数据'
}
New-Item -ItemType Directory -Force -Path $Stage | Out-Null
$kept = @()
foreach ($f in $KeepItems) {
  $p = Join-Path $AppDir $f
  if (Test-Path -LiteralPath $p) {
    Move-Item -LiteralPath $p -Destination (Join-Path $Stage $f) -Force -ErrorAction Stop
    $kept += $f
    Step "暂存 $f"
  }
}
if (Test-Path $AppDir) { Remove-Item -Recurse -Force $AppDir -ErrorAction Stop }
New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
Step $AppDir

Head '复制运行时'
Copy-Item $NodeExe $AppDir -Force
New-Item -ItemType Directory -Force -Path (Join-Path $AppDir 'node') | Out-Null
Move-Item (Join-Path $AppDir 'node.exe') (Join-Path $AppDir 'node\node.exe') -Force
Copy-Item $Wv2Core, $Wv2WinFrm, $Wv2Loader $AppDir -Force
Step 'node\node.exe + WebView2 DLL'

Head '组装应用本体'
$App = Join-Path $AppDir 'app'
New-Item -ItemType Directory -Force -Path $App | Out-Null

# 1) 界面与后端入口
New-Item -ItemType Directory -Force -Path (Join-Path $App 'desktop') | Out-Null
Copy-Item (Join-Path $Root 'desktop\ui') -Destination (Join-Path $App 'desktop\ui') -Recurse -Force
Copy-Item (Join-Path $Root 'desktop\serve.mjs') -Destination $App -Force

# 2) 核心组件（解析 / AI / 后端；均为零依赖纯 JS）
$Md = Join-Path $App 'md-ai-answer'
New-Item -ItemType Directory -Force -Path $Md | Out-Null
foreach ($sub in 'src', 'server') {
  Copy-Item (Join-Path $Root "md-ai-answer\$sub") -Destination $Md -Recurse -Force
}

# 3) 应用清单
$pkgJson = @'
{
  "name": "zhs-assistant",
  "version": "1.0.0",
  "private": true,
  "type": "module"
}
'@
[System.IO.File]::WriteAllText((Join-Path $App 'package.json'), $pkgJson, [System.Text.UTF8Encoding]::new($false))
Step 'package.json'

Head '编译外壳'
& $Csc /nologo /target:winexe /platform:x64 /optimize+ /out:"$AppDir\智慧树助手.exe" `
  /r:System.dll /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll `
  /r:"$AppDir\Microsoft.Web.WebView2.Core.dll" /r:"$AppDir\Microsoft.Web.WebView2.WinForms.dll" `
  "$Root\desktop\host\Program.cs"
if ($LASTEXITCODE -ne 0) { throw "编译失败（csc 退出码 $LASTEXITCODE）" }
Step ("智慧树助手.exe : " + [math]::Round((Get-Item (Join-Path $AppDir '智慧树助手.exe')).Length/1KB) + " KB")

Head '代码签名（免费自签名方案：根治「未知发布者」/SmartScreen）'
# 配置读自同目录 sign.config.json（已加入 .gitignore，不会提交）。
# 默认 mode=self：自动生成/复用一张自签名代码签名证书，用 PowerShell 自带
# Set-AuthenticodeSignature 签名（无需 Windows SDK / signtool），并导出公钥证书
# 供使用者一键装进「受信任的根证书颁发机构」——装过之后 Windows 才认定发布者可信。
# 想关闭签名：把 sign.config.json 的 mode 改成 none。
. (Join-Path $PSScriptRoot 'sign-helper.ps1')
$signCfg    = Read-ZhsSignConfig -Path (Join-Path $PSScriptRoot 'sign.config.json')
$AppExePath = Join-Path $AppDir '智慧树助手.exe'
if ($signCfg.Mode -eq 'none') {
  Write-Host '  sign.config.json 的 mode = none，跳过签名。' -ForegroundColor Yellow
  Write-Host '  ! 未签名的 exe 在别人机器上会触发 SmartScreen「未识别的应用」。' -ForegroundColor Yellow
} else {
  $signCert = Get-ZhsSigningCert -Publisher $signCfg.Publisher -Thumbprint $signCfg.Thumbprint
  Step ("证书主体  : " + $signCert.Subject)
  Step ("证书指纹  : " + $signCert.Thumbprint)
  Step ("有效期至  : " + $signCert.NotAfter.ToString('yyyy-MM-dd'))
  if (Install-ZhsRootTrust -Cert $signCert) { Step '已把证书装入「当前用户 → 受信任的根证书颁发机构」（本机生效）' }
  $cerPath = Join-Path $AppDir '代码签名证书.cer'
  Export-ZhsTrustCer -Cert $signCert -Path $cerPath
  Step '已导出公钥证书：代码签名证书.cer'
  $sigResult = Invoke-ZhsSignFile -FilePath $AppExePath -Cert $signCert -TimestampUrl $signCfg.TimestampUrl
  Step ("智慧树助手.exe 已签名（状态 " + $sigResult.Status + "）")
}

Head '写入配置与说明'
if ($kept -contains 'config.json') {
  Move-Item (Join-Path $Stage 'config.json') (Join-Path $AppDir 'config.json') -Force
  Step 'config.json（沿用你已有的配置，未覆盖）'
} else {
  # 模板固定取仓库文件，保证不含任何密钥
  Copy-Item $CfgTemplate (Join-Path $AppDir 'config.json') -Force
  Step 'config.json（模板，已预置千问识别 + DeepSeek 思考配置）'
}
foreach ($f in 'data', 'webview-data') {
  if ($kept -contains $f) { Move-Item (Join-Path $Stage $f) (Join-Path $AppDir $f) -Force -ErrorAction Stop; Step "$f\（保留）" }
}
$leftover = @(Get-ChildItem -LiteralPath $Stage -Force -ErrorAction SilentlyContinue)
if ($leftover.Count) {
  throw ("暂存目录仍有用户数据未恢复（已保留，未删除）：$Stage —— " + ($leftover.Name -join '、'))
}
Remove-Item -Recurse -Force $Stage -ErrorAction Stop

$readme = @'
智慧树助手 · 便携版
====================

一、运行
  双击「智慧树助手.exe」。启动后会弹出一个置顶的小悬浮窗。

二、首次配置
  1. 主窗口工具栏点「设置」；
  2. 接口地址已预置通义千问（DashScope 兼容模式）
     https://dashscope.aliyuncs.com/compatible-mode/v1；
  3. API Key 需要自己填写（视觉默认 qwen3-vl-plus，思考默认 deepseek-reasoner）；
  4. 填完 Key 与需要的模型后点「保存配置」。
  （配置保存在本目录的 config.json，可直接用记事本改。）

三、做题（截屏识题，只给答案，人工点击）
  1. 用你自己的浏览器打开智慧树，进入作业 / 考试页面，让题目显示在屏幕上；
  2. 点主窗口「截屏识题」页的「开始识题」（或悬浮窗上的「开始识题」）；
  3. 软件会定时截屏 → 交给通义千问 qwen-vl 识别 → 在悬浮窗里显示题面与答案；
  4. 你照着答案人工点击作答即可，点「停止识题」结束。
     注意：软件**不做任何自动点击，也绝不会点「提交」**。
  5. 「截屏一次」只识别当前屏幕一帧，适合单题查看。

四、本地题库
  识别过的题目会自动收录进本地题库（data\bank.json），下次遇到相同题目
  直接给答案，不再调用 AI。可在主窗口「截屏识题」页或「设置」页查看数量、清空。

五、导出（可选）
  「本地题库」页支持导入本地 Markdown 题库离线批量作答，并导出答案汇总 / 结构化 JSON。

六、关于「未知发布者」与 SmartScreen
  本程序已用自签名证书做了数字签名（签名有效、内容未被篡改），但证书需要在你自己的
  电脑上「信任」一次，Windows 才会把发布者当成可信：
    1. 首次使用，双击本目录的「安装证书.cmd」——把「代码签名证书.cer」装进
       「当前用户 → 受信任的根证书颁发机构」。（无需管理员，只影响当前用户，不改系统全局）
    2. 之后右键「智慧树助手.exe」→ 属性 → 数字签名，应显示签名有效、发布者为「智慧树助手」，
       启动时也不再显示「未知发布者」。
  · 若仍被 SmartScreen 拦（文件带了「来自 Internet」标记，多见于浏览器 / 网盘直链下载）：
      双击「解除锁定.cmd」去掉全部文件的网络标记，或右键 exe → 属性 → 勾选「解除锁定」。
  · 分发给别人时：把「代码签名证书.cer」一并给对方，让他先双击「安装证书.cmd」再运行；
      优先用 U 盘 / 内网共享 / 微信传输，这些渠道通常不会给文件打「来自 Internet」标记。
  · 说明：这只是「来源未知」的信誉提示，不是杀毒报警；本程序不会自动点击、也不会提交答案。

七、目录说明
  config.json        你的 AI 配置（含密钥，勿外传）
  data\              运行数据（含 bank.json 本地题库）
  node\node.exe      内置运行时，请勿删除
  app\               界面与业务代码，请勿删除
  代码签名证书.cer    自签名公钥证书（分发给别人时一并带上）
  安装证书.cmd        首次运行前先双击它，信任发布者（见第六节）
  解除锁定.cmd        被 SmartScreen 拦时双击它去掉网络标记（见第六节）
  启动日志.txt        出问题时看这个

八、常见问题
  · 双击后没反应 → 看「启动日志.txt」有没有内容：
      没内容 = 进程被系统 / 杀软拦下了（见第六节）；
      有内容 = 把日志内容发给开发者。
  · 悬浮窗里一直没结果 → 确认题目已显示在屏幕上（不要被悬浮窗挡住），
      并到「设置」确认 apiKey 已填。
  · 提示「AI 未配置」→ 打开「设置」填 apiKey 后保存。

免责声明：答案由 AI 生成，仅供参考，请自行核对。
'@
Set-Content -Path (Join-Path $AppDir '使用说明.txt') -Value $readme -Encoding UTF8

# 调试启动器：纯 ASCII（用通配符定位 exe），批处理里不出现任何中文
$debugCmd = @'
@echo off
cd /d "%~dp0"
echo Starting...
for %%F in ("%~dp0*.exe") do "%%~fF"
echo.
echo ==== exited, code = %errorlevel% ====
echo If nothing above, check the startup log .txt in this folder.
pause
'@
[System.IO.File]::WriteAllText((Join-Path $AppDir '调试启动.cmd'), $debugCmd, [System.Text.Encoding]::ASCII)

# 解除锁定：去掉「来自 Internet」标记（MOTW），消除 SmartScreen 拦截
$unlockCmd = @'
@echo off
cd /d "%~dp0"
echo Removing the "downloaded from the Internet" mark ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -LiteralPath '%~dp0' -Recurse -File -ErrorAction SilentlyContinue | Unblock-File"
echo.
echo Done. Now you can run the app without the SmartScreen block.
echo If it is still blocked, right-click the .exe - Properties - Unblock, then OK.
echo.
pause
'@
[System.IO.File]::WriteAllText((Join-Path $AppDir '解除锁定.cmd'), $unlockCmd, [System.Text.Encoding]::ASCII)

# 安装证书：把自签公钥证书装进「当前用户 → 受信任的根证书颁发机构」（无需管理员）
# 使用者只需双击一次，之后 Windows 即认定发布者可信，不再显示「未知发布者」。
$trustCmd = @'
@echo off
cd /d "%~dp0"
echo Installing the code-signing certificate as a trusted root (current user) ...
for %%F in ("%~dp0*.cer") do (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Import-Certificate -FilePath '%%~fF' -CertStoreLocation Cert:\CurrentUser\Root | Out-Null"
)
echo.
echo Done. This publisher is now trusted on this machine.
echo Now you can run the app; it will not be flagged as an unknown publisher.
echo.
pause
'@
[System.IO.File]::WriteAllText((Join-Path $AppDir '安装证书.cmd'), $trustCmd, [System.Text.Encoding]::ASCII)
Step '使用说明.txt + 调试启动.cmd + 解除锁定.cmd + 安装证书.cmd'

Head '完成'
$size = (Get-ChildItem $AppDir -Recurse -File | Measure-Object -Property Length -Sum).Sum / 1MB
Write-Host ("  " + $AppDir) -ForegroundColor Green
Write-Host ("  体积: " + [math]::Round($size, 1) + " MB")
Write-Host ""
Write-Host "  双击运行：" -NoNewline
Write-Host (Join-Path $AppDir '智慧树助手.exe') -ForegroundColor Green
