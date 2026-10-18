# build-all.ps1 —— 一键构建（智慧树助手）
#
# 依次执行：
#   1) build-portable.ps1   组装便携版并给主 exe 签名（自签证书首次运行会自动创建）
#   2) build-installer.ps1  编译安装包并签名
#
# 产物就是一个自包含的安装程序 exe（不再打包 zip）：
#   dist\智慧树助手-安装程序-<版本>.exe
# 直接把这一个 exe 发给别人即可：双击即装（含简短安装向导），
# 安装过程会自动信任发布者证书，装完即用，不需要任何附加文件。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File build-all.ps1
#   或直接双击同目录的「一键打包.cmd」

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$Root = $PSScriptRoot
$Dist = Join-Path $Root 'dist'
function Head($m) { Write-Host ("`n=== " + $m + " ===") -ForegroundColor Cyan }

Head '第 1/2 步：构建便携版（含签名）'
& (Join-Path $Root 'build-portable.ps1')

Head '第 2/2 步：编译安装包（含签名）'
& (Join-Path $Root 'build-installer.ps1')

Head '完成'
$setup = Get-ChildItem $Dist -Filter '*安装程序*.exe' -File |
         Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $setup) { throw '未找到安装包产物（dist\*安装程序*.exe）' }
Write-Host '  便携版：' -NoNewline; Write-Host (Join-Path $Dist '智慧树助手') -ForegroundColor Green
Write-Host '  安装包：' -NoNewline; Write-Host $setup.FullName -ForegroundColor Green
Write-Host ''
Write-Host '  直接把这一个 exe 发给别人即可：双击即装（含简短安装向导），'
Write-Host '  安装过程自动信任发布者证书，装完即用，无需任何附加文件。'
