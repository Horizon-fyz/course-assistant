# build-automation.ps1 —— 组装「智慧树 · 一键全自动」可分发版本
#
# 产物：
#   dist\智慧树一键全自动\                       免安装目录（可直接运行）
#   dist\智慧树一键全自动-便携版-<版本>.zip       便携版压缩包
#   dist\智慧树一键全自动-安装程序-<版本>.exe     安装包（需要 Inno Setup 6）
#
# 设计：
#   · 自带 node.exe（runtime\node.exe），对方电脑不需要安装 Node.js
#   · 只带 playwright / playwright-core，不下载浏览器；运行时自动检测「目标电脑」已装的浏览器
#   · 附带题库（export\...answers.json），不包含任何个人登录态、作业数据、API Key
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File packaging\build-automation.ps1

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

# 脚本位于 packaging\，仓库根在上一级
$Root   = Split-Path -Parent $PSScriptRoot
$Dist   = Join-Path $Root 'dist'
$AppDir = Join-Path $Dist '智慧树一键全自动'
$App    = Join-Path $AppDir 'app'
$Version = '1.0.0'

function Head($m) { Write-Host ("`n=== " + $m + " ===") -ForegroundColor Cyan }
function Step($m) { Write-Host ("  " + $m) }

Head '检查依赖'
$nodeCandidates = @()
if ($env:ProgramFiles) { $nodeCandidates += (Join-Path $env:ProgramFiles 'nodejs\node.exe') }
$cmd = Get-Command node.exe -ErrorAction SilentlyContinue
if ($cmd) { $nodeCandidates += $cmd.Source }
$NodeExe = $nodeCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $NodeExe) { throw '找不到 node.exe（请先安装 Node.js）' }

$Csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $Csc)) { throw "找不到 csc.exe：$Csc" }

$need = @(
  'start.mjs', 'zhs.mjs', 'package.json', 'src',
  'md-ai-answer\src',
  'node_modules\playwright', 'node_modules\playwright-core',
  'export\智慧树作业题库_打印版.answers.json',
  'recon\login-and-persist.mjs', 'recon\make-md.mjs', 'recon\make-pdf.mjs',
  'recon\validate-data.mjs', 'recon\verify-md.mjs',
  'tools\launcher.cs', 'tools\setup-ai.cs', 'desktop\native\CourseHelper.cs',
  'packaging\使用说明.txt', 'packaging\config.automation.json'
)
$missing = @($need | Where-Object { -not (Test-Path (Join-Path $Root $_)) })
if ($missing.Count) { throw ("缺少构建素材：" + ($missing -join '、')) }

Step ("node.exe : " + [math]::Round((Get-Item $NodeExe).Length / 1MB, 1) + " MB")
Step ("版本     : " + $Version)

Head '清理旧产物（保留用户配置与数据）'
# 用户配置（含 API Key）与 export 下的运行数据先挪到暂存目录，
# 打包完成后再挪回来。任何一步失败都中止构建并保留暂存，绝不直接删除。
$Stage = Join-Path $Dist '_keep_automation'
$StageItems = @('app\md-ai-answer\config.json', 'app\export')

# 删掉搬空后残留的空目录（不删 $stopRoot 本身）
function Remove-EmptyDirs($dir, $stopRoot) {
  $stop = [System.IO.Path]::GetFullPath($stopRoot).TrimEnd('\')
  $cur = [System.IO.Path]::GetFullPath($dir)
  while ($cur -and ($cur.TrimEnd('\') -ne $stop) -and (Test-Path -LiteralPath $cur -PathType Container)) {
    if (@(Get-ChildItem -LiteralPath $cur -Force).Count -gt 0) { break }
    Remove-Item -LiteralPath $cur -Force -ErrorAction Stop
    $cur = [System.IO.Path]::GetDirectoryName($cur)
  }
}

function Move-Staged($fromRoot, $toRoot) {
  foreach ($rel in $StageItems) {
    $s = Join-Path $fromRoot $rel
    if (-not (Test-Path -LiteralPath $s)) { continue }
    $d = Join-Path $toRoot $rel
    New-Item -ItemType Directory -Force -Path ([System.IO.Path]::GetDirectoryName($d)) | Out-Null
    if (Test-Path -LiteralPath $s -PathType Container) {
      New-Item -ItemType Directory -Force -Path $d | Out-Null
      Get-ChildItem -LiteralPath $s -Force | ForEach-Object {
        Move-Item -LiteralPath $_.FullName -Destination $d -Force -ErrorAction Stop
      }
      Remove-Item -LiteralPath $s -Recurse -Force -ErrorAction Stop
    } else {
      Move-Item -LiteralPath $s -Destination $d -Force -ErrorAction Stop
    }
    Remove-EmptyDirs ([System.IO.Path]::GetDirectoryName($s)) $fromRoot
  }
}

# 上次构建若中途失败，先恢复暂存里的用户数据；恢复不了就中止，绝不删除
if (Test-Path $Stage) {
  New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
  try { Move-Staged $Stage $AppDir }
  catch { throw ("上次构建残留的用户数据无法恢复，已原样保留在 $Stage：" + $_.Exception.Message) }
  Remove-Item -Recurse -Force $Stage -ErrorAction Stop
  Step '已恢复上次未完成构建残留的用户数据'
}

if (Test-Path $AppDir) {
  New-Item -ItemType Directory -Force -Path $Stage | Out-Null
  try { Move-Staged $AppDir $Stage }
  catch { throw ("无法暂存现有用户数据，已中止构建（不会删除 $AppDir）：" + $_.Exception.Message) }
  Remove-Item -Recurse -Force $AppDir -ErrorAction Stop
}
New-Item -ItemType Directory -Force -Path (Join-Path $AppDir 'runtime'), $App | Out-Null
Step $AppDir

Head '复制运行时与程序本体'
Copy-Item $NodeExe (Join-Path $AppDir 'runtime\node.exe') -Force

foreach ($f in 'start.mjs', 'zhs.mjs', 'package.json') {
  Copy-Item (Join-Path $Root $f) $App -Force
}
Copy-Item (Join-Path $Root 'src') $App -Recurse -Force

New-Item -ItemType Directory -Force -Path (Join-Path $App 'md-ai-answer') | Out-Null
Copy-Item (Join-Path $Root 'md-ai-answer\src') (Join-Path $App 'md-ai-answer') -Recurse -Force

New-Item -ItemType Directory -Force -Path (Join-Path $App 'node_modules') | Out-Null
foreach ($m in 'playwright', 'playwright-core') {
  Copy-Item (Join-Path $Root "node_modules\$m") (Join-Path $App 'node_modules') -Recurse -Force
}

New-Item -ItemType Directory -Force -Path (Join-Path $App 'export') | Out-Null
Copy-Item (Join-Path $Root 'export\智慧树作业题库_打印版.answers.json') (Join-Path $App 'export') -Force

# recon 下的运行期脚本：登录固化、Markdown/PDF 生成、数据校验
New-Item -ItemType Directory -Force -Path (Join-Path $App 'recon') | Out-Null
foreach ($f in 'login-and-persist.mjs', 'make-md.mjs', 'make-pdf.mjs', 'validate-data.mjs', 'verify-md.mjs') {
  Copy-Item (Join-Path $Root "recon\$f") (Join-Path $App 'recon') -Force
}
Step 'start.mjs / zhs.mjs / src / recon / md-ai-answer / node_modules / 题库'

# AI 配置模板：始终取仓库模板（apiKey 为空），不读取任何本机已填写的配置，
# 避免把开发者的密钥打进 zip / 安装包。
Copy-Item (Join-Path $Root 'packaging\config.automation.json') (Join-Path $App 'md-ai-answer\config.json') -Force
Step 'md-ai-answer\config.json（模板，apiKey 留空）'

Copy-Item (Join-Path $Root 'packaging\使用说明.txt') $AppDir -Force
Step '使用说明.txt'

Head '编译启动器、图形界面与设置工具'
& $Csc /nologo /codepage:65001 /target:exe /platform:anycpu /optimize+ /out:"$AppDir\一键开始.exe" (Join-Path $Root 'tools\launcher.cs')
if ($LASTEXITCODE -ne 0) { throw "编译失败（csc 退出码 $LASTEXITCODE）" }
Step ("一键开始.exe : " + [math]::Round((Get-Item (Join-Path $AppDir '一键开始.exe')).Length / 1KB) + " KB")

& $Csc /nologo /codepage:65001 /target:winexe /platform:anycpu /optimize+ /r:System.dll /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll /out:"$AppDir\设置AI密钥.exe" (Join-Path $Root 'tools\setup-ai.cs')
if ($LASTEXITCODE -ne 0) { throw "编译失败（csc 退出码 $LASTEXITCODE）" }
Step ("设置AI密钥.exe : " + [math]::Round((Get-Item (Join-Path $AppDir '设置AI密钥.exe')).Length / 1KB) + " KB")

& $Csc /nologo /codepage:65001 /target:winexe /platform:anycpu /optimize+ /r:System.dll /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll /out:"$AppDir\智慧树课程助手.exe" (Join-Path $Root 'desktop\native\CourseHelper.cs')
if ($LASTEXITCODE -ne 0) { throw "编译失败（csc 退出码 $LASTEXITCODE）" }
Step ("智慧树课程助手.exe : " + [math]::Round((Get-Item (Join-Path $AppDir '智慧树课程助手.exe')).Length / 1KB) + " KB")

Head '打包便携版 zip'
$Zip = Join-Path $Dist "智慧树一键全自动-便携版-$Version.zip"
if (Test-Path $Zip) { Remove-Item $Zip -Force }
Compress-Archive -Path $AppDir -DestinationPath $Zip -CompressionLevel Optimal
Step ("$Zip : " + [math]::Round((Get-Item $Zip).Length / 1MB, 1) + " MB")

Head '编译安装包'
$isccCandidates = @()
if (${env:ProgramFiles(x86)}) { $isccCandidates += (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe') }
if ($env:ProgramFiles) { $isccCandidates += (Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe') }
$Iscc = $isccCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

if (-not $Iscc) {
  Write-Host '  ! 未找到 Inno Setup 6，跳过安装包（便携版已生成）' -ForegroundColor Yellow
} else {
  & $Iscc "/DMyAppVersion=$Version" (Join-Path $PSScriptRoot 'installer-automation.iss')
  if ($LASTEXITCODE -ne 0) { throw "ISCC 失败（退出码 $LASTEXITCODE）" }
  $Setup = Join-Path $Dist "智慧树一键全自动-安装程序-$Version.exe"
  if (-not (Test-Path $Setup)) { throw "没有生成安装包：$Setup" }
  Step ("$Setup : " + [math]::Round((Get-Item $Setup).Length / 1MB, 1) + " MB")
}

Head '恢复用户配置与数据'
# zip / 安装包都在上面按「干净模板」生成完毕，这里才把本机用户数据挪回目录，
# 既不会把密钥打进分发包，也不会让下次构建丢配置。
if (Test-Path $Stage) {
  try {
    Move-Staged $Stage $AppDir
    # 题库模板始终用仓库里的最新版覆盖，其余用户数据保持原样
    Copy-Item (Join-Path $Root 'export\智慧树作业题库_打印版.answers.json') (Join-Path $App 'export') -Force
    $leftover = @(Get-ChildItem -LiteralPath $Stage -Force -ErrorAction SilentlyContinue)
    if ($leftover.Count) { throw ("暂存目录仍有未恢复项：" + ($leftover.Name -join '、')) }
    Remove-Item -Recurse -Force $Stage -ErrorAction Stop
    Step '已恢复 config.json 与 export 用户数据'
  } catch {
    throw ("用户数据未完全恢复，已原样保留在 $Stage，请手动处理：" + $_.Exception.Message)
  }
}

Head '完成'
Write-Host ("  目录：" + $AppDir)
Write-Host ("  便携版：" + $Zip)
if (Test-Path (Join-Path $Dist "智慧树一键全自动-安装程序-$Version.exe")) {
  Write-Host ("  安装包：" + (Join-Path $Dist "智慧树一键全自动-安装程序-$Version.exe"))
}
