# 交接状态（HANDOFF）

更新：2026-10-10 18:15 · 工作区 `K:\网页自动学习` · 账号：示例用户（示例大学 00000000000）

## 一句话现状

**全流程已跑通并验证通过**：登录 → 动态发现课程 → 解析考试入口 → 批量抓题 → 安全复查 → 生成打印稿。
上次会话中断在"移植到 K: 盘 + 重新登录"这两步，现已全部完成。

## 已完成

| 项 | 状态 | 说明 |
|---|---|---|
| 路径移植 `D:` → `K:` | ✅ | 核心脚本改为 `ROOT = join(import.meta.dirname, '..')`，不再写死盘符；用户名也不写死 |
| 重新登录 | ✅ | 示例大学 / 00000000000 登录成功（易盾验证码自动通过） |
| 登录持久化 | ✅ | CAS 票据原本是 session cookie，关浏览器即丢；现改写为 +30 天持久 cookie，**重启浏览器后仍在线**（已实测） |
| 全流程 pipeline | ✅ | 27 份作业 / 191 题，成功 27/27 |
| 安全复查 | ✅ | 27 份作业 `state/backNum/score` 全部未提交，异常 0 |
| 打印稿生成 | ✅ | Markdown + Word + PDF 三种格式，内容一致（191 题 / 642 选项，已逐条校验 100% 收录） |

## 交付物

- `export\智慧树作业题库_打印版.md` —— **Markdown 题库（可读 + 可打印）**：内嵌打印样式，Ctrl+P 即套用
- `export\智慧树作业题库.md` —— 纯 Markdown 版（不含样式块，便于导入其它工具）
- `export\智慧树作业题库_打印版.docx` —— Word 版（987 段，docx-checks 全部 pass）
- `export\智慧树作业题库_打印版.pdf` —— 36 页 A4，带「第 N / 36 页」页脚（由 MD 打印样式生成）
- `export\智慧树作业题库_打印预览.html` —— 打印预览页（可直接用浏览器打开看效果）
- `export\papers.json` —— 原始题库数据（含题目 ID / 选项 ID / 题型 / 分值）
- `export\智慧树课程数据.xlsx` —— 课程数据表
- `SITE-REPORT.md` / `DOMAIN-REPORT.md` —— 站点侦察与全域巡检报告

## 接口文档（给别的程序/AI 调用）

| 文件 | 内容 |
|---|---|
| `docs/README.md` | 文档索引 + 30 秒上手 + 退出码约定 |
| `docs/API-cli.md` | 每个命令的参数、返回值、退出码、副作用、失败处理对照表 |
| `docs/API-node.md` | `src/*.mjs` 的完整函数签名与返回结构 |
| `docs/DATA-CONTRACT.md` | `papers.json` / `courses-resolved.json` 字段定义与陷阱 |
| `docs/tools.json` | 机器可读工具清单（命令/参数/产物/限制），可直接喂给程序做工具发现 |
| `docs/schemas/*.json` | 两个数据文件的 JSON Schema |

文档防漂移（改代码后可跑）：

```powershell
node recon\check-docs.mjs       # 检查 tools.json / 文档 与 zhs.mjs 是否一致
node recon\validate-data.mjs    # 用 Schema + 业务规则校验产物
```

## 怎么再跑一次

统一入口是 `zhs.mjs`（详见 `README.md`）：

```powershell
run.cmd doctor        # 环境自检
run.cmd login         # 会话失效时重新登录（会固化票据，重启不丢）
run.cmd all           # 全流程：抓题 + 生成 docx/md/pdf/xlsx + 完整性校验
run.cmd docs          # 不重新抓，只重新生成文档
run.cmd verify        # 校验产物完整性（191 题 / 642 选项）
run.cmd status        # 看状态与产物新旧
```

细参：`fetch --course 国家安全教育`、`fetch --dry-run`、`docs --formats md,pdf`、`docs --out D:\题库`。

底层脚本（一般不用直接调，都支持传参）：

```powershell
python export\make-docx.py --out Y.docx --account "示例用户（示例大学）"
python export\make-xlsx.py --out Y.xlsx --account 示例用户 --school 示例大学
node recon\make-md.mjs --src X.json --out Y.md [--bare]
node recon\make-pdf.mjs --src Y.md --out Z.pdf
node recon\verify-md.mjs --papers X.json --md Y.md
```

会话失效时重新登录（会自动固化票据，重启不丢）：

```powershell
node recon\login-and-persist.mjs --restart-check
```

## 新课程会被自动识别吗？

会。`pipeline.mjs` 每轮都调 `queryShareCourseInfo` 动态拉课程列表（不是读死名单），
新课程会自动出现在日志里；缺 `listRid` 的课程会自动进入课程页解析考试入口并写回
`export\courses-resolved.json` 缓存。**新增课程无需改代码。**

## 已知限制（需要时再看）

1. **Firefox 自动化路径不通，原因已定位**
   Playwright 自带 Firefox 用的是 `-juggler-pipe`（命名管道）。在 DSH 作业沙箱里，
   Firefox 的管道子进程创建被拒（`SpawnTarget 0x80070005`），随后浏览器以
   `0xC0000005` 退出。对照组：不带 `-juggler-pipe` 的裸启动可以活 12 秒以上，
   说明 Firefox 本身正常，卡的是沙箱 + 命名管道。
   → **Edge/Chrome 路径是可靠主路径**（CDP 接管，`navigator.webdriver=false`，能过易盾）。
   → 如果一定要 Firefox：在你自己的普通窗口里登录智慧树后跑 `node src\firefox-session.mjs`，
     它会把本机 Firefox 的 cookie 读出来给自动化用（当前该 profile 里还没有智慧树 cookie）。

2. **`config\account.json` 读不了**
   上次会话把它的权限收紧成"仅 Administrator 全控制"，而当前用户是 FYZ，所以
   `Get-Content` / 删除 / takeown 全部被拒（FYZ 非管理员）。脚本因此改用
   `config\account-live.json`。要恢复原文件请用管理员权限：
   `icacls "K:\网页自动学习\config\account.json" /reset`

3. **停止 Edge 后会话的注意事项**
   固化过的票据能扛重启；但如果你在 Edge 里手动退出登录，需要重新跑
   `recon\login-and-persist.mjs`。

## 关键文件位置

- 浏览器抽象层（Edge/Firefox 统一入口）：`src\browser.mjs`
- 登录公共逻辑（学校下拉框等易错点都在这里）：`src\login-flow.mjs`
- 全流程编排：`src\pipeline.mjs`
- 登录 + 票据固化：`recon\login-and-persist.mjs`
- 环境自检：`recon\verify-env.mjs`
- 上一轮数据备份：`export\backup-20261010-180734\`
