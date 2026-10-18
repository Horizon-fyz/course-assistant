# 启动智慧树自动化浏览器
#
# 用法：
#   .\start-browser.ps1                      # 自动检测本机已装的浏览器（CDP 接管，已验证可过易盾验证码）
#   .\start-browser.ps1 -Browser firefox     # Firefox（Playwright 自带构建）
#
# 为什么要这样启动：
#   Playwright 自己 launch 的 Chromium 会带 navigator.webdriver=true 等特征，
#   网易易盾验证码会拒绝渲染，登录会卡住。
#   改用「系统原版浏览器 + 远程调试端口」，再由 Playwright 通过 CDP 接管，
#   则 navigator.webdriver=false，验证码可正常通过。
#
#   注意：系统版 Firefox 用的是 WebDriver BiDi 协议（只暴露 /session WebSocket），
#   无法被 CDP 接管。所以 Firefox 分支走 Playwright 自带构建，用独立 profile。
#
# 两条路径的会话都持久保存在各自 profile 目录，登录一次长期有效。

param(
  [ValidateSet('edge', 'chrome', 'firefox', 'auto')]
  [string]$Browser = 'auto'
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

# ---------- Firefox 分支 ----------
if ($Browser -eq 'firefox') {
  Write-Host '启动 Firefox（Playwright 自带构建）...'
  $env:PLAYWRIGHT_BROWSERS_PATH = "$root\ms-playwright"
  node "$root\src\tools\launch-firefox.mjs"
  exit $LASTEXITCODE
}

# ---------- Chromium 系分支 ----------
# 浏览器列表交给 Node 侧同一套探测逻辑（常见路径 / 注册表 / PATH / Playwright 自带），
# 保证「这台电脑装了什么就用什么」，不在脚本里预设品牌。
Push-Location $root
try {
  $listJson = node --input-type=module -e "import { discoverChromium } from './src/core/browser.mjs'; process.stdout.write(JSON.stringify(discoverChromium()))"
  if ($LASTEXITCODE -ne 0) { throw '浏览器探测失败（node_modules\playwright 是否已安装？）' }
  $list = @($listJson | ConvertFrom-Json)
} finally { Pop-Location }

$pool = @(if ($Browser -eq 'auto') { $list } else { $list | Where-Object { $_.name -eq $Browser } })
if (-not $pool.Count) {
  throw ("这台电脑上没有检测到可用的 Chromium 系浏览器（当前筛选：$Browser）。装一个即可，或用 -Browser firefox。")
}

$ports = @($list | ForEach-Object { $_.port }) + 9222 + 9223 | Select-Object -Unique

function Find-CdpPort {
  foreach ($port in $ports) {
    try {
      $v = Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/version" -TimeoutSec 3
      return @{ Port = $port; Version = $v.Browser }
    } catch { }
  }
  return $null
}

$live = Find-CdpPort
if ($live) {
  Write-Host "调试端口已就绪: $($live.Version) (端口 $($live.Port))"
  Write-Host '接下来: node src\flows\session.mjs'
  exit 0
}

$picked = @{ Name = $pool[0].name; Port = $pool[0].port; Exe = $pool[0].exePath }

$profile = "$root\browser-profile-$($picked.Name)"
New-Item -ItemType Directory -Force -Path $profile | Out-Null

Write-Host "启动 $($picked.Name)（远程调试端口 $($picked.Port)）..."
Start-Process -FilePath $picked.Exe -ArgumentList @(
  "--remote-debugging-port=$($picked.Port)",
  "--user-data-dir=$profile",
  '--no-first-run',
  '--no-default-browser-check',
  '--window-size=1500,900',
  '--window-position=0,0',
  'https://onlineweb.zhihuishu.com/onlinestuh5'
)

for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 1000
  $v = $null
  try { $v = Invoke-RestMethod -Uri "http://127.0.0.1:$($picked.Port)/json/version" -TimeoutSec 3 } catch { }
  if ($v) {
    Write-Host "调试端口已就绪: $($v.Browser)"
    Write-Host ''
    Write-Host '接下来：'
    Write-Host '  1) 在浏览器窗口确认已登录（需要时用「学号登录」，选学校后填学号密码）'
    Write-Host '  2) node src\flows\session.mjs          验证会话'
    Write-Host '  3) node src\tools\resolve-courses.mjs  自动发现并解析课程'
    Write-Host '  4) node src\tools\focus.mjs            窗口被挡住时置前'
    exit 0
  }
}

throw '调试端口启动超时'
