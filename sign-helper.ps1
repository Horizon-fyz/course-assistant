# sign-helper.ps1 —— 自签名代码签名公共逻辑（被 build-portable.ps1 / build-installer.ps1 点源加载）
#
# 免费方案：用 PowerShell 自带的 Set-AuthenticodeSignature 给 exe 签名，
# 不依赖 Windows SDK / signtool，也不需要购买任何证书。
#
# 原理：生成一张自签名「代码签名」证书并把公钥证书分发给使用者；
#       使用者把它装进「受信任的根证书颁发机构」后，Windows 即认定该发布者可信，
#       不再显示「未知发布者」/SmartScreen 强拦截。
#
# 注意：本文件必须保存为 UTF-8 with BOM，否则中文 Windows 上 PowerShell 5 会按 ANSI 解析导致语法错误。

function Read-ZhsSignConfig {
  param([string]$Path)
  $cfg = [pscustomobject]@{
    Mode         = 'self'
    Publisher    = 'CN=智慧树助手'
    Thumbprint   = ''
    TimestampUrl = ''
  }
  if (Test-Path $Path) {
    try { $raw = Get-Content $Path -Raw -Encoding UTF8 | ConvertFrom-Json }
    catch { throw "sign.config.json 解析失败：$_" }
    if ($raw.mode)         { $cfg.Mode         = ([string]$raw.mode).Trim().ToLower() }
    if ($raw.publisher)    { $cfg.Publisher    = [string]$raw.publisher }
    if ($raw.thumbprint)   { $cfg.Thumbprint   = ([string]$raw.thumbprint) -replace '[^0-9A-Fa-f]', '' }
    if ($raw.timestampUrl) { $cfg.TimestampUrl = [string]$raw.timestampUrl }
  }
  return $cfg
}

function Get-ZhsSigningCert {
  param([string]$Publisher, [string]$Thumbprint)
  # 指定了指纹：直接用 CurrentUser\My 里那张证书（例如以后换成正式证书）
  if ($Thumbprint) {
    $c = Get-ChildItem Cert:\CurrentUser\My |
         Where-Object { $_.Thumbprint -eq $Thumbprint } | Select-Object -First 1
    if (-not $c) { throw "在 CurrentUser\My 中找不到指纹为 $Thumbprint 的证书。" }
    return $c
  }
  # 复用已存在的同主体自签证书，避免每次构建都新建（指纹一变，使用者装过的信任就失效了）
  $existing = Get-ChildItem Cert:\CurrentUser\My |
              Where-Object { $_.Subject -eq $Publisher -and $_.HasPrivateKey -and $_.NotAfter -gt (Get-Date).AddDays(30) } |
              Sort-Object NotAfter -Descending | Select-Object -First 1
  if ($existing) { return $existing }
  # 首次构建：生成一张有效期 10 年的自签名代码签名证书（私钥留在本机 CurrentUser\My）
  return New-SelfSignedCertificate `
    -Type CodeSigningCert `
    -Subject $Publisher `
    -CertStoreLocation Cert:\CurrentUser\My `
    -KeyUsage DigitalSignature `
    -KeyAlgorithm RSA -KeyLength 3072 `
    -HashAlgorithm SHA256 `
    -NotAfter (Get-Date).AddYears(10)
}

function Install-ZhsRootTrust {
  param($Cert)
  # 把自签公钥证书装进「当前用户 → 受信任的根证书颁发机构」：本机即认定该发布者可信（无需管理员）
  $store = New-Object System.Security.Cryptography.X509Certificates.X509Store('Root', 'CurrentUser')
  $store.Open('ReadWrite')
  try {
    $has = $store.Certificates | Where-Object { $_.Thumbprint -eq $Cert.Thumbprint }
    if (-not $has) { $store.Add($Cert); return $true }
    return $false
  } finally { $store.Close() }
}

function Export-ZhsTrustCer {
  param($Cert, [string]$Path)
  # 导出公钥证书（.cer，DER 格式），供使用者双击/脚本安装到受信任根
  Export-Certificate -Cert $Cert -FilePath $Path -Type CERT | Out-Null
}

function Invoke-ZhsSignFile {
  param([string]$FilePath, $Cert, [string]$TimestampUrl)
  $sigArgs = @{ FilePath = $FilePath; Certificate = $Cert; HashAlgorithm = 'SHA256' }
  if ($TimestampUrl) { $sigArgs['TimestampServer'] = $TimestampUrl }
  Set-AuthenticodeSignature @sigArgs | Out-Null
  $check = Get-AuthenticodeSignature -FilePath $FilePath
  if (-not $check.SignerCertificate) { throw "签名失败：$FilePath" }
  return $check
}
