# CLI 接口说明

> 面向"另一个程序 / 另一个 AI"调用。机器可读版本见 [`tools.json`](tools.json)。
> 人类使用说明见 [`../README.md`](../README.md)。

## 调用形式

```powershell
# 统一入口（跨平台）
node zhs.mjs <command> [--flag value]

# Windows 启动器（自动定位 node 与浏览器运行时）
run.cmd <command> [--flag value]
```

- **工作目录**：`zhs.mjs` 所在目录（工作区根）。程序内部用 `import.meta.dirname` 定位，**从任何目录调用都可以**。
- **幂等**：所有命令可重复执行。`docs` / `verify` / `status` / `doctor` 不访问网络；`solve` 会访问你配置的 AI 接口（`--mock` 除外）。
- **输出约定**：人类可读结果写 `stdout`；进度与诊断写 `stderr`；**数据一律落文件**，便于下游程序读取。
- **退出码**：`0` 成功 · `1` 出错 · `2` 未登录 · `3` 校验不通过。

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `ZHS_PYTHON` | 否 | 指定 python 解释器；默认自动探测 DSH 打包运行时，再退回 `python` |
| `PLAYWRIGHT_BROWSERS_PATH` | 否 | 浏览器运行时目录；不设时自动回退到 `<工作区>/ms-playwright` |

---

## 命令契约

### `doctor` — 环境自检

```
node zhs.mjs doctor
```

| 项 | 说明 |
|---|---|
| 参数 | 无 |
| 返回值 | stdout 文本，逐项 `✓`/`✗` + 修复建议；最后一行给出可用命令 |
| 退出码 | `0` 全部就绪；`1` 存在不满足项（有多少项都返回 1） |
| 副作用 | 无（只读；会临时执行 `python -c "import docx, openpyxl"` 探测库是否可用） |

检查项：Node 版本、Python 文档库、Playwright 安装、浏览器运行时目录、凭据文件、Edge 登录资料、题库数据。

**调用方建议**：任何自动化流程开始前先跑它。

---

### `status` — 当前状态

```
node zhs.mjs status
```

| 项 | 说明 |
|---|---|
| 参数 | 无 |
| 返回值 | stdout 文本：账号、题库规模（课程/作业/题目数）、各产物的大小与修改时间 |
| 退出码 | 恒为 `0`（数据缺失时给出下一步提示） |
| 副作用 | 无（只读） |

会额外**比对产物与 `papers.json` 的修改时间**，对过期产物给出提示——用于判断"是否需要重跑 docs"。

---

### `login` — 登录并固化会话

```
node zhs.mjs login [--restart-check] [--school X] [--student-id Y] [--password Z] [--real-name N] [--account <文件>]
                   [--browser <chromium|firefox>] [--browser-exe <路径>] [--firefox-profile <目录>]
```

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--restart-check` | 开关 | 关 | 登录后关闭浏览器再重启，验证会话是否存活 |
| `--school` | string | 凭据文件 | 学校名（覆盖） |
| `--student-id` | string | 凭据文件 | 学号（覆盖） |
| `--password` | string | 凭据文件 | 密码（覆盖） |
| `--real-name` | string | 凭据文件 | 姓名（覆盖，可选） |
| `--account` | path | — | 从指定 JSON 读取凭据（字段名自动识别别名） |
| `--browser` | enum | `chromium` | 登录用哪个浏览器；`firefox` 走 WebDriver BiDi |
| `--browser-exe` | path | — | 任意浏览器：直接指定可执行文件 |
| `--firefox-profile` | path | `browser-profile-firefox` | Firefox profile（需先完全退出 Firefox） |

| 项 | 说明 |
|---|---|
| 返回值 | stdout 文本：凭据来源与掩码后的字段、登录结果（`realName`）、关键票据清单、重启后是否仍登录 |
| 退出码 | `0` 成功；`1` 凭据不完整；`2` 未登录成功；`3` 重启后会话丢失 |
| 副作用 | 启动 Edge 并操作登录页表单；**会写浏览器资料目录** |

> **凭据不完整时**不会直接失败退出，而是打印五种可用输入方式（命令行 / 环境变量 / 导入文件 / 交互录入 / 凭据库）。详见 [`CREDENTIALS.md`](CREDENTIALS.md)。

> **阻塞式交互**：若出现网易易盾人机验证，脚本会停在验证页并等待人工完成（默认最多 8 分钟），完成后自动继续。调用方若无人值守，应设足够超时。

---

### `whoami` — 查看当前身份

```
node zhs.mjs whoami [--school X] [--student-id Y] [--password Z] [--real-name N]
```

| 项 | 说明 |
|---|---|
| 返回值 | 每个凭据字段的**实际取值与来源**（`cli` / `env` / 文件名）、平台返回的 `realName` 与 `uuid`、文档封面将显示的名字 |
| 退出码 | `0` 成功；`2` 未登录或浏览器不可用 |
| 副作用 | 连接浏览器查询登录态；**把平台真实姓名写回 `config/credentials.json`**；生成 `session/cookies.json` 与 `session/storage-state.json` |

用于排查"凭据到底从哪来的"，以及把平台真值同步到文档封面。

```
当前身份
凭据来源：credentials.json + password:env
  学校   示例大学        ← credentials.json
  学号   00000000000     ← credentials.json
  姓名   示例用户          ← credentials.json
  密码   L*********      ← env

  查询平台真实身份… ✓ 已登录：示例用户
    姓名 示例用户　uuid demo-uuid
✓ 已把真实姓名写回凭据库：realName = 示例用户
```

---

### `import` — 导入个人信息

```
node zhs.mjs import <文件.json> [--save-to <路径>] [--school X] [--student-id Y] [--real-name N] [--password Z]
node zhs.mjs import --prompt [--save-to <路径>] [字段覆盖参数]
```

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `<文件.json>` / `--from` | path | — | 来源文件；**字段名自动识别别名**，支持带 BOM 的 JSON |
| `--prompt` | 开关 | 关 | 交互式录入，密码不回显（TTY）；非 TTY 时按行读取，便于自动化 |
| `--save-to` | path | `config/credentials.json` | 写入目标 |
| `--school` / `--student-id` / `--real-name` / `--password` | string | — | 字段覆盖或补齐 |

| 项 | 说明 |
|---|---|
| 返回值 | 字段映射（`原字段名 → 标准字段`）、未识别的字段、写入结果与是否收紧权限 |
| 退出码 | `0` 成功；`1` 失败（读不到文件 / 归一后缺字段 / 交互录入被取消） |
| 副作用 | 写入凭据文件；尝试 `icacls` 收紧权限到仅当前用户 |

可识别的字段别名：`school` / `schoolName` / `university` / `college` / `学校` / `院校` / `学校名称` → `school`；`studentId` / `studentNo` / `sid` / `unid` / `userName` / `account` / `学号` / `账号` / `用户名` → `studentId`；`realName` / `name` / `nickName` / `姓名` → `realName`；`password` / `passwd` / `pwd` / `pass` / `secret` / `密码` → `password`。完整列表见 [`CREDENTIALS.md`](CREDENTIALS.md)。

```
$ node zhs.mjs import D:\other-system-export.json
✓ 导入成功 → K:\网页自动学习\config\credentials.json（权限已收紧）
  字段映射: 学校名称 → school，学号 → studentId，密码 → password
! 未识别字段（已忽略）: 备注
  写入字段: school, studentId, password
```

---

### `fetch` — 抓取题库

```
node zhs.mjs fetch [--course <课程名>] [--dry-run] [--browser <chromium|firefox>]
                   [--browser-exe <路径>] [--firefox-profile <目录>] [--firefox-port <端口>]
```

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--course` | string | 全部课程 | 只处理指定课程，名称需与平台一致 |
| `--dry-run` | 开关 | 关 | 只发现课程、不抓题；用于确认新课程能否识别 |
| `--browser` | enum | `chromium` | `chromium`（Chromium 系，CDP 接管）或 `firefox`（WebDriver BiDi 接管） |
| `--browser-exe` | path | — | 任意浏览器：直接指定可执行文件。文件名含 firefox → 走 BiDi，其余按 Chromium 走 CDP |
| `--firefox-profile` | path | `browser-profile-firefox` | 用指定 Firefox profile（可指向你平时已登录的那个，需先完全退出 Firefox） |
| `--firefox-port` | number | `9224` | Firefox 的 BiDi 调试端口 |

浏览器选择说明：

- **Chromium 系**（Edge / Chrome / Brave / Vivaldi / Opera / 360 / QQ / Chromium）会被自动发现并启动，接管后 `navigator.webdriver=false`，可以正常过网易易盾验证码。
- **Firefox** 走 WebDriver BiDi。首次使用需要在这个独立 profile 里**人工登录一次**；`navigator.webdriver` 由 preload script 改写成 `false`。

| 项 | 说明 |
|---|---|
| 产出文件 | `export/papers.json`（题库）、`export/courses-resolved.json`（考试入口缓存） |
| 退出码 | `0` 成功；`1` 有作业状态异常（见下）；`2` 未登录 |
| 副作用 | 启动/复用 Edge（CDP 端口 9222）并访问智慧树页面 |

**阶段**：会话校验 → 动态发现课程 → 解析考试入口 → 批量抓题 → 安全复查。

**安全保证**：只进入试卷读取内容，**绝不点击提交/暂存**；抓完复查每份作业的 `state/backNum/score`，异常会逐条报出并把退出码置为 `1`。

**进度观察**：抓题过程实时写 `export/pipeline.log`（标准输出在管道下会被缓冲），调用方若需进度可 tail 该文件。

**幂等性**：`papers.json` 按课程整段覆盖写入；`courses-resolved.json` 已有 `listRid` 的课程会跳过入口解析（想强制重解析就删掉该文件）。

---

### `docs` — 生成文档

```
node zhs.mjs docs [--formats <列表>] [--out <目录>]
```

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--formats` | 逗号分隔 | `md,md-bare,docx,pdf,xlsx` | 可选 `md`（打印版 MD）、`md-bare`（纯 MD）、`docx`、`pdf`（含预览 HTML）、`xlsx` |
| `--out` | 路径 | `export/` | 产物输出目录（读取仍从 `export/` 取数据） |

| 项 | 说明 |
|---|---|
| 前置条件 | `export/papers.json` 必须存在 |
| 产出文件 | 见下表 |
| 退出码 | `0` 成功；`1` 有格式失败（其余格式仍会完成） |
| 副作用 | 写文件；生成 PDF 时用无头 Edge 渲染本地 HTML（不访问网络） |

| `--formats` 值 | 产物 |
|---|---|
| `md` | `智慧树作业题库_打印版.md` |
| `md-bare` | `智慧树作业题库.md` |
| `docx` | `智慧树作业题库_打印版.docx` |
| `pdf` | `智慧树作业题库_打印版.pdf` + `智慧树作业题库_打印预览.html` |
| `xlsx` | `智慧树课程数据.xlsx`（需 `export/raw.json`，缺失则该项失败、其余不受影响） |

**各格式失败互不影响**：逐项报告 `✓ 完成` / `失败`，最后汇总失败项。

**账号信息注入**：文档封面显示的账号取自 `config/account-live.json` 的 `realName` + `school`；缺失时退回 `school + studentId`。

---

### `verify` — 校验产物

```
node zhs.mjs verify
```

| 项 | 说明 |
|---|---|
| 参数 | 无 |
| 返回值 | stdout 分三段：① 数据契约校验 ② 文档完整性 ③ 产物清单 |
| 退出码 | `0` 全部通过；`3` 任一不通过 |
| 副作用 | 无（只读） |

校验内容：

1. **数据契约**（`recon/validate-data.mjs`）：按 `docs/schemas/papers.schema.json` 校验结构，并做业务规则检查——未抓到试卷的作业、空试卷、**疑似已提交（`state≠1` / `backNum≠3` / `score≠null`）**、无选项的题目。
2. **文档完整性**（`recon/verify-md.mjs`）：从 `papers.json` 逐题逐选项回查 Markdown 正文，输出命中率（例如 `题目: 191/191 命中`）。
3. **产物清单**：各格式是否存在及大小。

---

### `solve` — AI 作答

```
node zhs.mjs solve [--mock] [--no-fill] [--input <md>] [--limit N] [--answer-out <md>]
                   [--config <json>] [--model X] [--base-url U] [--api-key K]
                   [--concurrency N] [--batch-size N]
```

把题库 Markdown 解析成题目，批量调用 OpenAI 兼容接口作答，默认产出**答案汇总**与**回填答案的题库**两份文件。解题逻辑复用 `md-ai-answer` 组件（以子进程调用），`zhs.mjs` 只负责串流程与传参。

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--mock` | 开关 | 关 | 离线试跑，**不调用任何 AI 接口**（用假答案走通全流程） |
| `--no-fill` | 开关 | 关 | 不产出「已回填答案的题库」副本（默认产出） |
| `--input` | path | `export/智慧树作业题库_打印版.md` | 题库来源 |
| `--limit` | number | — | 只作答前 N 题（试跑用） |
| `--answer-out` | path | `<input 同名>.answers.md` | 答案汇总文件路径。**不要用 `--out`**——它在本科里表示「产物输出目录」 |
| `--config` | path | `md-ai-answer/config.json` | AI 配置（相对工作区根解析） |
| `--model` / `--base-url` / `--api-key` | string | — | 临时覆盖 AI 配置（优先级最高） |
| `--concurrency` / `--batch-size` | number | `3` / `5` | 并发请求数 / 每批题目数 |

| 项 | 说明 |
|---|---|
| 前置条件 | 题库 Markdown 必须存在（先跑 `docs`）；真实作答还需配置 AI |
| 产出文件 | `export/智慧树作业题库_打印版.answers.md`（答案汇总 + 逐题解析）、`export/智慧树作业题库_打印版.answered.md`（回填版） |
| 退出码 | `0` 成功；`1` 未配置 AI 或作答失败 |
| 副作用 | 调用外部 AI 接口（可能产生费用）；写答案文件。**未配置 AI 时直接报错退出，不发起任何请求** |

**AI 配置来源**（任一即可，优先级：命令行 > 环境变量 > 配置文件）：

```powershell
# 方式一：配置文件
copy md-ai-answer\config.example.json md-ai-answer\config.json   # 填 baseUrl / apiKey / model

# 方式二：环境变量
$env:AI_BASE_URL="https://api.deepseek.com/v1"; $env:AI_API_KEY="sk-..."; $env:AI_MODEL="deepseek-chat"
```

> 密钥只存在于解题进程，不写进任何产物；`config.json` 与 `export/` 均已被 `.gitignore` 忽略。

**离线自测**（不需要密钥）：

```
node zhs.mjs solve --mock --limit 20
```

---

### `pad` — 对答案悬浮窗

```
node zhs.mjs pad [--test <png>]
```

常驻置顶的小窗（PowerShell + WinForms）。点「识别并作答」或按 `Alt+Q` 截取当前屏幕，交给 AI 找出**正在作答的那道题**并给出答案，供你自己核对。

| 项 | 说明 |
|---|---|
| 参数 | `--test <png>`：不开窗口，只识别指定图片并打印结果（自检用） |
| 交互 | `Alt+Q` 全局快捷键（窗口不在前台也能触发）或点按钮 |
| 前置条件 | 需配置 AI（`md-ai-answer/config.json` 或 `AI_*` 环境变量） |
| 退出码 | `0` 正常退出；`1` 缺脚本或启动失败 |
| 副作用 | 截屏并上传到 AI 接口（可能产生费用）；**不点击、不填写、不提交任何页面元素** |

> 边界说明：它只读屏幕、只显示答案，不代替你操作平台。答案不保证正确，请自行核对。
>
> 实现说明：本机 Electron 在受限环境里启动即崩（`0xC0000005`），因此改用 PowerShell + WinForms；
> 脚本以 UTF-8 **带 BOM** 保存（Windows PowerShell 5.1 解析中文的前提），
> 且 HTTP 用 `HttpWebRequest` 显式按 UTF-8 收发（`Invoke-RestMethod` 会把无 charset 的 JSON 按 Latin-1 解码，中文全乱）。

---

### `all` — 全流程

```
node zhs.mjs all [--course <名>] [--formats <列表>] [--out <目录>]
```

依次执行 `fetch` → `docs` → `verify` → `solve`，参数透传。

| 项 | 说明 |
|---|---|
| 退出码 | `0` 全部成功；`2` 未登录（立即中止）；其余取各阶段结果 |
| 副作用 | 同 `fetch` + `docs`；配置了 AI 时还会调用外部接口并写出答案文件 |

内部通过 `ZHS_SKIP_DOCS=1` 让 `fetch` 阶段跳过文档生成，保证文档只生成一次。

末端 `solve` 是**条件执行**：已配置 AI（环境变量 `AI_API_KEY` 或 `md-ai-answer/config.json`）或传了 `--mock` 才跑，否则打印一行提示后跳过——所以没配 AI 时 `all` 依然可用，不会失败。

**一条命令跑完整链路**（抓取 → 文档 → 校验 → 答案）：

```
node zhs.mjs all --mock     # 无密钥，离线走通全流程
```

---

## 典型调用序列

**首次部署**

```
doctor  →  login  →  all
```

**日常更新（有新作业/新课程时）**

```
all
```

**只刷新文档排版（数据没变）**

```
docs
```

**接入定时任务（无人值守）**

```
doctor            # 退出码非 0 则告警
all               # 退出码 2 → 会话过期，需人工 login；退出码 3 → 数据异常需检查
```

**只要数据不要文档**

```
fetch --dry-run   # 先确认课程列表
fetch             # 抓取（不生成文档）
```

**只要答案（题库已抓过、文档已生成）**

```
solve                   # 调 AI 作答，产出答案汇总 + 回填版
solve --limit 10        # 先拿 10 题试跑，确认模型答得对再全量
solve --mock            # 不花额度，走通流程
```

---

## 失败处理对照表

| 退出码 | 含义 | 处理 |
|---|---|---|
| `2` | 未登录 | 跑 `node zhs.mjs login`（可能需要人工过验证码） |
| `3` | 校验不通过 | 看 `verify` 输出：结构错误 → 数据被改坏；业务规则警告 → 有作业疑似已提交；文档不完整 → 重跑 `docs` |
| `1`（`solve`） | 未配置 AI 或作答失败 | 未配置 → 按 `solve` 提示填 `md-ai-answer/config.json` 或设 `AI_*` 环境变量；已配置但失败 → 看 stderr 里的接口报错（密钥 / 地址 / 余额） |
| `1`（`fetch`） | 有作业状态异常 | 看 `export/pipeline.log` 中标注的作业；通常意味着该作业已提交过 |
| `1`（`docs`） | 某格式生成失败 | 单独跑该格式看 stderr；`xlsx` 失败通常是缺 `export/raw.json` |
| `1`（`doctor`） | 环境不满足 | 按逐项提示修复（装依赖 / 补凭据 / 先 login） |
