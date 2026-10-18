# build-automation.ps1 —— 组装「智慧树 · 一键全自动」可分发版本
#
# 产物：
#   dist\智慧树一键全自动\                       免安装目录（可直接运行）
#   dist\智慧树一键全自动-便携版-<版本>.zip       便携版压缩包
#   dist\智慧树一键全自动-安装程序-<版本>.exe     安装包（需要 Inno Setup 6）
#
# 设计：
#   · 自带 node.exe（runtime\node.exe），对方电脑不需要安装 Node.js
#   · 只带 playwright / playwright-core，浏览器用系统自带 Edge，不下载浏览器
#   · 附带题库（export\...answers.json），不包含任何个人登录态、作业数据、API Key
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File build-automation.ps1

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$Root   = $PSScriptRoot
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
  'tools\launcher.cs', 'tools\setup-ai.cs',
  'packaging\使用说明.txt'
)
$missing = @($need | Where-Object { -not (Test-Path (Join-Path $Root $_)) })
if ($missing.Count) { throw ("缺少构建素材：" + ($missing -join '、')) }

Step ("node.exe : " + [math]::Round((Get-Item $NodeExe).Length / 1MB, 1) + " MB")
Step ("版本     : " + $Version)

Head '清理旧产物'
if (Test-Path $AppDir) { Remove-Item -Recurse -Force $AppDir }
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
Step 'start.mjs / zhs.mjs / src / md-ai-answer / node_modules / 题库'

# AI 配置模板：不含任何密钥，用户可用「设置AI密钥.exe」填写
$cfg = @'
{
  "reasonBaseUrl": "https://api.deepseek.com/v1",
  "reasonApiKey": "",
  "reasonModel": "deepseek-chat",
  "temperature": 0.2,
  "timeoutMs": 60000,
  "maxRetries": 3
}
'@
[System.IO.File]::WriteAllText(
  (Join-Path $App 'md-ai-answer\config.json'),
  $cfg,
  (New-Object System.Text.UTF8Encoding($false))
)
Step 'md-ai-answer\config.json（apiKey 留空）'

Copy-Item (Join-Path $Root 'packaging\使用说明.txt') $AppDir -Force
Step '使用说明.txt'

Head '编译启动器与设置工具'
& $Csc /nologo /codepage:65001 /target:exe /platform:anycpu /optimize+ /out:"$AppDir\一键开始.exe" (Join-Path $Root 'tools\launcher.cs')
if ($LASTEXITCODE -ne 0) { throw "编译失败（csc 退出码 $LASTEXITCODE）" }
Step ("一键开始.exe : " + [math]::Round((Get-Item (Join-Path $AppDir '一键开始.exe')).Length / 1KB) + " KB")

& $Csc /nologo /codepage:65001 /target:winexe /platform:anycpu /optimize+ /r:System.dll /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll /out:"$AppDir\设置AI密钥.exe" (Join-Path $Root 'tools\setup-ai.cs')
if ($LASTEXITCODE -ne 0) { throw "编译失败（csc 退出码 $LASTEXITCODE）" }
Step ("设置AI密钥.exe : " + [math]::Round((Get-Item (Join-Path $AppDir '设置AI密钥.exe')).Length / 1KB) + " KB")

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
  & $Iscc "/DMyAppVersion=$Version" (Join-Path $Root 'installer-automation.iss')
  if ($LASTEXITCODE -ne 0) { throw "ISCC 失败（退出码 $LASTEXITCODE）" }
  $Setup = Join-Path $Dist "智慧树一键全自动-安装程序-$Version.exe"
  if (-not (Test-Path $Setup)) { throw "没有生成安装包：$Setup" }
  Step ("$Setup : " + [math]::Round((Get-Item $Setup).Length / 1MB, 1) + " MB")
}

Head '完成'
Write-Host ("  目录：" + $AppDir)
Write-Host ("  便携版：" + $Zip)
if (Test-Path (Join-Path $Dist "智慧树一键全自动-安装程序-$Version.exe")) {
  Write-Host ("  安装包：" + (Join-Path $Dist "智慧树一键全自动-安装程序-$Version.exe"))
}
