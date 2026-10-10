# 智慧树在线学堂 — 站点侦察与自动化基础报告

> 生成时间：2026-10-10（2026 年换机后已做路径迁移，见 §8）
> 运行环境：Windows / 用户 `USER` / 工作区 = 本文件所在目录 / Node v24
> 目标站点：https://onlineweb.zhihuishu.com/onlinestuh5
> 会话身份：示例用户（uuid `demo-uuid`，示例大学 schoolId `5371`，学生身份 identityType=4）

---

## 1. 站点架构

学生端不是一个单体应用，而是**一整套跨域 SPA 集群 + 微服务网关**：

| 子系统 | 域名 | 作用 |
|---|---|---|
| 登录中心 | `login.zhihuishu.com` → `passport.zhihuishu.com` | 账号/学号/工号/扫码登录，CAS 单点登录发 `ST-` 票据 |
| 学生首页 | `onlineweb.zhihuishu.com/onlinestuh5` | 课程列表、入口导航 |
| 在线学堂前端 | `onlinestuh5.zhihuishu.com` | SPA 产物宿主（`app/core/crypto/*.js`） |
| 业务网关 | `onlineservice-api.zhihuishu.com/gateway/t/v1` | 课程、身份、消息、见面课 |
| 学习服务 | `studyservice-api.zhihuishu.com/gateway/t/v1` | **视频目录、学习进度、章节** |
| 成绩/资料 | `stuonline.zhihuishu.com/stuonline` | 成绩分析、课程资料（服务端渲染，非 SPA） |
| 视频播放 | `studyvideoh5.zhihuishu.com/stuStudy` | 视频学习页 |
| 问答 | `qah5.zhihuishu.com` | 课程问答 |
| 考试 | `hike-examstu` / `studentexam-api` / `newexam-api` | 作业与考试 |
| 统一用户 | `appcomm-user.zhihuishu.com` | `getUserInfoAndAuthInfo` |
| 埋点 | `buried-point.zhihuishu.com` | 行为埋点 |

**鉴权链路（已实测还原）**：

```
login.zhihuishu.com  →  passport.zhihuishu.com/login (CAS)
                     →  cloudapi.polymas.com/oauth/login/ssoLogin   (换取 ST- 票据)
                     →  onlineservice-api.../gateway/f/v1/login/gologin?ticket=ST-xxx
                     →  onlineweb.zhihuishu.com/onlinestuh5          (落地学生首页)
```

会话票据分布：`onlineservice-api` 的 `SESSION`、7 个子域的 `JSESSIONID`、CAS 系 `CASTGC`/`jt-cas`、polymas 的 `polymas-token`。

---

## 2. 登录实现细节

- **学号登录表单**：学校搜索下拉框 + `input[name="unid"]`（学号）+ 密码框
- **必须先勾选用户协议**，否则提交按钮虽变蓝但表单校验静默拦截（不报错、不发请求）
- **登录按钮是 `<div class="...btn-block__grandient_login">`，不是 `<button>`**
- **密码加密**：`user.zhihuishu.com/zhsuser/login/account` 请求体整体 AES-CBC 加密
  - key = `bdas85990328dfpl`（16B）
  - iv  = `563216db1e1744c7`（16B）
  - 模式：`AES-CBC` + `JSON.stringify(payload)` → base64
- **人机验证**：网易易盾（`NECaptchaValidate` 字段 + `c.dun.163.com`）
  - Playwright 原生启动的浏览器因 `navigator.webdriver=true` **无法渲染验证码控件**
  - **解决方式**：用系统原版 Edge + `--remote-debugging-port=9222` 启动，再用 Playwright `connectOverCDP` 接管 → `navigator.webdriver=false`，验证码正常

---

## 3. secretStr 签名机制（核心）

网关接口要求 `secretStr` 参数，否则报 `aes加密参数异常` / `AppInterfaceSignInterceptor.checkSecretStr`。

**关键结论（已实测）**：

1. `secretStr` 是 **AES 加密的固定标识**，全站仅使用少数几个**固定常量**，并非按请求动态签名
2. 同一个 `secretStr` 可跨接口、跨 `date` **重复使用**
3. 但它与**接口绑定**：错用签名会返回空结果而非报错（静默失败，容易误判）
4. **部分接口无需签名**（如 `findCheatListCount`、`queryIdentity`、`getLoginUserInfo`）

**已验证可用的签名常量**：

| 签名 | 适用接口 |
|---|---|
| `NEuH3llD9woD4DQgu0k6Uvp5yyo8WT84Dq5lU2iPwvgKNatePzJ+vu/4PRaNYy+K` | 课程列表 `queryShareCourseInfo` |
| `yaVfYIJIdqrHDXsDL3vsYw==` | 证书、服务器时间、待提交考试、重要通知、异常计数、系统消息 |
| `AatOAojihIoMt3Lca3/nnsiNosg1vqAQCdptOEXIV/M=` | 选课信息、背景信息、门户路径 |
| `9vMd++uCrf+BzJfxwXm9CcfwP5pPmMDKEnfjL8ARZpzmgypvR+/bGLs+sIEs54UWEE7gOFfF2vlLRjibwO9aag==` | 版本、身份选择 |
| `QhSgx0MEvvp0jRL20aaxWiUkrjuZvigMo7O0OApkaCEo76j+nBmFpel6fwHuTiRWnz+pGIblHqSmkUPS2xszknn3/CwHW1Br60fY/IJ4iX7UCYd8wCln28Ex0cB0bmgJ` | 视频服务 `queryCourse` / `videolist` |

> 提取方式：`src/intercept-sign.mjs`（拦截真实请求抓取），可持续补充新签名。

---

## 4. 已还原的真实数据

### 4.1 课程（3 门）

| 课程 | courseId | recruitId | secret（cparams） | 教师 | 进度 |
|---|---|---|---|---|---|
| 大学生心理健康教育 | `1000101708` | `435122` | `4e5b5c59475b4859454a585858445e4350` | 毕凤玲 | 2.9% |
| 国家安全教育 | `1000120382` | `428806` | — | 黎妹红 | 4.4% |
| 思想道德与法治 | `1000070264` | `453708` | — | 周小玲 | 0% |

### 4.2 关键接口

**课程列表**
```
POST https://onlineservice-api.zhihuishu.com/gateway/t/v1/student/course/share/queryShareCourseInfo
Content-Type: application/x-www-form-urlencoded
secretStr=<上述课程列表签名>&date=<ms>&pageNo=1&pageSize=20
```

**视频目录（章节 + 视频）**
```
POST https://studyservice-api.zhihuishu.com/gateway/t/v1/learning/videolist
Content-Type: application/x-www-form-urlencoded
secretStr=<视频服务签名>&dateFormate=<ms>&recruitId=435122&courseId=1000101708
```
返回 `videoChapterDtos[].videoLessons[]`，含 `id`（lessonId）、`videoId`、`videoSec`（时长秒）、`isStudiedLesson`。

**学习进度**
```
POST https://studyservice-api.zhihuishu.com/gateway/t/v1/learning/queryStuyInfo
```
返回每节课 `{studyTotalTime, watchState}`。

> ⚠️ **签名还有第三层机制**：`queryStuyInfo`（单课节观看时长）与 `queryStudyReadBefore`（学习/考试时间、分数规则）
> 要求把 `recruitId`/`courseId` **加密进 `secretStr`**，不能与其他接口复用签名常量。
> 复用会返回 `code 421「该账号无权限」`（**HTTP 仍是 200，极易误判为网络问题**）。
> 这两个接口需**驱动浏览器实际操作页面**采集，见 `src/probe-421.mjs`。
> 而 `videolist` 用固定签名即可正常返回全部章节与视频数据。

**其他已验证接口**
- `studyservice-api.../learning/queryCourse` — 课程基本信息、`classId`、成绩规则
- `studyservice-api.../learning/queryUserRecruitIdLastVideoId` — 上次观看位置
- `onlineservice-api.../student/getStudentNoCommitExam` — 待提交考试
- `onlineservice-api.../mirror/home/cheat/findCheatListCount` — 异常/未读计数
- 成绩分析（服务端渲染）：`https://stuonline.zhihuishu.com/stuonline/stuLearnReportNew/index?recruitId=435122&courseId=1000101708`
- 课程资料：`https://stuonline.zhihuishu.com/stuonline/folder/stuIndexV2?recruitId=<>&courseId=<>`
- 见面课：`https://stuonline.zhihuishu.com/stuonline/teachMeeting/stuListV2?recruitId=<>`

---

## 5. 工程脚手架

> 所有脚本都从**本文件所在目录**（工作区根）自定位，不写死盘符与用户名；
> 换机器/换盘符后无需改代码，`node src\xxx.mjs` 直接可用。

```
<工作区根>\
├─ start-browser.ps1        启动专用 Edge（远程调试 9222），会话长期保存
├─ config\account.json      登录凭据（已收紧权限，仅当前用户可读）
├─ session\                 cookies.json / cookie-headers.json / storage-state.json
├─ browser-profile-edge\    专用浏览器配置（会话持久化在这里）
├─ export\                  导出产物（raw.json、智慧树课程数据.xlsx）
├─ src\
│   ├─ browser.mjs          ★ 共享浏览器辅助（标签管理 + 窗口置前）
│   ├─ python.mjs           ★ 定位可用 Python（环境变量 → DSH 运行时 → PATH）
│   ├─ session.mjs          会话保活、验证、显示修复
│   ├─ focus.mjs            把 Edge 窗口提到最前（随时可用）
│   ├─ login-cdp.mjs        自动登录（CDP 接管版）
│   ├─ export-courses.mjs   批量导出课程+章节视频 → JSON
│   ├─ intercept-sign.mjs   抓取真实 secretStr
│   ├─ test-sig-reuse.mjs   签名复用验证
│   ├─ core-apis.mjs        视频/资料/成绩接口探测
│   └─ explore-sites.mjs    全子系统接口枚举
└─ recon\                   侦察产物（接口清单、页面截图、签名源码）
```

**日常使用流程**：`.\start-browser.ps1` → 确认已登录 → `node src\session.mjs` 验证 → `node src\focus.mjs`（窗口被挡住时置前）。

---

## 5.1 显示问题与修复（重要）

### 症状
脚本执行成功、数据也拿到了，**但浏览器界面上什么都看不见**。

### 根因（两个叠加）
1. **激活标签是空白页**：早期脚本一律用 `ctx.newPage()` 新建标签、用完 `close()` 关闭，
   激活权最终落到 `about:blank` 上。窗口标题会暴露这一点：
   `about:blank 和另外 7 个页面` —— 真实页面全在后台标签里。
2. **窗口被 DSH 盖住**：DSH 自有窗口常驻最上层。CDP 的 `Page.bringToFront()`
   只能切换**标签页**，无法把整个浏览器窗口抬到其它应用之上；
   而 Windows 默认禁止后台进程抢占前台焦点。

### 修复（已固化到 `src/browser.mjs`）
| 措施 | 实现 |
|---|---|
| 不再制造空白页 | `readyPage()` 优先复用已有真实页面，其次复用空白页，最后才新建 |
| 收尾必聚焦真实页面 | `tidy()` 关闭空白页与重复页，优先聚焦学生首页 |
| 保证可见 | 通过 CDP `Browser.setWindowBounds` 将窗口最大化 |
| 窗口置前 | `focusEdgeWindow()` 调用 COM `WScript.Shell.AppActivate`，实测返回 `True` 生效 |
| 启动即打开真实页面 | `start-browser.ps1` 直接打开学生首页，并加 `--window-size/--window-position` |

> 注：`Add-Type` 在本沙箱被禁用（`A required privilege is not held by the client`），
> 因此无法使用 Win32 P/Invoke（`SetForegroundWindow`/`SetWindowPos`），
> 改用 COM 的 `WScript.Shell.AppActivate` 实现置前。

### 症状复发时的处理
运行 `node src\focus.mjs`，或直接点任务栏的 Edge 图标。

---

## 6. 实现批量动作的两条技术路线

| 路线 | 方式 | 适用 |
|---|---|---|
| **A. HTTP 直连** | 用 `session\cookie-headers.json` 的 Cookie + 已验证签名直接调 API | 读取类：课程/进度/成绩/通知批量导出，速度快、无需浏览器 |
| **B. 驱动浏览器** | 通过 CDP 操作真实页面 | 写入类、需 CSRF/签名动态生成、或跨域受限的页面 |

**建议**：读取用 A，涉及提交/交互用 B。

---

## 8. 换机后的路径与环境（重要）

本工作区已从旧机器（`D:\网页自动学习`，用户 `Administrator`）迁移到本机，全部脚本已改为**自定位**，
不再写死盘符、用户名、Firefox profile 哈希或 Python 绝对路径。

### 8.1 路径规则

| 位置 | 规则 |
|---|---|
| `src\*.mjs`、`recon\*.mjs` | 顶部 `const ROOT = join(import.meta.dirname, '..')`，其余路径一律 `join(ROOT, ...)` |
| `export\make-docx.py`、`make-xlsx.py` | `BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))` |
| `recon\*.py` | 同样用 `__file__` 推导，或 `os.path.expandvars("%APPDATA%")` 跟随当前用户 |
| `start-browser.ps1` | `$root = $PSScriptRoot` |
| `recon\ff-test.cmd` | `%~dp0..` |
| Firefox profile | 由 `%APPDATA%\Mozilla\Firefox\Profiles` 自动发现，取会话票据最多的 profile |
| Python 解释器 | `src\python.mjs`：`%PYTHON%` → `$DSH_HOME/dsh-runtimes/.../python.exe` → PATH 上的 `python` |

> 依赖 `import.meta.dirname`，需要 **Node ≥ 20.11**（本机 v24）。

### 8.2 本机实测环境

| 项 | 值 |
|---|---|
| 用户 / 工作区 | `USER` / 见本文件所在目录 |
| Node | `C:\Program Files\nodejs\node.exe` (v24.16.0) |
| Python | `C:\Python314\python.exe`；DSH 自带运行时亦可用 |
| Edge | `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe` ✅ |
| Firefox | `C:\Program Files\Mozilla Firefox\firefox.exe` ✅ |
| Playwright Firefox | `ms-playwright\firefox-1555\` ✅（随工作区一起迁移，无需重下） |
| Chrome | ❌ 未安装（Chrome 分支会自动跳过，Edge 分支不受影响） |

### 8.3 待人工处理：两处文件权限（当前登录令牌未提权，脚本改不了）

本机账号 `USER` 在 Administrators 组里，但**进程令牌是未提权的**（中等完整性），
所以下面两处只能由你用**管理员身份**的 PowerShell 修一次。

**(1) `config\account.json` 读不出来** —— 权限在旧机器上被收紧到当时那个用户：
`Get-Content` 拒绝访问，`icacls` 也报拒绝。

**(2) 工作区根目录缺少「更改权限」** —— 本会话一开始 DSH 报
`SetNamedSecurityInfoW failed (Win32 5): grantWrite(...)`，就是这个原因；
DSH 的文件沙箱给工作区授权时需要改 ACL。工作区根的所有者是 `BUILTIN\Administrators`。

```powershell
# 以「管理员身份」打开 PowerShell，然后：
cd <工作区根>

# (1) 登录凭据文件
takeown /f ".\config\account.json"
icacls ".\config\account.json" /inheritance:e /grant "$env:USERNAME:(F)"

# (2) 工作区根（让 DSH 能正常给工作区授权）
takeown /f "."
icacls "." /grant "$env:USERNAME:(OI)(CI)F"
```

修好后 `node src\probe-school.mjs` 之类的脚本才能读到登录凭据，
普通（非完全权限）会话里 DSH 的文件沙箱也能正常写入工作区。

### 8.4 本次一并修好的其它环境项

| 项 | 原状 | 现状 |
|---|---|---|
| `browser-profile-firefox\compatibility.ini` | 指向 `D:\...\ms-playwright\firefox-1555\...` | 指向新位置（Firefox 要求绝对路径，此处必须写死） |
| `ms-playwright\.links\<sha1>` | 文件名为 `sha1(旧 playwright-core 路径)` | 按新路径重算哈希并改名、内容同步，否则 Playwright 会认为浏览器没装好而重新下载 |
| `browser-profile-cdp\Local State` | Edge 内部记录了旧盘符的站点清单路径 | 已改为新盘符 |
| `start-browser.ps1`、`recon\check-window.ps1` | UTF-8 无 BOM，**Windows PowerShell 5.1 解析失败**（中文按 ANSI 解码后乱码里出现引号类字符） | 已补 UTF-8 BOM，5.1 与 7 都能正常解析 |

### 8.5 仍带旧盘符的**生成物**（非程序，可忽略或重跑覆盖）

- `export\preview\manifest.json` —— docx 预览清单，记的是生成时的绝对路径
- `recon\firefox-remote.json` —— 一次 Firefox 远程调试探测的日志
- `session\firefox-profiles.json` —— 旧机器上的 Firefox profile 清单，重跑 `node src\firefox-session.mjs` 会覆盖
- `browser-profile*\Default\...\LOG*`、`favorites_diagnostic.log` —— 浏览器自己的追加式日志，会自行滚动覆盖

> 本节提到的旧路径仅作为迁移记录保留；**代码里已无写死的旧盘符 / 用户名**。

