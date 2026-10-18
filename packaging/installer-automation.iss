; 智慧树 · 一键全自动 —— 安装包脚本（Inno Setup 6）
; 编译：ISCC.exe /DMyAppVersion=1.0.0 installer-automation.iss
; 安装到当前用户目录，不需要管理员权限。
;
; 分发内容只包含「程序本体 + 题库」，明确排除：
;   browser-profile-edge\（本机登录态）、recon\（运行报告）、
;   个人抓取的 export\papers.json / courses-resolved.json、ms-playwright\。

#define MyAppName "智慧树一键全自动"
#ifndef MyAppVersion
  #define MyAppVersion "1.0.0"
#endif
#define MyAppExe "一键开始.exe"
#define SrcDir "..\dist\智慧树一键全自动"

[Setup]
AppId={{A7C4E9B2-3D61-4F58-8B0A-6E2D9C1F7A34}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher=智慧树一键全自动
VersionInfoVersion={#MyAppVersion}
VersionInfoDescription={#MyAppName} 安装程序
DefaultDirName={localappdata}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
DisableDirPage=auto
OutputDir=..\dist
OutputBaseFilename={#MyAppName}-安装程序-{#MyAppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
; 全部写入用户目录，免管理员、无 UAC
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
MinVersion=10.0
AllowNoIcons=yes
UninstallDisplayIcon={app}\{#MyAppExe}
UninstallDisplayName={#MyAppName}

[Languages]
Name: "chinese"; MessagesFile: "installer-lang\ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加任务:"; Flags: checkedonce

[Files]
Source: "{#SrcDir}\{#MyAppExe}"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SrcDir}\使用说明.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SrcDir}\设置AI密钥.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SrcDir}\runtime\node.exe"; DestDir: "{app}\runtime"; Flags: ignoreversion
; 程序本体（排除用户配置、个人数据与题库，单独处理，升级时不被覆盖）
Source: "{#SrcDir}\app\*"; DestDir: "{app}\app"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: "md-ai-answer\config.json,export\智慧树作业题库_打印版.answers.json,export\papers.json,export\courses-resolved.json,export\*.log,export\*.tmp"
; 配置模板固定取仓库里的空密钥版本，绝不打包 dist 中开发者/用户已填写的 config.json
Source: "config.automation.json"; DestDir: "{app}\app\md-ai-answer"; DestName: "config.json"; Flags: onlyifdoesntexist
Source: "{#SrcDir}\app\export\智慧树作业题库_打印版.answers.json"; DestDir: "{app}\app\export"; Flags: onlyifdoesntexist

[InstallDelete]
; 旧版的命令行设置脚本，升级时清掉
Type: files; Name: "{app}\设置AI密钥.cmd"

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExe}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExe}"; Description: "立即运行 {#MyAppName}"; Flags: nowait postinstall skipifsilent
