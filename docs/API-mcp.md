# MCP 接口：让 AI 直接操控本工具

本工具**不内嵌浏览器**，所以除了命令行和 JS 调用之外，额外提供了一个 **MCP（Model Context Protocol）服务器**：
AI 客户端（Trae / Claude Desktop / Cursor 等）把本工具当成一组工具来调用，登录、抓题、生成文档、AI 作答、答题、看课都能由 AI 自己按顺序完成。

- 传输：**stdio**（一行一条 JSON-RPC 2.0 消息）
- 入口：`mcp-server.mjs`（零依赖，只用 Node 内置模块）
- 启动器：`mcp.cmd`（Windows，自动定位 node 与浏览器目录）
- 底层：所有工具最终都调用 `node zhs.mjs <command>`，与手动执行完全等价

---

## 1. 前置条件

```powershell
node --version        # 需要 >= 20
npm install           # 首次使用，安装 playwright
run.cmd doctor        # 确认环境、浏览器、凭据、数据都就绪
```

`mcp-server.mjs` 会自动设置 `PLAYWRIGHT_BROWSERS_PATH` 为工作区下的 `ms-playwright`，一般不需要额外配置。
如果在别的机器上浏览器装在别处，可在客户端配置里显式传这个环境变量。

---

## 2. 客户端配置

### Trae

设置 → MCP → 添加服务器（stdio），命令填：

```
d:\代码\网页自动学习\mcp.cmd
```

或使用 JSON 配置：

```json
{
  "mcpServers": {
    "zhihuishu": {
      "command": "d:\\代码\\网页自动学习\\mcp.cmd",
      "args": []
    }
  }
}
```

### Claude Desktop

编辑 `%APPDATA%\Claude\claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "zhihuishu": {
      "command": "node",
      "args": ["d:\\代码\\网页自动学习\\mcp-server.mjs"],
      "env": {
        "PLAYWRIGHT_BROWSERS_PATH": "d:\\代码\\网页自动学习\\ms-playwright"
      }
    }
  }
}
```

改完完全退出 Claude Desktop 再启动。

### Cursor

项目内 `.cursor/mcp.json`（或全局 MCP 设置）使用同样的结构：

```json
{
  "mcpServers": {
    "zhihuishu": {
      "command": "node",
      "args": ["d:\\代码\\网页自动学习\\mcp-server.mjs"]
    }
  }
}
```

### 通用说明

- 不需要设置工作目录：服务器按自身文件位置定位 `zhs.mjs`。
- `command` 用 `mcp.cmd` 时，由启动器负责找 node；用 `node` 时要求 node 在客户端的 PATH 里。
- **stdout 只能走 MCP 协议**。如果自定义启动脚本，千万不要 `echo` 任何内容到 stdout，否则握手会失败。
- 多个客户端不要同时开同一个账号的登录/答题任务，浏览器会话会互相干扰。

### 手动验证服务器是否正常

```powershell
'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"cli","version":"1.0"}}}' | node mcp-server.mjs
```

应输出一行 `protocolVersion` / `serverInfo` 的 JSON；日志在 stderr，不会污染协议。

---

## 3. 工具清单

| 工具 | 执行方式 | 是否写平台数据 | 用途 |
|---|---|---|---|
| `zhs_status` | 同步 | 否 | 账号、题库规模、产物大小与时间 |
| `zhs_doctor` | 同步 | 否 | 环境自检（Node / Python / Playwright / 浏览器 / 凭据 / 数据） |
| `zhs_verify` | 同步 | 否 | 校验 `papers.json`、文档逐题回查、产物清单 |
| `zhs_whoami` | 同步 | 否 | 凭据来源 + 平台真实身份（需要浏览器） |
| `zhs_import` | 同步 | 否 | 写入本机凭据文件 |
| `zhs_login` | 后台任务 | 否（会建会话） | 登录并固化会话 |
| `zhs_fetch` | 后台任务 | 否（只读试卷） | 抓取题库 |
| `zhs_docs` | 后台任务 | 否 | 由 `papers.json` 生成 Markdown / Word / PDF / Excel |
| `zhs_solve` | 后台任务 | 否（消耗 AI 接口费用） | AI 作答，产出答案汇总与回填版 |
| `zhs_answer` | 后台任务 | **是**（默认真提交） | 自动答题；需 `confirm=true`；可开交叉验证 |
| `zhs_patrol` | 后台任务 | 否（只读列表） | 作业巡检：新作业 / 状态变化 / 临近截止 + 通知 |
| `zhs_deadline` | 同步 | 否 | 截止看板：用本地数据生成可离线打开的 HTML，巡检后自动刷新 |
| `zhs_schedule` | 同步 | 否 | 定时巡检：安装 / 移除 / 查看 Windows 计划任务 |
| `zhs_watch` | 后台任务 | **是**（真实播放） | 自动看课；需 `confirm=true` |
| `zhs_auto` | 后台任务 | **是** | 答题 + 看课；需 `confirm=true` |
| `zhs_all` | 后台任务 | 否 | 抓题 → 文档 → 校验 → AI 作答（未配置 AI 自动跳过） |
| `zhs_job` | 同步 | 否 | 跟进后台任务：`status` / `logs` / `wait` / `list` / `cancel` |

完整参数（类型、枚举、默认值）以 `tools/list` 返回的 `inputSchema` 为准；对应的命令行参数见 [`API-cli.md`](API-cli.md)。

### 常用参数速查

| 工具 | 关键参数 |
|---|---|
| `zhs_import` | `school`、`studentId`、`password`、`realName`、`from`（JSON 文件）、`saveTo` |
| `zhs_login` | `restartCheck`、`account`、`school/studentId/password`（临时覆盖）、`browser`、`browserExe`、`firefoxProfile` |
| `zhs_fetch` | `course`、`dryRun`、浏览器参数 |
| `zhs_docs` | `formats`（`md,md-bare,docx,pdf,xlsx`）、`out` |
| `zhs_solve` | `mock`、`noFill`、`limit`、`input`、`answerOut`、`config`、`model`、`baseUrl`、`apiKey`、`concurrency`、`batchSize` |
| `zhs_answer` | `confirm`、`dry`、`course`、`exam`、`limit`、`noSubmit`、`delay`、`force`、`noAi`、错题复盘相关参数、`crossCheck`、`minConfidence`、`allowUncertain` |
| `zhs_patrol` | `course`、`within`（默认 48）、`offline`、`noNotify`、`webhook`、`dry`、浏览器参数 |
| `zhs_deadline` | `course`、`out`（输出目录）、`open`（生成后打开浏览器） |
| `zhs_schedule` | `action`（`show`/`install`/`remove`）、`name`、`time`、`webhook` |
| `zhs_watch` | `confirm`、`dry`、`course`、`lesson`、`from`、`max`、`minutes`、`rate`、`faceWait`、`noAi` |
| `zhs_auto` | `confirm`、`dry`、`course`、`limit`、`noSubmit`、`crossCheck`、`minConfidence`、`allowUncertain`、`max`、`minutes`、`rate`、`faceWait` |
| `zhs_all` | `course`、`formats`、`out`、`mock` |
| `zhs_job` | `action`、`id`、`tailLines`、`waitSeconds`（上限 50） |

---

## 4. 后台任务

登录、抓题、巡检、答题、看课可能持续几分钟到几十分钟，同步调用会被客户端超时掐断，因此这些工具**立即返回 `jobId`**：

```text
jobId: job-3
命令: node zhs.mjs login
下一步：zhs_job(action=wait, id=job-3) 等待，或 zhs_job(action=logs, id=job-3) 查看输出。
```

跟进方式：

| 调用 | 作用 |
|---|---|
| `zhs_job(action=wait, id=job-3)` | 最多等 50 秒，返回最新输出；没结束就再调一次 |
| `zhs_job(action=status, id=job-3)` | 当前状态 + 最后 40 行输出 |
| `zhs_job(action=logs, id=job-3, tailLines=200)` | 查看更多日志 |
| `zhs_job(action=list)` | 列出本次会话的所有任务 |
| `zhs_job(action=cancel, id=job-3)` | 终止任务及其子进程（Windows 用 `taskkill /T /F`） |

任务状态：`running` / `completed` / `failed` / `canceled`。
任务只存在于**当前服务器进程内存**里：AI 客户端重启后 `jobId` 失效，需要重新发起；已经写入 `export/` 的产物不受影响。

---

## 5. AI 的推荐调用顺序

```text
zhs_status
  → zhs_doctor
  → zhs_import（首次，或凭据有变化）
  → zhs_login            （后台；提示用户处理验证码）
  → zhs_fetch            （后台；可先 dryRun=true 确认课程）
  → zhs_docs             （后台）
  → zhs_verify
  → zhs_solve            （后台；可先 mock=true 离线试跑）
  → zhs_patrol           （后台；只读巡检，可离线 offline=true）
  → zhs_deadline         （同步；生成截止看板，巡检后已自动刷新，可省略）
  → zhs_answer           （需 confirm=true；先 dry=true，再 limit=1 + noSubmit=true）
  → zhs_watch            （需 confirm=true；先 dry=true）
```

日常可让 `zhs_schedule(action=install, time="08:00")` 装上每日巡检，AI 只需在用户询问时调 `zhs_patrol` 或读 `export/patrol-report.json`；用户想直观查看剩余作业时，调 `zhs_deadline` 生成 `export/deadline-board.html`（`patrol` 非 `dry` 结束后会自动刷新一次）。

要点：

- 任何一步失败，先看输出里的退出码：`1` 环境/执行错误，`2` 未登录，`3` 校验不通过。
- `zhs_fetch` 全程只读试卷，不会提交作业；可以放心重复执行。
- 答题前建议先跑 `zhs_verify`，确认题库与文档一致。

---

## 6. 安全约定

1. **破坏性操作必须确认**
   `zhs_answer` / `zhs_watch` / `zhs_auto` 不传 `confirm=true` 会直接拒绝执行，并提示 AI 先向用户说明并获得同意。这是服务器侧的硬性保护，不是提示词。

2. **先演练，再小范围**
   - `dry=true`：只列目标，不操作页面；
   - `limit=1` + `noSubmit=true`：只处理一份且不提交；
   - 确认无误后再去掉限制。

3. **答案存疑不提交**
   `zhs_answer` 带 `crossCheck=true` 时，同一道 AI 题会问两次；答案不一致或置信度低于 `minConfidence`（默认 0.7）的题记为存疑，**该份作业只作答不提交**，复核清单写到 `recon/apply/uncertain-review.md`。AI 应先请用户核对清单，再决定是否加 `allowUncertain=true` 提交。

4. **密码与密钥**
   - `zhs_import` 的字段模式会把密码通过 stdin 管道传给子进程，**不会**写到命令行；
   - 但工具参数本身会出现在 AI 客户端的会话/日志里。更安全的做法是：让用户自己运行 `run.cmd import --prompt`，或用 `from` 指向本机 JSON 文件，AI 只传路径；
   - `zhs_solve` 的 `apiKey` 参数只在本次进程内使用，不落盘；日常建议在 `md-ai-answer/config.json` 或环境变量里配置；
   - 服务器日志会把 `password`、`apiKey` 打码。

5. **人工环节**
   - 登录验证码、看课中的人脸识别无法自动完成。AI 应提示用户接管浏览器，`zhs_login` 最多等待 8 分钟；
   - 不要为了跳过人工环节反复重启任务。

6. **并发**
   同一账号同一时间只跑一个会操作浏览器的任务；不同任务共享 `export/` 与登录会话。

---

## 7. 故障排查

| 现象 | 原因与处理 |
|---|---|
| 客户端提示 server 启动失败 | 先手动跑 `mcp.cmd`（或 `node mcp-server.mjs`）看 stderr；确认 `node --version` >= 20 |
| 握手失败 / 解析错误 | 启动脚本往 stdout 打印了内容。MCP 要求 stdout 只有 JSON-RPC，日志必须走 stderr |
| `node` 找不到 | 客户端不继承终端 PATH。改用 `mcp.cmd`，或在配置里写 node 的绝对路径 |
| 浏览器启动失败 | 跑 `zhs_doctor`；确认 `ms-playwright` 存在，或在客户端 `env` 里指定 `PLAYWRIGHT_BROWSERS_PATH` |
| 返回退出码 2 | 未登录：调用 `zhs_login` 后重试 |
| 登录一直不结束 | 浏览器里有验证码/协议弹窗等待人工处理；让用户完成后用 `zhs_job` 继续跟进 |
| `zhs_job` 找不到任务 | 服务器进程重启过，`jobId` 已失效；重新发起任务 |
| 中文路径异常 | 配置里用绝对路径；JSON 中反斜杠写成 `\\`，或统一用 `/` |
| 任务卡住想中止 | `zhs_job(action=cancel, id=...)`；关闭 AI 客户端也会终止所有运行中任务 |

---

## 8. 与其它接口的关系

| 方式 | 适合 |
|---|---|
| MCP（本文档） | AI 客户端直接操控，自动串联多步流程 |
| [`API-cli.md`](API-cli.md) | 脚本、定时任务、CI，自己拼命令 |
| [`API-node.md`](API-node.md) | 在 JS 里复用浏览器与登录逻辑 |
| [`tools.json`](tools.json) | 程序化工具发现 |

MCP 服务器只是薄封装：它把参数翻译成命令行，再把 stdout / stderr / 退出码整理成文本返回。所以 CLI 的行为、退出码、安全边界在这里完全一致。
