# Node / JS 接口说明

> 面向"在自己的脚本里复用这些能力"。所有模块都是 ESM，直接 `import` 即可，无需构建。
> 机器可读的产物契约见 [`DATA-CONTRACT.md`](DATA-CONTRACT.md)。

## 模块总览

| 模块 | 导出 | 用途 |
|---|---|---|
| `src/core/browser.mjs` | `HOME` `findChromium` `cdpAlive` `findLiveCdp` `ensureChromium` `connect` `findPage` `readyPage` `tidy` `focusWindow` `waitContent` | 浏览器抽象层（Edge CDP / Firefox 持久化 profile） |
| `src/core/login-flow.mjs` | `LOGIN_URL` `API_USERINFO` `loadAccount` `checkLogin` `captchaVisible` `fillLoginForm` `ensureLoggedIn` | 登录公共逻辑（学校下拉框等易错点集中在此） |
| `src/core/accounts.mjs` | `STORE` `LEGACY` `FIELD_ALIASES` `normalizeAccount` `resolveAccount` `saveAccount` `importAccount` `exportAccount` `harden` `mask` `fieldHelp` | 凭据解析：多来源、字段别名归一、导入导出、权限收紧 |
| `src/core/prompt.mjs` | `askLine` `askSecret` | 交互式读取输入（TTY 隐藏回显；管道可用） |
| `src/flows/session.mjs` | `ensureSession` | 一次性会话体检：校验登录态 + 存 Cookie/storageState |
| `src/core/python.mjs` | `PY` | 探测到的 python 解释器路径 |

---

## `src/core/browser.mjs`

### 常量

```js
import { HOME } from './src/core/browser.mjs';
// HOME = 'https://onlineweb.zhihuishu.com/onlinestuh5'   学生端首页
```

### `findChromium()`

探测本机可用的 Chromium 系浏览器。

- **返回**：`{ name, port, channel, exe, exePath } | null`（`name` 为 `'edge'` | `'chrome'`；`port` 为 `9222` | `9223`）
- **副作用**：无

### `cdpAlive(port, timeoutMs = 2500)`

检测指定端口的 CDP 是否存活。

- **返回**：`Promise<object | null>`；存活时返回 `/json/version` 的解析结果（含 `Browser` 版本串），否则 `null`

### `findLiveCdp()`

遍历候选端口，找第一个存活的 CDP。

- **返回**：`Promise<{ browser, port, version } | null>`

### `ensureChromium({ headless = false } = {})`

**幂等**地保证有一个可接管的 Chromium 在跑：已在跑则复用，否则用系统原版浏览器 + `--remote-debugging-port` 启动。

> 为什么必须这样启动：Playwright 自己 `launch` 的 Chromium 带 `navigator.webdriver=true`，网易易盾验证码会拒绝渲染。用系统原版浏览器 + CDP 接管后 `navigator.webdriver=false`，验证码可正常通过。

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `headless` | boolean | `false` | 加 `--headless=new` |

- **返回**：`Promise<{ browser, port, version, started }>`（`started: false` 表示复用已有实例）
- **profile 选择**：优先 `browser-profile-<name>`；若不存在但历史目录 `browser-profile-cdp` 存在则沿用后者（避免登录态丢失）
- **副作用**：可能启动浏览器进程（窗口可见）
- **抛错**：找不到可执行文件、或 40 秒内调试端口未就绪

### `connect({ prefer = 'chromium' } = {})`

**统一会话入口**：拿到一个可直接用的 Playwright 上下文，调用方不需要区分浏览器类型。

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `prefer` | `'chromium'` \| `'firefox'` | `'chromium'` | `firefox` 走 Playwright 自带构建的持久化 profile |

- **返回**：`Promise<{ kind, browserName, browser, ctx, describe, close }>`

| 字段 | 说明 |
|---|---|
| `kind` | `'cdp'`（Chromium CDP 接管）或 `'persistent'`（Firefox 持久化） |
| `browserName` | `'edge'` / `'chrome'` / `'firefox'` |
| `browser` | Chromium 时为 Playwright `Browser`；Firefox 时为 `null` |
| `ctx` | Playwright `BrowserContext`（CDP 模式下为 `browser.contexts()[0]`） |
| `describe` | 人类可读描述，如 `edge @ CDP 9222 (Edg/155.0.4283.45)` |
| `close` | `() => Promise<void>`，关闭连接（CDP 模式下只断开，不杀浏览器） |

- **抛错**：`prefer='chromium'` 且没有存活的 CDP 时抛错（提示先跑 `start-browser.ps1` 或用 firefox 模式）

```js
import { connect } from './src/core/browser.mjs';
const { ctx, describe, close } = await connect();
console.log(describe);
// …用 ctx 干活…
await close();
```

### `findPage(ctx, match = HOME)`

在上下文中按 URL 子串找页；找不到则退化为"第一个 zhihuishu 域且非 about: 的页"。

- **返回**：`Page | undefined`

### `readyPage(ctx, url = HOME, { reuse = true } = {})`

拿到一个**已就绪、已置前**的目标页：复用已有同域页 → 复用空白页 → 新建页；若当前不在该域则导航过去。

| 参数 | 类型 | 默认 |
|---|---|---|
| `url` | string | `HOME` |
| `reuse` | boolean | `true`（`false` 时强制新建） |

- **返回**：`Promise<Page>`（导航失败不抛错，返回当前页）
- **副作用**：可能导航、`bringToFront()`

### `tidy(ctx, focusUrl = 'onlineweb.zhihuishu.com/onlinestuh5')`

收拾标签页：关掉 `about:blank`、去重同 URL 页、把目标页置前、并尝试将窗口最大化（Firefox 无此 CDP 命令，会被忽略）。

- **返回**：`Promise<Page | undefined>`（被置前的页）
- **副作用**：**会关闭标签页**、可能改变窗口尺寸、调用 `focusWindow()`

### `focusWindow(processName)`

把浏览器主窗口提到前台（借 COM `WScript.Shell.AppActivate`）。

- **参数**：`processName` 可选；省略则依次尝试 `msedge` / `chrome` / `firefox`
- **返回**：`Promise<string>`，形如 `msedge AppActivate=True`，失败返回 `focus-failed: …`（不抛错）

### `waitContent(page, minLen = 50, timeout = 30000)`

轮询等待页面正文文本达到最小长度（判断"页面真的渲染出来了"）。

- **返回**：`Promise<number>`，达到的长度；超时返回 `0`

---

## `src/core/login-flow.mjs`

### 常量

```js
export const LOGIN_URL = 'https://login.zhihuishu.com/?origin=zhs&service=…';
export const API_USERINFO = 'https://onlineservice-api.zhihuishu.com/gateway/f/v1/login/getLoginUserInfo';
```

### `loadAccount()`

按 `src/core/accounts.mjs#resolveAccount()` 的优先级读凭据（高 → 低）：命令行 → 环境变量 → `--account <path>` → `config/credentials.json` → 旧文件 `config/account-live.json` / `config/account.json`。

- **返回**：`{ file, ...凭据字段 } | null`（`file` 是实际命中的来源文件；来源为命令行/环境变量时返回占位文本）
- **副作用**：无（读文件；文件不可读时静默跳过）

### `checkLogin(page)`

在页面上下文里调 `getLoginUserInfo` 判断登录态（走接口比看 DOM 可靠）。

- **返回**：`Promise<{ code, user } | { code: -1, err }>`
  - `code === 200` 时 `user` 含 `realName`、`schoolName`、`uuid` 等
  - `code === 403` 表示未登录
  - `code === -1` 表示求值异常（页面正在跳转等）

### `captchaVisible(page)`

检测**真正的易盾容器**（`[class*="yidun"]` 中可见尺寸的 + 含 `dun.163|captcha|yidun` 的 iframe）。

- **返回**：`Promise<number>`，命中的容器数量（`0` 表示没有验证码）
- **注意**：不要用"页面里有 iframe"当判断依据——登录页有装饰性 iframe，会误报

### `fillLoginForm(page, acc, { log = console.log, shotDir = null } = {})`

在给定 page 上完成"学号登录"表单填写并提交。

| 参数 | 说明 |
|---|---|
| `acc` | `{ school, studentId, password }` |
| `log` | 日志函数（默认 `console.log`） |
| `shotDir` | 传目录则在提交前截图 `form-filled.png` |

**学校下拉框的处理（关键）**：输入 `acc.school` 后等待下拉，优先按**完全匹配**点击；匹配不到才退回"方向键 + 回车选第一项"，并回读下拉显示文本做校验。此前踩过的坑是下拉里出现 `示例大学医学院` 等同名前缀项，随手点第一项会选错。

- **返回**：`Promise<{ picked, shown }>`（实际选中的项、下拉显示文本）
- **副作用**：导航到登录页、填表、点击提交

### `ensureLoggedIn(page, acc, { log = console.log, waitMs = 480000, shotDir = null } = {})`

完整的"确保登录"：先查登录态 → 需要则填表提交 → 轮询等待（出现验证码时提示人工完成）。

| 参数 | 默认 | 说明 |
|---|---|---|
| `waitMs` | `480000`（8 分钟） | 最长等待时长 |

- **返回**：`Promise<{ code, user }>`；`code === 200` 表示成功，`code === -1` 表示等待超时

```js
import { connect } from './src/core/browser.mjs';
import { ensureLoggedIn, loadAccount } from './src/core/login-flow.mjs';

const { ctx, close } = await connect();
const page = ctx.pages()[0] ?? await ctx.newPage();
const { acc } = loadAccount();
const st = await ensureLoggedIn(page, acc);
if (st.code !== 200) process.exit(2);
await close();
```

---

## `src/core/accounts.mjs`

凭据解析的核心。**这是"个人信息可自定义输入"的实现所在**，详见 [`CREDENTIALS.md`](CREDENTIALS.md)。

### 常量

```js
export const STORE;        // config/credentials.json —— 凭据库默认落点
export const LEGACY;       // [config/account-live.json, config/account.json]
export const FIELD_ALIASES; // { school: [...别名], studentId: [...], realName: [...], password: [...] }
```

### `resolveAccount({ argv, env, explicitFile })`

按优先级解析凭据：**命令行 → 环境变量 → `--account` 指定文件 → 凭据库 → 旧文件**。逐字段决定，可混用。

| 参数 | 类型 | 默认 |
|---|---|---|
| `argv` | string[] | `process.argv.slice(2)` |
| `env` | object | `process.env` |
| `explicitFile` | string \| null | `null` |

- **返回**：

| 字段 | 说明 |
|---|---|
| `acc` | 归一后的 `{ school, studentId, realName?, password }` |
| `source` | 每个字段的来源：`'cli'` / `'env'` / `'credentials.json'` / `'account-live.json'` … |
| `complete` | 三个必填字段是否齐全 |
| `missing` | 缺失的必填字段名 |
| `read` | 成功读到的候选文件（含 `mapped` / `unknown`） |
| `candidates` | 全部候选（含读取失败的，便于报错） |
| `problems` | 读取失败的原因 |

### `normalizeAccount(raw)`

把任意对象归一成标准字段，靠 `FIELD_ALIASES` 做别名匹配。

- **返回**：`{ acc, mapped, unknown }` —— `mapped` 是"原字段名 → 标准字段"的映射（用于告诉用户识别到了什么），`unknown` 是忽略掉的字段。

### `saveAccount(acc, { file, merge })`

写入凭据文件，并尝试把权限收紧到仅当前用户。

- **返回**：`{ file, saved, secured }`（`secured` 表示权限是否收紧成功）

### `importAccount(fromFile, { file, fields })`

导入：读文件（自动去 BOM）→ 归一 → 写入。

- **返回**：`{ ok, error?, mapped, unknown, acc, file, saved, secured }`；`ok:false` 时给出可读原因

### `exportAccount(acc, outFile)` / `harden(path)` / `mask(s)` / `fieldHelp()`

导出到指定文件 / 收紧权限 / 掩码显示（`L*********`）/ 打印别名速查表。

```js
import { resolveAccount, mask } from './src/core/accounts.mjs';

const r = resolveAccount({ argv: process.argv.slice(2) });
if (!r.complete) {
  console.error('缺字段:', r.missing.join(', '));
  process.exit(1);
}
console.log(r.acc.school, r.acc.studentId, mask(r.acc.password), '来源:', r.source);
```

---

## `src/core/prompt.mjs`

交互式读取输入。写它是因为 PowerShell 的 `Read-Host` **读不了管道输入**，脚本化场景会卡死。

### `askLine(question)`

读一行文本。

- **返回**：`Promise<string>`（已 trim）
- TTY 与管道（无 TTY）都可用

### `askSecret(question)`

读密码。TTY 下进入 raw mode 且**只回显 `*`**；非 TTY 下退化为按行读取。

- **返回**：`Promise<string>`
- `Ctrl+C` 会以退出码 130 结束

> **实现注意（踩过的坑）**：两个函数共用同一个内部 readline 读取器和行队列。**不要每个问题都 new 一个 readline 接口** —— 每次 `close()` 都会把 stdin 置为 paused，下一个接口就再也收不到数据，表现为"只有第一个提示能输入，之后卡死"并触发 `Detected unsettled top-level await`。

```js
import { askLine, askSecret } from './src/core/prompt.mjs';

const school = await askLine('学校: ');
const password = await askSecret('密码: ');
```

---

## `src/flows/session.mjs`

### `ensureSession()`

一次性会话体检：连接浏览器 → 打开学生端 → 校验登录态 → 导出 Cookie 与 storageState → 收拾标签页 → 断开。

- **返回**：`Promise<object>`

| 字段 | 说明 |
|---|---|
| `ok` | 是否已登录 |
| `reason` | 失败原因（如 CDP 未运行） |
| `user` | 用户信息（`realName` 等） |
| `cookieCount` | 智慧树相关 Cookie 条数 |
| `pageTextLen` | 首页正文字符数（判断渲染是否正常） |
| `focusedUrl` / `openTabs` | 置前的 URL / 全部标签 URL |
| `detail` | 接口原始返回 |

- **副作用**：写 `session/cookies.json`、`session/storage-state.json`；**关闭浏览器连接**、收拾标签页

> 该模块也可直接执行：`node src/flows/session.mjs`，输出 JSON，退出码 `0`/`1`。

---

## `src/core/python.mjs`

```js
export const PY;   // 探测到的 python 解释器绝对路径；探测不到时为 'python'
```

探测顺序：`ZHS_PYTHON` 环境变量 → DSH 打包运行时 → 系统 `python`。

---

## 直接复用底层只读接口

`export/papers.json` 里的数据来自以下**只读**接口。若你想自己拉，可在**已登录的浏览器页面上下文**里 `fetch`（Cookie 由浏览器自动带上）：

| 用途 | 方法与地址 | 说明 |
|---|---|---|
| 登录态 | `GET onlineservice-api.zhihuishu.com/gateway/f/v1/login/getLoginUserInfo` | `code:200` 已登录 |
| 课程列表 | `POST onlineservice-api.zhihuishu.com/gateway/t/v1/student/course/share/queryShareCourseInfo` | `Content-Type: application/x-www-form-urlencoded`；body: `secretStr`、`date`、`pageNo`、`pageSize` |
| 作业列表 | 页面内触发 `getStudentHomework` | 打开 `onlineexamh5new.zhihuishu.com/stuExamWeb.html#/webExamList?recruitId=<listRid>` 后由前端发起 |
| 试卷内容 | 页面内触发 `student/doHomework` | 打开下面的 dohomework 地址后由前端发起 |

**试卷地址模板**（`listRid` 已 URL 编码，直接拼）：

```
https://onlineexamh5new.zhihuishu.com/stuExamWeb.html#/webExamList/dohomework/<recruitId>/<hw.id>/<hw.examId>/<courseId>/5371/<meetCourseType>
```

其中 `5371` 是示例大学的 schoolId；其它学校需替换。

**签名机制**：`secretStr` 是三层签名（`secret` + 时间戳 + 固定盐）的结果，**不能跨接口复用**——课程列表、章节视频各有各的 `secretStr`，即使参数相同也会返回 `code 421 该账号无权限`。详见 [`SITE-REPORT.md`](SITE-REPORT.md)。

---

## 契约与校验

```js
// 校验产物结构是否符合契约
import { spawnSync } from 'node:child_process';
const r = spawnSync(process.execPath, ['recon/validate-data.mjs'], { encoding: 'utf8' });
console.log(r.stdout);          // r.status === 0 表示通过
```

- Schema：`docs/schemas/papers.schema.json`、`docs/schemas/courses-resolved.schema.json`
- 校验器：`recon/validate-data.mjs`（结构 + 业务规则），退出码 `0`/`3`
