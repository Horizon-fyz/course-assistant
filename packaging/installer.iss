; 智慧树助手 —— 安装包脚本（Inno Setup 6）
; 编译：ISCC.exe installer.iss
; 说明：软件本体是 dist\智慧树助手\ 下的可执行程序与资源。
;      本脚本只收集「软件本体」，明确排除开发期文件：
;      webview-data\（本机 WebView2 登录态与缓存）、data\（本机本地题库）、
;      启动日志.txt、调试启动.cmd、解除锁定.cmd（调试/工具脚本）。

#define AppName "智慧树助手"
#define AppVersion "1.0.0"
#define AppExe "智慧树助手.exe"
#define SrcDir "..\dist\智慧树助手"

[Setup]
AppId={{8F3C1D20-5A64-4E7B-9C31-7D0E2A6B4F11}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=智慧树助手
VersionInfoVersion={#AppVersion}
VersionInfoDescription={#AppName} 安装程序
DefaultDirName={localappdata}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
DisableDirPage=auto
OutputDir=..\dist
OutputBaseFilename={#AppName}-安装程序-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
; 软件把 config.json / data / webview-data 写在自身目录，因此必须按用户安装（免管理员、无需 UAC）
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
MinVersion=10.0
; 安装/升级时若软件正在运行，提示关闭后再装
AppMutex=ZHS_Assistant_SingleInstance_v1
CloseApplications=yes
RestartApplications=no
UninstallDisplayIcon={app}\{#AppExe}
UninstallDisplayName={#AppName}

; ── 代码签名 ────────────────────────────────────────────────────────────
; 签名不在这里做：安装包由 ISCC 编译出来后，再交给 build-installer.ps1 用
; PowerShell 自带的 Set-AuthenticodeSignature 签名（免费自签名方案，无需 signtool）。
; 直接用 ISCC 编译本脚本（不经过 build-installer.ps1）时，产物不签名。

[Languages]
Name: "chinese"; MessagesFile: "installer-lang\ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加任务:"; Flags: checkedonce

[Files]
Source: "{#SrcDir}\{#AppExe}"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SrcDir}\*.dll"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SrcDir}\使用说明.txt"; DestDir: "{app}"; Flags: ignoreversion
; 自签名公钥证书：安装时由 [Run] 自动信任（使用者无需手动操作）；脚本保留作备用
Source: "{#SrcDir}\代码签名证书.cer"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SrcDir}\安装证书.cmd"; DestDir: "{app}"; Flags: ignoreversion
; 配置含 API 密钥：固定用仓库里的空密钥模板；已存在则保留用户自己的，升级不覆盖
Source: "config.portable.json"; DestDir: "{app}"; DestName: "config.json"; Flags: onlyifdoesntexist uninsneveruninstall
Source: "{#SrcDir}\app\*"; DestDir: "{app}\app"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: "md-ai-answer\config.json,data\*,export\*"
Source: "{#SrcDir}\node\*"; DestDir: "{app}\node"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Run]
; 安装时静默把发布者证书装进「当前用户 → 受信任的根证书颁发机构」
; （免管理员、无需 UAC；装完后运行本软件不会再提示「未知发布者」）
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -Command ""Import-Certificate -FilePath '{app}\代码签名证书.cer' -CertStoreLocation Cert:\CurrentUser\Root | Out-Null"""; StatusMsg: "正在信任发布者证书（去除「未知发布者」提示）..."; Flags: runhidden
Filename: "{app}\{#AppExe}"; Description: "立即运行 {#AppName}"; Flags: nowait postinstall skipifsilent

[UninstallRun]
; 卸载时移除上面装入的发布者证书（按发布者名称匹配；静默执行，失败不阻断卸载）
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -Command ""Get-ChildItem Cert:\CurrentUser\Root | Where-Object {{ $_.Subject -like '*智慧树助手*' }} | Remove-Item -Force -ErrorAction SilentlyContinue"""; Flags: runhidden; RunOnceId: "DelPublisherRootCert"
