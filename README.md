# 智慧树题库工具

一个命令，随时调、可持续产出：**抓取 → 校验 → 生成 Markdown / Word / PDF / Excel**。

产出的 Markdown 题库可直接打印（内嵌 A4 打印样式），Word/PDF/Excel 与它同源同内容。

---

## 快速开始

```powershell
cd K:\网页自动学习

run.cmd doctor     # 1. 环境自检（先跑这个，缺什么会直接告诉你）
run.cmd login      # 2. 登录一次（会话会固化，浏览器重启不丢）
run.cmd all        # 3. 全流程：抓题 + 生成文档 + 完整性校验
```

之后任何时候想重新产出，只要：

```powershell
run.cmd all        # 重新抓 + 重新生成
run.cmd docs       # 不重新抓，只按现有数据重新生成文档
```

Windows 下也可以直接**双击 `run.cmd`** —— 会做环境自检并显示当前状态。

---

## 命令一览

| 命令 | 作用 |
|---|---|
| `run.cmd doctor` | 环境自检：Node / Python 文档库 / Playwright / 浏览器运行时 / 凭据 / 登录资料 / 题库数据 |
| `run.cmd status` | 当前状态：账号、题库规模（几门课几份作业几道题）、每个产物的时间与大小，并提示哪个产物过期 |
| `run.cmd import` | **导入个人信息**：从任意 JSON 导入，或 `--prompt` 交互录入 |
| `run.cmd whoami` | 查看当前生效的凭据与来源，并把平台真实姓名写回 |
| `run.cmd login` | 登录智慧树并把会话票据改写为持久 Cookie（关掉浏览器仍在线） |
| `run.cmd fetch` | 只抓题：课程发现 → 考试入口解析 → 批量抓题 → 安全复查 |
| `run.cmd docs` | 只生成文档：Markdown（打印版 + 纯文本）、Word、PDF、打印预览 HTML、Excel |
| `run.cmd verify` | 校验产物：数据契约 + 文档完整性 + 产物清单 |
| `run.cmd all` | 上面几步串起来：fetch → docs → verify |

### 细参

```powershell
run.cmd import --prompt                 # 交互录入账号（密码不回显）
run.cmd import D:\other-system.json      # 导入别人/别的系统导出的凭据文件
run.cmd login --student-id 00000000000 --password "***"   # 临时指定，不落盘
run.cmd fetch --course 国家安全教育       # 只抓某一门课
run.cmd fetch --dry-run                 # 只发现课程，不抓题（确认新课程能否识别）
run.cmd fetch --browser firefox         # 指定浏览器（默认 Edge）
run.cmd docs  --formats md,pdf          # 只产出指定格式
run.cmd docs  --out D:\题库             # 产物输出到别的目录
run.cmd login --restart-check           # 登录后顺带验证「重启浏览器仍在线」
```

### 退出码

`0` 成功　`1` 出错　`2` 未登录　`3` 校验不通过 —— 方便接进计划任务或批处理。

---

## 个人信息怎么填（可自定义输入）

工具**不要求**你把账号密码写死在某个文件里，以下方式任选，优先级高的覆盖低的：

| 方式 | 命令 |
|---|---|
| 交互录入（推荐，密码不回显） | `run.cmd import --prompt` |
| 导入任意 JSON（字段名自动识别） | `run.cmd import D:\xxx.json` |
| 命令行临时指定 | `run.cmd login --school 示例大学 --student-id 00000000000 --password "***"` |
| 环境变量（适合 CI） | `$env:ZHS_STUDENT_ID='...'; $env:ZHS_PASSWORD='...'` |
| 凭据库文件 | `Copy-Item config\account.template.json config\credentials.json` 后编辑 |

字段名不用统一 —— `学校名称` / `university` / `学校` 都能识别为学校，`学号` / `userId` / `account` 都能识别为学号。查看当前实际生效的来源：

```powershell
run.cmd whoami
```

完整说明（含别名表、优先级、安全约定）见 [`docs/CREDENTIALS.md`](docs/CREDENTIALS.md)。

> `config/` 已被 `.gitignore` 忽略，凭据不会误提交；写入时还会尝试把文件权限收紧到仅当前用户。

---

## 接口文档

要让**别的程序或 AI** 调用，看 [`docs/`](docs/README.md)：

| 文档 | 面向 |
|---|---|
| [`docs/API-cli.md`](docs/API-cli.md) | 命令行调用：每个命令的参数、返回值、退出码、副作用、失败处理 |
| [`docs/API-node.md`](docs/API-node.md) | 在 JS 里复用：浏览器抽象层、登录逻辑的完整函数签名 |
| [`docs/DATA-CONTRACT.md`](docs/DATA-CONTRACT.md) | 读产物：字段定义、取值、陷阱（选项顺序随机等） |
| [`docs/tools.json`](docs/tools.json) | 机器可读工具清单，可直接喂给程序做工具发现 |
| [`docs/schemas/`](docs/schemas) | `papers.json` / `courses-resolved.json` 的 JSON Schema |

数据契约可以随时自检：

```powershell
node zhs.mjs verify             # 数据契约 + 文档完整性 + 产物清单
node recon/validate-data.mjs    # 只看数据契约
node recon/check-docs.mjs       # 检查文档是否与代码漂移
```

---

## 产物

全部在 `export\`：

| 文件 | 说明 |
|---|---|
| `智慧树作业题库_打印版.md` | **Markdown 题库**，内嵌打印样式，Ctrl+P 即套用 A4 |
| `智慧树作业题库.md` | 纯 Markdown（无样式块，便于导入其它工具） |
| `智慧树作业题库_打印版.docx` | Word 版 |
| `智慧树作业题库_打印版.pdf` | A4 PDF，带页码页脚 |
| `智慧树作业题库_打印预览.html` | 浏览器直接打开的打印预览 |
| `智慧树课程数据.xlsx` | 课程总览 + 章节视频明细 + 数据来源说明 |
| `papers.json` | 原始题库数据（题目 ID / 选项 ID / 题型 / 分值） |
| `courses-resolved.json` | 每门课的考试入口缓存（listRid），下次跑可跳过解析 |

---

## 新课程会自动识别吗？

会。每次抓取都调 `queryShareCourseInfo` 动态拉课程列表，不是读死名单：

- 新课程会自动出现在日志里；
- 缺考试入口的课程会自动进课程页解析并写回 `courses-resolved.json`；
- **新增课程不需要改任何代码**。

想先确认，用 `run.cmd fetch --dry-run`（只发现、不抓题）。

---

## 安全边界

- 全程**只进入试卷读取题目**，绝不点击「提交作业」「暂存作业」；
- 抓完自动复查每份作业的 `state / backNum / score`，确认仍是未提交状态（异常会报出来）；
- `docs` 与 `verify` 只读本地数据，不碰网络。

---

## 配置

`config\account-live.json`（**不要提交到仓库**）：

```json
{
  "school": "示例大学",
  "studentId": "00000000000",
  "realName": "示例用户",
  "password": "***"
}
```

`realName` 会出现在文档封面上；删掉也能跑，只是封面显示「学校+学号」。

---

## 目录结构

```
zhs.mjs                  ← 统一入口（所有命令都从这里进）
run.cmd                  ← Windows 启动器（自动定位 node 与浏览器运行时）
config\account-live.json ← 账号凭据
src\browser.mjs          ← 浏览器抽象层（Edge CDP / Firefox 持久化 profile）
src\login-flow.mjs       ← 登录公共逻辑（学校下拉框等易错点集中在这里）
src\pipeline.mjs         ← 抓取主流程
recon\login-and-persist.mjs  ← 登录 + 会话固化
recon\make-md.mjs        ← Markdown 生成器
recon\make-pdf.mjs       ← 打印预览 HTML + PDF
recon\verify-md.mjs      ← Markdown 完整性校验
export\make-docx.py      ← Word 生成器
export\make-xlsx.py      ← Excel 生成器
export\                  ← 产物
recon\                   ← 侦察与诊断脚本（一般不用管）
```

---

## 已知限制

1. **Firefox 自动化路径不通**：Playwright 的 Firefox 走 `-juggler-pipe`（命名管道），在 DSH 作业沙箱里子进程创建被拒（`SpawnTarget 0x80070005`）后浏览器以 `0xC0000005` 退出。对照组：不带 `-juggler-pipe` 的裸启动能稳定运行，说明 Firefox 本身正常，卡的是沙箱 + 命名管道。
   → 主路径用 **Edge/Chrome**（CDP 接管，`navigator.webdriver=false`，能过易盾验证码）。
   → 另有 `node src\firefox-session.mjs`：读本机 Firefox 已登录的 Cookie 交给自动化用，不需要启动 Firefox。

2. **`config\account.json` 读不了**：上一轮把它的权限收紧成「仅 Administrator 全控制」，而当前用户是 `USER`（非管理员），读取/删除均被拒。因此改用 `config\account-live.json`。要恢复原文件需管理员执行
   `icacls "K:\网页自动学习\config\account.json" /reset`

3. **会话失效时**：跑 `run.cmd login`。若验证码出现，Edge 窗口会停在那一页，人工完成后脚本会自动继续（最多等 8 分钟）。
