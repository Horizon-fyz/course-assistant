# md-ai-answer

> 识别 Markdown 题库 → 调用 AI（OpenAI 兼容接口）批量作答 → 生成答案文件 / 回填题库。

本项目是「更大的自动学习程序」中的一个**组件**，采用 **后端服务 + 多端客户端** 架构：

- **后端服务**（本机运行）负责解析、调用 AI、渲染结果、保管密钥；
- **客户端**（浏览器页面 / Electron 桌面 / 将来的浏览器插件 / 安卓）只调用后端 HTTP API；
- **核心逻辑**（`parser / ai / answer / render / config`）是无副作用的纯模块，后端与库调用共用。

> 密钥只存在后端；前端不直接调用 AI，也不持有密钥。

---

## 1. 它能做什么

1. 解析 Markdown 题库（题号 / 题型 / 选项）；
2. 按批次并发调用 OpenAI 兼容接口作答；
3. 产出两类结果：
   - `xxx.answers.md`：答案汇总（速查 + 逐题详解）；
   - `xxx.answered.md`：回填答案的题库副本。

半自动定位：只给答案，不做网页操作、不自动提交。

---

## 2. 架构与分层

```
┌──────────────────────── 客户端层 ────────────────────────┐
│  浏览器页面(app/)   Electron 桌面   (将来)插件 / 安卓     │
│  只调 HTTP API，不碰 AI、不持密钥                          │
└───────────────────────────┬──────────────────────────────┘
                            │  HTTP  /api/*
┌───────────────────────────▼──────────────────────────────┐
│                  后端服务  server/index.mjs                │
│  同时托管静态页面（同源免 CORS）；保管密钥；SSE 推进度       │
│  GET  /api/health  GET  /api/config                        │
│  POST /api/parse   POST /api/answer   POST /api/render     │
└───────────────────────────┬──────────────────────────────┘
                            │  直接 import
┌───────────────────────────▼──────────────────────────────┐
│                   核心层（可移植、无副作用）                │
│  parser.mjs  文本 → 结构化题目                             │
│  answer.mjs  题目 → 批量并发编排 → 答案表                  │
│  render.mjs  题目+答案 → Markdown                          │
│  ai.mjs      OpenAI 兼容客户端（可注入 fetch）              │
│  config.mjs  配置合并 / 校验                               │
│  index.mjs   库出口（供其它 Node 程序 import）              │
└──────────────────────────────────────────────────────────┘
```

分层原则（改代码时请遵守）：

| 原则 | 说明 |
|---|---|
| **无副作用** | 除 `server/index.mjs`（直接运行分支）与 `cli.mjs`（执行守卫）外，import 不产生动作 |
| **纯核心** | `parser / render` 纯函数；`ai / answer` 工厂/注入式，无模块级可变状态 |
| **单一职责** | 解析 / 调用 / 编排 / 渲染 / 配置 / 传输各管一摊 |
| **依赖注入** | AI 客户端、`fetch`、hooks、AbortSignal 均可从外部传入 |
| **密钥隔离** | apiKey 只在后端；`/api/config` 只回 `hasApiKey` 布尔值 |

---

## 3. 环境要求

- Node.js ≥ 18（本机 v24）。运行时零第三方依赖（原生 `fetch`）。
- 桌面版需 Electron（devDependency，`npm install` 时安装）。

---

## 4. 三种运行方式

### 方式 A：命令行（单机批处理，无需后端）

```bash
node src/cli.mjs --input 题库.md --mock --fill      # 离线自测
copy config.example.json config.json                 # 填 baseUrl/apiKey/model
node src/cli.mjs --input 题库.md --fill
```

### 方式 B：本机后端 + 浏览器页面（推荐日常使用）

```bash
npm run serve            # 启动后端，默认 http://127.0.0.1:8787/
# 浏览器打开 http://127.0.0.1:8787/app/
```

页面与 API 同源，无 CORS 问题；密钥由后端 `config.json` / 环境变量提供。

### 方式 C：Electron 桌面版

```bash
npm run app              # 进程内启动后端 + 打开桌面窗口
```

桌面版**内嵌**同一套后端服务（随机端口、仅 127.0.0.1），并额外提供原生文件对话框。

> 端口/主机可用环境变量覆盖：`PORT`、`HOST`（如 `HOST=0.0.0.0` 供局域网访问，谨慎使用）。

---

## 5. 后端 API

| 方法 | 路径 | 请求体 | 返回 |
|---|---|---|---|
| GET | `/api/health` | — | `{ ok, hasApiKey, model }` |
| GET | `/api/config` | — | `{ ok, config: { baseUrl, model, concurrency, batchSize, hasApiKey } }`（**不含密钥**） |
| POST | `/api/parse` | `{ markdown }` | `{ ok, questions }` |
| POST | `/api/answer` | `{ questions \| markdown, config?, mock? }` | 非流式：`{ ok, answers }`；流式见下 |
| POST | `/api/render` | `{ questions, answers, sourceText?, format?: 'answers'\|'filled', meta? }` | `{ ok, markdown }` |

**`answers` 结构**：对象，键为题目 id（字符串），值为 `{ answer, reason, confidence }`。

**流式进度（SSE）**：请求 `/api/answer?stream=1`（或带 `Accept: text/event-stream`），返回事件流：

```
event: progress
data: {"loaded":5,"total":10}

event: error
data: {"message":"...","numbers":["3"]}

event: done
data: {"answers":{"1":{"answer":"A",...}, ...}}
```

示例：

```bash
curl -s http://127.0.0.1:8787/api/health
curl -s -X POST http://127.0.0.1:8787/api/parse -H "Content-Type: application/json" ^
  -d "{\"markdown\":\"1. 1+1=?\\nA. 1\\nB. 2\"}"
```

**密钥策略（两者都支持）**：后端配置为底，请求体里的 `config.apiKey` 若提供则覆盖（仅该次请求）。
前端默认留空即用后端密钥。

---

## 6. 作为库集成（Node 程序直接 import）

```js
import { parseQuestionBank, answerQuestions, createClient, renderAnswerMarkdown } from 'md-ai-answer';

const questions = parseQuestionBank(mdText);
const answers = await answerQuestions({
  questions,
  config: { baseUrl, apiKey, model, concurrency: 3, batchSize: 5 },
  client: myCustomClient,               // 可选：注入自定义客户端/缓存/代理
  hooks: { onProgress: (l, t) => console.log(l, t) },
  signal: abortController.signal,
});
const md = renderAnswerMarkdown({ questions, answers, meta: { model } });
```

也可只依赖后端 HTTP：任何语言/平台只要能发 HTTP，就能用这套能力（插件、安卓同此）。

| 模块 | 主要导出 |
|---|---|
| `parser` | `parseQuestionBank` / `formatQuestionForPrompt` / `detectQuestionType` / `TYPE_LABELS` |
| `ai` | `createClient(config, {fetch?})` / `extractJson` / `AIRequestError` |
| `answer` | `answerQuestions` / `buildMessages` / `normalizeAnswerItem` / `mockAnswer` / `chunk` / `mapPool` |
| `render` | `renderAnswerMarkdown` / `renderFilledMarkdown` |
| `config` | `DEFAULT_CONFIG` / `mergeConfig` / `validateConfig` / `resolveConfig` |
| `server` | `createServer({host, port, configFile})` → `{ start, stop }`（可内嵌进宿主进程） |

运行示例：[examples/library-usage.mjs](examples/library-usage.mjs)（`npm run example:lib`）。

---

## 7. 配置（config.json / 环境变量）

```json
{
  "baseUrl": "https://api.deepseek.com/v1",
  "apiKey": "sk-你的key",
  "model": "deepseek-chat",
  "temperature": 0.2,
  "timeoutMs": 60000,
  "maxRetries": 3,
  "concurrency": 3,
  "batchSize": 5,
  "systemPrompt": "你是一名严谨的答题助手。"
}
```

优先级：**默认值 < config.json < 环境变量(`AI_BASE_URL/AI_API_KEY/AI_MODEL`) < 命令行/请求体覆盖**。

常见兼容服务 `baseUrl`：

| 服务 | baseUrl |
|---|---|
| DeepSeek | `https://api.deepseek.com/v1` |
| 阿里通义（DashScope 兼容模式） | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| 硅基流动 SiliconFlow | `https://api.siliconflow.cn/v1` |
| 本地 Ollama | `http://localhost:11434/v1` |

---

## 8. 题库 Markdown 格式

```markdown
# 课程名题库

## 单选题

1. 下列哪一项不是 HTTP 请求方法？
A. GET
B. POST
C. FETCH
D. DELETE

## 多选题

2. 下列属于关系型数据库的有？
A. MySQL
B. PostgreSQL
C. Redis
D. Oracle

## 判断题

3. HTTP 是一种无状态协议。
A. 正确
B. 错误
```

识别规则：

- **题号**：行首数字 + `.` `、` `)` `）`，允许 `### 1. xxx` 形式。
- **选项**：行首单个字母 + 上述分隔符。
- **题型**：优先看小节标题（单选/多选/判断/填空/简答）；无标题时按选项特征推断。
- **原卷答案**：含 `答案：X` 行会被保留为「原卷标注」便于核对。

---

## 9. 项目结构

```
md-ai-answer/
├─ package.json            # main/exports 已配置，可作包 import
├─ config.example.json
├─ README.md
├─ examples/
│  ├─ sample-bank.md       # 示例题库
│  └─ library-usage.mjs    # 作为库使用（含依赖注入）
├─ app/                    # 前端（客户端）：index.html / app.js / styles.css
├─ electron/               # 桌面壳：main.mjs（内嵌后端）+ preload.cjs（原生对话框）
├─ server/
│  └─ index.mjs            # 后端服务：HTTP API + 静态托管
└─ src/                    # 核心层（可移植、无副作用）
   ├─ index.mjs            # 库出口
   ├─ parser.mjs  ai.mjs  answer.mjs  render.mjs  config.mjs
   └─ cli.mjs              # 命令行外壳
```

---

## 10. 多端落地路线图

> **技术栈决策（已定）**：继续使用 **JS 技术栈**，不采用 Flutter（需覆盖浏览器插件，而 Flutter 无可行 MV3 方案）。

| 阶段 | 形态 | 方案 | 状态 |
|---|---|---|---|
| v1 | 命令行 | Node 脚本 | ✅ 已完成 |
| v2 | 后端服务 + 浏览器页面 | `server/index.mjs` 提供 API 与页面 | ✅ 已完成 |
| v2 | Windows 桌面软件 | Electron 内嵌后端 + 原生对话框 | ✅ 代码完成，启动待环境确认 |
| v3 | 浏览器插件 | MV3：读页面题目 → 调本机后端 `/api/*`（后端已放行扩展来源） | 待做 |
| v4 | 安卓 App | Capacitor 承载同一套前端，连本机后端 | 待做 |

本机环境（2026-10-10 探测）：Node v24 ✅、Java ✅、Android SDK（`C:\Android\Sdk`）✅、Rust ❌（暂不用 Tauri）。

---

## 11. 风险与提醒

- 仅做辅助作答，**不保证答案正确**，请自行核对；
- 遵守所用平台与 AI 服务条款，勿用于违规场景；
- `config.json` 含密钥，勿提交版本库；`HOST=0.0.0.0` 会让同网段设备都能访问，慎用。
