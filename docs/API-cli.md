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

检查项：Node 版本、Python 文档库、Playwright 安装、浏览器运行时目录、可用浏览器（运行 `doctor` 的那台电脑现场探测到的结果与来源：常见路径 / 注册表 / PATH / Playwright / 系统安装）、凭据文件、浏览器登录资料（哪个浏览器的 profile 非空就报哪个）、题库数据。

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
✓ 导入成功 → <项目根目录>\config\credentials.json（权限已收紧）
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

**账号信息注入**：文档封面显示的名字走统一凭据解析（命令行 → 环境变量 → `--account` 文件 → `config/credentials.json` → 旧文件 `account-live.json`/`account.json`），取 `realName` + `school`；缺失时退回 `school + studentId`。

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

### `answer` — 全自动作业答题

```
node zhs.mjs answer [--dry] [--course <课程名>] [--exam <作业名>] [--limit N] [--no-submit]
                    [--delay <毫秒>] [--force] [--no-ai] [--no-rethink] [--no-redo]
                    [--attempts N] [--redo-wait <秒>] [--cross-check] [--min-confidence 0.7]
                    [--allow-uncertain] [--browser <chromium|firefox>] [--browser-exe <路径>]
```

逐份打开「未提交」作业 → 用题库匹配作答 → 暂存 → 提交。

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--dry` | 开关 | 关 | 演练：只列出目标作业，不操作页面 |
| `--course` | string | 全部课程 | 只处理名称包含该值的课程 |
| `--exam` | string | 全部作业 | 只处理指定作业/试卷 |
| `--limit` | number | `0` | 最多处理 N 份作业（`0` = 全部） |
| `--no-submit` | 开关 | 关 | 只作答并暂存，**不点提交** |
| `--delay` | number | `500` | 每题操作间隔毫秒（下限 `120`） |
| `--force` | 开关 | 关 | 存在跳过项时仍继续处理 |
| `--no-ai` | 开关 | 关 | 题库未命中时不调用 AI 兜底 |
| `--no-rethink` | 开关 | 关 | 关闭交卷后的错题复盘 |
| `--no-redo` | 开关 | 关 | 不自动重做错题 |
| `--attempts` | number | `2` | 错题重做最多轮数 |
| `--redo-wait` | number | `90` | 重做前等待秒数 |
| `--cross-check` | 开关 | 关 | AI 答案问两次做交叉验证；两次不一致或置信度低于门槛的题标记「存疑」 |
| `--min-confidence` | number | `0.7` | 交叉验证的置信度门槛（`0~1`），仅 `--cross-check` 时生效 |
| `--allow-uncertain` | 开关 | 关 | 存在存疑题时仍然提交（默认只作答不提交） |
| `--browser` | enum | `chromium` | 使用哪个浏览器 |
| `--browser-exe` | path | — | 直接指定浏览器可执行文件 |

| 项 | 说明 |
|---|---|
| 前置条件 | `export/papers.json` 与 `export/courses-resolved.json` 存在（先跑 `fetch`） |
| 产出文件 | `recon/apply/auto-answer-report.json`（逐份结果）、`recon/apply/submitted.json`（本地已提交台账，重复运行会跳过）；开启 `--cross-check` 且存在存疑题时另写 `recon/apply/uncertain-review.json` 与 `uncertain-review.md` |
| 退出码 | `0` 全部处理完成；`1` 存在未提交或异常的作业 |
| 副作用 | 启动/复用浏览器并**真实操作试卷页面**；默认会点提交；可能调用 AI 兜底接口；`--cross-check` 时每题调用两次 AI（费用翻倍） |

> **会写平台数据**：`--dry` 只演练，`--no-submit` 只答不交。首次使用建议先 `--dry` 确认目标，再用 `--limit 1 --no-submit` 小范围验证。

> **交叉验证**：`--cross-check` 会把同一道 AI 题问两次；两次答案不一致，或任一次返回的 `confidence` 低于 `--min-confidence`，即记为存疑。存疑题仍按第一次答案填页面，但**该份作业不会自动提交**，并在 `recon/apply/uncertain-review.md` 输出人工复核清单（含题库答案、页面作答、两次投票与原因）。确认无误后手动提交，或下次加 `--allow-uncertain` / `--force` 放行。

---

### `patrol` — 作业巡检

```
node zhs.mjs patrol [--course <课程名>] [--within 48] [--offline] [--no-notify]
                    [--webhook <url>] [--dry] [--browser <chromium|firefox>] [--browser-exe <路径>]
```

拉取最新作业列表，与上次快照对比，识别 **新作业 / 状态变化 / 临近截止**，并弹 Windows 通知。只读，绝不提交作业。

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--course` | string | 全部课程 | 只巡检名称包含该值的课程 |
| `--within` | number | `48` | 多少小时内截止的作业重点提醒 |
| `--offline` | 开关 | 关 | 不打开浏览器，只用本地 `papers.json` 出报告 |
| `--no-notify` | 开关 | 关 | 不弹 Windows 通知 |
| `--webhook` | string | — | 额外推送到飞书 / 企微 / 钉钉机器人（按域名自动适配消息格式） |
| `--dry` | 开关 | 关 | 只打印结果，不写报告与快照 |
| `--browser` | enum | `chromium` | 使用哪个浏览器 |
| `--browser-exe` | path | — | 直接指定浏览器可执行文件 |

| 项 | 说明 |
|---|---|
| 前置条件 | `export/courses-resolved.json` 存在（先跑 `fetch`）；`--offline` 时只需 `papers.json` |
| 产出文件 | `export/patrol-report.json`（本次结果）、`export/patrol-state.json`（历史快照，删除后下次重建基线） |
| 退出码 | `0` 正常；`1` 有课程未取到列表；`2` 未登录 |
| 副作用 | 启动/复用浏览器读取作业列表；弹通知或请求 Webhook；可能更新 `papers.json` 的状态字段 |

首次运行只建立基线，不把存量作业全部报成「新作业」；截止提醒每天最多一次。

非 `--dry` 的巡检结束时会自动刷新 `export/deadline-board.html`，无需再单独跑 `deadline`。

---

### `deadline` — 截止看板

```
node zhs.mjs deadline [--course <课程名>] [--out <目录>] [--open]
```

把本地 `papers.json` + `courses-resolved.json` 渲染成一份自包含 HTML：按「已过期 / 24 小时内 / 1–3 天 / 3–7 天 / 7 天以上 / 无截止」分组展示未提交作业，支持搜索、课程筛选与状态切换。只读本地数据，不启动浏览器、不访问网络、不提交作业。

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--course` | string | 全部课程 | 只看名称包含该值的课程 |
| `--out` | path | `export/` | 产物输出目录（文件名固定为 `deadline-board.html`） |
| `--open` | 开关 | 关 | 生成后用默认浏览器打开 |

| 项 | 说明 |
|---|---|
| 前置条件 | `export/papers.json` 存在（先跑 `fetch`）；`courses-resolved.json` 用于生成「去作答」链接，缺失时链接为空 |
| 产出文件 | `export/deadline-board.html` |
| 退出码 | `0` 成功；`1` 读取数据失败 |
| 副作用 | 只读本地 JSON，写单个 HTML 文件；`--open` 会拉起默认浏览器 |

看板顶部显示数据更新时间与最近巡检时间；没有巡检记录、或最近一次巡检超过 24 小时时会显示过期提示。页内数据通过 JSON 注入并逐字段 `textContent` 渲染，作业名里的特殊字符不会破坏页面。

---

### `schedule` — 定时巡检

```
node zhs.mjs schedule [show|install|remove] [--time 08:00] [--name ZHS-Patrol] [--webhook <url>]
```

用 Windows 计划任务（`schtasks`）每天自动执行 `patrol`。

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `<动作>` | enum | `show` | `show` 查看 / `install` 安装 / `remove` 删除 |
| `--time` | string | `08:00` | `install` 时的每日执行时间（`HH:MM`） |
| `--name` | string | `ZHS-Patrol` | 计划任务名 |
| `--webhook` | string | — | `install` 时把 Webhook 地址写进巡检命令 |

| 项 | 说明 |
|---|---|
| 产出 | 无本地文件；`show` 打印下次运行时间、上次结果与实际执行的命令 |
| 退出码 | `0` 成功；`1` 创建/删除失败或任务不存在 |
| 副作用 | 创建或删除 Windows 计划任务（仅 Windows） |

安装后想立刻验证，可执行 `schtasks /Run /TN "ZHS-Patrol"`。

---

### `catalog` — 课程目录扫描

```
node zhs.mjs catalog [--course <课程名>] [--watch <编号>] [--json] [--no-pick]
                     [watch 的参数]
```

逐课打开视频页，扫描章节与课节（标题、时长、是否已完成），保存目录并支持选择某一节自动观看。

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--course` | string | 全部课程 | 只扫描名称包含该值的课程 |
| `--watch` | string | — | 扫描后直接自动完成指定课节（如 `1.3`；多门课同编号时写 `心理健康 1.3`） |
| `--json` | 开关 | 关 | 只输出目录 JSON（同时写入 `export/course-catalog.json`） |
| `--no-pick` | 开关 | 关 | 扫描完不进入交互选择 |
| 其余 | — | — | `--rate` / `--minutes` / `--face-wait` / `--no-ai` / `--browser` 等透传给 `watch` |

| 项 | 说明 |
|---|---|
| 前置条件 | `export/courses-resolved.json` 存在（先跑 `fetch`），且浏览器已登录 |
| 产出文件 | `export/course-catalog.json`（章节 / 课节 / 时长 / `isStudiedLesson` 完成状态） |
| 交互 | TTY 下扫描完成后提示输入课节编号；直接回车退出 |
| 退出码 | `0` 成功；`1` 扫描失败或课节无法定位 |

> 完成状态来自视频页自身发出的 `learning/videolist` 响应（`isStudiedLesson === 1`）；
> 未捕获到该响应时回退读取 DOM `li.video`，此时完成状态显示为 `?`。

---

### `watch` — 全自动看课

```
node zhs.mjs watch [--dry] [--course <课程名>] [--lesson <课节>] [--from <课节>] [--max N]
                   [--minutes N] [--rate 1.5] [--face-wait N] [--no-ai] [--no-tidy]
                   [--browser <chromium|firefox>] [--browser-exe <路径>]
```

真实鼠标/播放器交互播放课程视频，按题库或 AI 自动处理弹题。

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--dry` | 开关 | 关 | 演练：只列出课程与课节，不播放 |
| `--course` | string | 全部课程 | 只处理名称包含该值的课程 |
| `--lesson` | string | 全部课节 | 只处理指定课节：优先按编号精确匹配（如 `1.3`），否则按「序号 + 标题」包含匹配 |
| `--from` | string | — | 从匹配的课节开始（含该节） |
| `--max` | number | `0` | 每门课最多播放 N 节（`0` = 全部） |
| `--minutes` | number | `0` | 总时长上限（分钟，`0` = 不限） |
| `--rate` | number | `1.5` | 播放倍速，自动夹到 `1.0~1.5` |
| `--face-wait` | number | `15` | 等待人工完成人脸识别的分钟数 |
| `--no-ai` | 开关 | 关 | 弹题未命中题库时不调用 AI 兜底 |
| `--no-tidy` | 开关 | 关 | 结束后不整理/关闭多余标签页 |
| `--browser` | enum | `chromium` | 使用哪个浏览器 |
| `--browser-exe` | path | — | 直接指定浏览器可执行文件 |

| 项 | 说明 |
|---|---|
| 前置条件 | `export/courses-resolved.json` 存在（先跑 `fetch`） |
| 产出文件 | `recon/apply/watch-report.json`（逐课程/课节结果） |
| 退出码 | `0` 全部完成（`--minutes` 主动收手不算失败）；`1` 有课节未完成或课程异常 |
| 副作用 | 启动/复用浏览器并真实播放视频；可能停在页面等待人工完成人脸识别（默认最多 15 分钟）；可能调用 AI 兜底接口 |

> 脚本直接调用 `play()` 或修改倍速会被平台风控，因此本命令用真实交互播放；播放中若出现脚本告警会立即停止该课节。

---

### `auto` — 答题 + 看课

```
node zhs.mjs auto [answer 的参数] [watch 的参数]
```

依次执行 `answer` → `watch`。同名参数对两个阶段都生效（如 `--dry`、`--course`、`--no-ai`）。

| 项 | 说明 |
|---|---|
| 产出文件 | 同 `answer` + `watch` |
| 退出码 | `0` 两阶段都成功；`1` 任一阶段失败（**看课阶段的结果优先**） |
| 副作用 | 同 `answer` + `watch`；**答题阶段失败不会中断看课** |

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

**日常巡检（不提交作业）**

```
patrol                   # 开浏览器拉最新列表，有变化弹通知
patrol --offline         # 不联网，只看本地数据
patrol --within 24       # 只重点提醒 24 小时内截止的作业
schedule install --time 08:00   # 每天 08:00 自动巡检
schedule show                   # 查看下次运行时间与上次结果
```

**查看作业截止看板**

```
deadline                        # 用本地数据生成 export/deadline-board.html
deadline --open                 # 生成后直接打开浏览器
deadline --course 国家安全       # 只看某一门课
patrol                          # 巡检结束会自动刷新看板
```

**答题 + 交叉验证**

```
answer --limit 1 --no-submit --cross-check          # 先小范围试跑，看复核清单
answer --cross-check --min-confidence 0.8           # 正式跑，低置信度题不提交
answer --cross-check --allow-uncertain              # 接受存疑题直接提交
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
