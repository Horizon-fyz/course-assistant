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
- **幂等**：所有命令可重复执行。`docs` / `verify` / `status` / `doctor` 不访问网络。
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
node zhs.mjs login [--restart-check]
```

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--restart-check` | 开关 | 关 | 登录后关闭浏览器再重启，验证会话是否存活 |

| 项 | 说明 |
|---|---|
| 返回值 | stdout 文本：登录结果（`realName`）、关键票据清单、重启后是否仍登录 |
| 退出码 | `0` 成功；`2` 未登录成功；`3` 重启后会话丢失 |
| 副作用 | 启动 Edge 并操作登录页表单；**会写浏览器资料目录** |

> **阻塞式交互**：若出现网易易盾人机验证，脚本会停在验证页并等待人工完成（默认最多 8 分钟），完成后自动继续。调用方若无人值守，应设足够超时。

---

### `fetch` — 抓取题库

```
node zhs.mjs fetch [--course <课程名>] [--dry-run] [--browser <chromium|firefox>]
```

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--course` | string | 全部课程 | 只处理指定课程，名称需与平台一致 |
| `--dry-run` | 开关 | 关 | 只发现课程、不抓题；用于确认新课程能否识别 |
| `--browser` | enum | `chromium` | `chromium`（Edge/Chrome，CDP 接管）或 `firefox`（当前环境不可用，见限制） |

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

### `all` — 全流程

```
node zhs.mjs all [--course <名>] [--formats <列表>] [--out <目录>]
```

依次执行 `fetch` → `docs` → `verify`，参数透传。

| 项 | 说明 |
|---|---|
| 退出码 | `0` 全部成功；`2` 未登录（立即中止）；其余取各阶段结果 |
| 副作用 | 同 `fetch` + `docs` |

内部通过 `ZHS_SKIP_DOCS=1` 让 `fetch` 阶段跳过文档生成，保证文档只生成一次。

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

---

## 失败处理对照表

| 退出码 | 含义 | 处理 |
|---|---|---|
| `2` | 未登录 | 跑 `node zhs.mjs login`（可能需要人工过验证码） |
| `3` | 校验不通过 | 看 `verify` 输出：结构错误 → 数据被改坏；业务规则警告 → 有作业疑似已提交；文档不完整 → 重跑 `docs` |
| `1`（`fetch`） | 有作业状态异常 | 看 `export/pipeline.log` 中标注的作业；通常意味着该作业已提交过 |
| `1`（`docs`） | 某格式生成失败 | 单独跑该格式看 stderr；`xlsx` 失败通常是缺 `export/raw.json` |
| `1`（`doctor`） | 环境不满足 | 按逐项提示修复（装依赖 / 补凭据 / 先 login） |
