# 交接状态（HANDOFF）

更新：2026-10-18 · 工作区 `D:\代码\网页自动学习` · 账号：示例用户（示例大学 00000000000）

## 一句话现状

**全流程已跑通并验证通过**：登录 → 动态发现课程 → 解析考试入口 → 批量抓题 → 安全复查 → 生成打印稿。
上次会话中断在"移植到本地盘 + 重新登录"这两步，现已全部完成。

## 2026-10-18 桌面端重构

- 桌面端改为原生 WinForms（`desktop/native/CourseHelper.cs`，C# 5 编译），不内嵌浏览器、不依赖 WebView2；界面只展示课程目录、完成状态与运行日志。
- 浏览器侧仍由 CDP 接管已登录的 Edge；目录扫描走 `src/flows/course-catalog.mjs`，结果写入 `export/course-catalog.json`。
- 旧 WebView2 架构（`desktop/host`、`desktop/serve.mjs`、`desktop/ui`）与旧打包脚本已删除；构建统一走 `packaging/build-automation.ps1`。
- 自动作业修复：不再先「暂存」（暂存确认后平台会关闭答题页），直接提交；作业列表先切回「未提交」页签再找卡片。

## 2026-10-18 全仓代码审查与加固

- 桌面端：原生 WinForms 界面自绘（`Theme` / `Draw` / `Card` / `UiButton` / `StatusPill`），窗口标题栏启用深色沉浸模式；网页操作全部在后台 CDP 连接中进行。
- Electron：启用 `sandbox`，拦截 `will-navigate` / 新窗口，IPC 校验发送方，后端启动失败即报错退出。
- md-ai-answer：题目归一化补 `id`/`options`，答案汇总与回填兼容缺字段题目。
- 凭据/会话/导出/自动化层：按审查结论修复；`node --check` 全仓通过（第三方 HTML 伪装的 `.js` 除外）。
- 文档：补齐 `answer` / `watch` / `auto` 的 `tools.json` 与 CLI 文档，`check-docs` 已 exit 0。

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

## 个人信息（凭据）配置

不再依赖写死的文件。五种输入方式，优先级从高到低，**逐字段生效可混用**：

1. 命令行：`login --school X --student-id Y --password Z`
2. 环境变量：`ZHS_SCHOOL` / `ZHS_STUDENT_ID` / `ZHS_PASSWORD` / `ZHS_REAL_NAME`
3. `--account <文件>`：任意 JSON，**字段名自动识别别名**（`学校名称`/`university`/`userName`/`pwd` … 都认）
4. 凭据库：`config/credentials.json`（`import --prompt` 交互录入写在这里）
5. 兼容旧文件：`config/account-live.json`、`config/account.json`

```powershell
node zhs.mjs import --prompt      # 交互录入（密码不回显，只显示 *）
node zhs.mjs import D:\x.json     # 导入任意来源
node zhs.mjs whoami               # 看当前生效值 + 来源，并把平台真实姓名写回
```

安全：`config/*` 已被 `.gitignore` 忽略（只放行 `account.template.json`）；写凭据时用 `icacls` 收紧到仅当前用户；`whoami` 与日志只显示掩码。完整说明见 `docs/CREDENTIALS.md`。

文档封面的名字来自**平台真值**：`whoami` 调 `getLoginUserInfo` 取回真实姓名；登录时脚本还会回读学校下拉框的实际选中文本，防止选到「示例大学医学院」之类同名前缀项。

## 怎么再跑一次

统一入口是 `zhs.mjs`（详见 `README.md`）：

```powershell
run.cmd doctor        # 环境自检
run.cmd login         # 会话失效时重新登录（会固化票据，重启不丢）
run.cmd all           # 全流程：抓题 + 生成 docx/md/pdf/xlsx + 完整性校验
run.cmd docs          # 不重新抓，只重新生成文档
run.cmd verify        # 校验产物完整性（题目/选项逐条比对）
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

1. **浏览器适配：已完成，抓取层与浏览器解耦**
   - Chromium 系（Edge/Chrome/Brave/Vivaldi/Opera/360/QQ/Chromium）自动发现 + CDP 接管；
     `navigator.webdriver=false`，能过易盾。
   - Firefox 走 **WebDriver BiDi**（`src\core\bidi.mjs` + `src\core\browser-firefox.mjs`）。
     Playwright 自带 Firefox 的 `-juggler-pipe` 在沙箱里会被拒（`SpawnTarget 0x80070005`
     → `0xC0000005` 退出），系统 Firefox 又已移除 CDP，所以 BiDi 是唯一稳定通道。
     BiDi 下 Firefox 的 `navigator.webdriver` 默认为 true，已用 `script.addPreloadScript`
     在页面脚本之前抹掉。
   - 任意浏览器：`--browser-exe <路径>`。
   - 首次用 Firefox 抓题需人工登录一次（会话存 `browser-profile-firefox`）；
     也可 `--firefox-profile` 指向你平时已登录的 profile（需先退出 Firefox）。
   - 仍保留 `node src\tools\firefox-session.mjs`：只读本机 Firefox 的 cookie，不启动浏览器。

2. **`config\account.json` 可能读不了**
   它曾被收紧成"仅 Administrator 全控制"，普通用户读取会被拒。现在凭据默认写入
   `config\credentials.json`，该旧文件只作兼容兜底，读不到会静默跳过。若需恢复：
   `icacls "D:\代码\网页自动学习\config\account.json" /reset`

3. **停止 Edge 后会话的注意事项**
   固化过的票据能扛重启；但如果你在 Edge 里手动退出登录，需要重新跑
   `recon\login-and-persist.mjs`。

## 关键文件位置

- 浏览器抽象层（Edge/Firefox 统一入口）：`src\core\browser.mjs`
- 登录公共逻辑（学校下拉框等易错点都在这里）：`src\core\login-flow.mjs`
- 全流程编排：`src\flows\pipeline.mjs`
- 登录 + 票据固化：`recon\login-and-persist.mjs`
- 环境自检：`recon\verify-env.mjs`
- 桌面端（原生 WinForms）：`desktop\native\CourseHelper.cs`
- 课程目录扫描：`src\flows\course-catalog.mjs`
- 独立 AI 作答组件：`md-ai-answer\`（CLI / Electron / 本地服务）
- 上一轮数据备份：`export\backup-20261010-180734\`
