# build-installer.ps1 —— 用 Inno Setup 编译安装包，并用自签名证书对安装包签名
#
# 前置：
#   1) 先跑 build-portable.ps1，生成 dist\智慧树助手\（其中主 exe 已按需签名）；
#   2) sign.config.json 保持默认（mode=self）即可。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File build-installer.ps1
#
# 说明：不再依赖 signtool / Windows SDK。安装包先由 ISCC 正常编译出来，
#       再用 PowerShell 自带的 Set-AuthenticodeSignature 对其签名（逻辑见 sign-helper.ps1）。
#       关闭签名（sign.config.json 里 mode=none）时自动跳过，与原先一致。

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$Root = $PSScriptRoot
function Step($m) { Write-Host ("  " + $m) }
function Head($m) { Write-Host ("`n=== " + $m + " ===") -ForegroundColor Cyan }

# —— 定位 ISCC.exe ——
Head '定位 Inno Setup 编译器'
$Iscc = ''
$cmd = Get-Command ISCC.exe -ErrorAction SilentlyContinue
if ($cmd) { $Iscc = $cmd.Source }
if (-not $Iscc) {
  foreach ($r in @((Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6'), (Join-Path $env:ProgramFiles 'Inno Setup 6'))) {
    $p = Join-Path $r 'ISCC.exe'
    if (Test-Path $p) { $Iscc = $p; break }
  }
}
if (-not $Iscc) { throw '找不到 ISCC.exe，请先安装 Inno Setup 6' }
Step $Iscc

# —— 读取签名配置（证书生成/信任/导出逻辑见 sign-helper.ps1）——
. (Join-Path $Root 'sign-helper.ps1')
$signCfg = Read-ZhsSignConfig -Path (Join-Path $Root 'sign.config.json')

# —— 编译 ——
Head '编译安装包'
Step ($Iscc + ' ' + (Join-Path $Root 'installer.iss'))
& $Iscc (Join-Path $Root 'installer.iss')
if ($LASTEXITCODE -ne 0) { throw "ISCC 编译失败（退出码 $LASTEXITCODE）" }

# —— 对安装包签名 ——
Head '代码签名（免费自签名方案）'
$setupExe = Get-ChildItem (Join-Path $Root 'dist') -Filter '*安装程序*.exe' -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $setupExe) { throw '未找到编译产物（dist\*安装程序*.exe）' }
if ($signCfg.Mode -eq 'none') {
  Write-Host '  sign.config.json 的 mode = none，安装包不签名。' -ForegroundColor Yellow
  Write-Host '  ! 未签名的安装包会触发 SmartScreen「未识别的应用」。' -ForegroundColor Yellow
} else {
  $signCert = Get-ZhsSigningCert -Publisher $signCfg.Publisher -Thumbprint $signCfg.Thumbprint
  Step ("证书指纹  : " + $signCert.Thumbprint)
  if (Install-ZhsRootTrust -Cert $signCert) { Step '已把证书装入「当前用户 → 受信任的根证书颁发机构」' }
  $res = Invoke-ZhsSignFile -FilePath $setupExe.FullName -Cert $signCert -TimestampUrl $signCfg.TimestampUrl
  Step ("已签名    : " + $setupExe.Name + "（状态 " + $res.Status + "）")
}

Head '完成'
Write-Host '  产物：' -NoNewline
Write-Host $setupExe.FullName -ForegroundColor Green
