# build-all.ps1 —— 一键构建（智慧树助手）
#
# 依次执行：
#   1) build-portable.ps1   组装便携版并给主 exe 签名（自签证书首次运行会自动创建）
#   2) build-installer.ps1  编译安装包并签名
#
# 产物：
#   dist\智慧树助手\                          免安装目录（可直接运行）
#   dist\智慧树助手-便携版-<版本>.zip          便携版压缩包（不含密钥 / 登录态）
#   dist\智慧树助手-安装程序-<版本>.exe        安装包
#
# 分发时优先用安装包 exe：双击即装，安装过程自动信任发布者证书。
# 便携版 zip 适合解压即用；两者都不包含本机的 config.json / data / webview-data。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File packaging\build-all.ps1
#   或直接双击仓库根目录的「一键打包.cmd」

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
# 脚本位于 packaging\，仓库根在上一级
$Root = Split-Path -Parent $PSScriptRoot
$Dist = Join-Path $Root 'dist'
function Head($m) { Write-Host ("`n=== " + $m + " ===") -ForegroundColor Cyan }

Head '第 1/3 步：构建便携版（含签名）'
& (Join-Path $PSScriptRoot 'build-portable.ps1')

Head '第 2/3 步：打包便携版 zip（不含本机密钥与登录态）'
$AppDir = Join-Path $Dist '智慧树助手'
$issText = Get-Content (Join-Path $PSScriptRoot 'installer.iss') -Raw -Encoding UTF8
$Version = if ($issText -match '#define\s+AppVersion\s+"([^"]+)"') { $Matches[1] } else { '1.0.0' }
$Zip   = Join-Path $Dist "智慧树助手-便携版-$Version.zip"
$Stage = Join-Path $Dist '_zip_stage'
if (Test-Path $Stage) { Remove-Item $Stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path (Join-Path $Stage '智慧树助手') | Out-Null
# 只带程序本体：排除本机的配置（含密钥）、运行数据与 WebView2 登录态
Get-ChildItem -LiteralPath $AppDir -Force |
  Where-Object { @('config.json', 'data', 'webview-data') -notcontains $_.Name } |
  ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $Stage '智慧树助手') -Recurse -Force
  }
Copy-Item (Join-Path $PSScriptRoot 'config.portable.json') (Join-Path $Stage '智慧树助手\config.json') -Force
if (Test-Path $Zip) { Remove-Item $Zip -Force }
Compress-Archive -Path (Join-Path $Stage '智慧树助手') -DestinationPath $Zip -CompressionLevel Optimal
Remove-Item $Stage -Recurse -Force
Write-Host '  便携版 zip：' -NoNewline; Write-Host $Zip -ForegroundColor Green

Head '第 3/3 步：编译安装包（含签名）'
& (Join-Path $PSScriptRoot 'build-installer.ps1')

Head '完成'
$setup = Get-ChildItem $Dist -Filter '*安装程序*.exe' -File |
         Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $setup) { throw '未找到安装包产物（dist\*安装程序*.exe）' }
if (-not (Test-Path $Zip)) { throw "未找到便携版 zip：$Zip" }
Write-Host '  便携版：' -NoNewline; Write-Host $AppDir -ForegroundColor Green
Write-Host '  便携版 zip：' -NoNewline; Write-Host $Zip -ForegroundColor Green
Write-Host '  安装包：' -NoNewline; Write-Host $setup.FullName -ForegroundColor Green
Write-Host ''
Write-Host '  两个分发包都不含本机的 config.json、data\、webview-data\。'
Write-Host '  安装包双击即装；便携版 zip 解压后填自己的 API Key 即可用。'
