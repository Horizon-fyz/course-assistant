# 数据契约

产物文件的结构定义。**改这些文件的下游程序可以依赖这里的字段**。

- 机器可读 Schema：[`schemas/papers.schema.json`](schemas/papers.schema.json)、[`schemas/courses-resolved.schema.json`](schemas/courses-resolved.schema.json)
- 校验命令：`node zhs.mjs verify`（或 `node recon/validate-data.mjs`），退出码 `0` 通过 / `3` 不通过
- 校验器只约束**关键结构**：平台会新增字段，未声明的字段不报错

---

## `export/papers.json`

题库数据。**顶层是 `课程名 → 作业数组` 的映射**。

```jsonc
{
  "大学生心理健康教育": [ /* HomeworkItem[] */ ],
  "国家安全教育":       [ /* HomeworkItem[] */ ],
  "思想道德与法治":     [ /* HomeworkItem[] */ ]
}
```

### HomeworkItem（一份作业）

作业列表接口的原始字段 + 抓到的 `paper`。

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 作业 ID，**用于拼试卷地址** |
| `examId` | string | 考试 ID，**用于拼试卷地址** |
| `courseId` | number | 课程 ID |
| `examName` | string | 作业名，如「第一章单元测试」 |
| `cpOrderNumber` | string | 对应章节，如「第一章」 |
| `examUserName` | string | 出题教师 |
| `problemNum` | number | 题目数 |
| `totalScore` | string | 总分（平台以字符串返回） |
| `startTime` / `endDate` | string | 开始 / 截止时间，`YYYY-MM-DD HH:mm:ss` |
| `meetCourseType` | number | **用于拼试卷地址的末段** |
| `state` | number | `1` = 未提交（抓取前后都会复查） |
| `backNum` | number | 剩余作答次数；未作答为 `3` |
| `score` | number \| null | 得分；未作答为 `null` |
| `achieve` / `achieveCount` | number / null | 达成度相关 |
| `isMarking` / `isRecruit` / `isCheckAnswer` / `isObject` / `reviewType` / `courseState` / `chapterRank` | number | 平台状态位 |
| `chapterId` | number | 章节 ID |
| `courseName` | string | 课程名（冗余，便于单条记录自解释） |
| `createTime` | string | 作业创建时间 |
| `oneHundredPont` | string | 百分制换算（实测为空串） |
| `workCorrectEndTime` / `applyResult` | null | 实测为空 |
| `paper` | object \| null | 试卷接口完整响应；未抓到为 `null` |

> **判"未提交"的判据**（`verify` 用的就是这条）：`state === 1 && backNum === 3 && score === null`。

### `paper`（试卷响应）

```jsonc
{
  "currentTime": 1791627888693,     // 服务端时间戳(ms)
  "msg": "请求成功",
  "status": "200",                  // 成功为字符串 "200"
  "rt": {
    "id": null,
    "score": null,
    "state": 1,
    "comment": null,
    "examEndTime": "2026-11-14 23:59:59",
    "examBase": { /* ExamBase */ }
  }
}
```

### ExamBase（试卷本体）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 等于作业的 `examId` |
| `name` | string | 试卷名 |
| `courseName` | string | |
| `toChapter` | string | 所属章节 |
| `chapterId` | number | |
| `problemNum` | number | 题目数 |
| `totalScore` | string | 总分 |
| `pontType` | string | 计分方式，如「百分制」 |
| `explain` / `limitTime` | null | 实测为空 |
| `workExamParts` | array | 分卷，通常只有 1 个元素 |

`workExamParts[]`：`{ id, startSort, questionCount, questionDtos }` —— **题目都在 `questionDtos` 里**。

> 取全部题目的写法：
> ```js
> const qs = (base.workExamParts ?? []).flatMap(p => p.questionDtos ?? []);
> ```

### Question（一道题）

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | string | 题干。**可能含 `<p>` 等 HTML 标签，下游需清洗** |
| `questionType` | `{ id, name }` | `id`：`1` 单选 / `2` 多选 / `3` 判断；`name` 为对应中文 |
| `questionOptions` | `{ id, content }[]` | 选项。顺序为平台返回顺序 |
| `questionScore` | string | 分值 |
| `eid` | string | 加密题目标识 |
| `source` | string | 来源标记 |
| `isFrame` | number | |
| `id` / `parentId` / `listenId` | null | **平台常返回 `null`，不要当稳定主键用** |
| `questionDatas` / `questionChildrens` / `listenData` / `comments` / `result` | null | 实测为空（组合题/听力题才会用到） |

**关于选项顺序（重要）**：

- **选择题每次拉取顺序都可能不同**（平台随机排列）。因此选项文本才是稳定信息，**不要用 `A/B` 字母做跨次比对**。
- **判断题固定两项**：`对` / `错`，但**两项的先后顺序也是随机的**（实测 33 题 `对|错`、29 题 `错|对`）。
- 选项 `id` 是数字且稳定，可用于跨次比对。

**关于答案**：平台**不下发答案字段**。抓取脚本也刻意不提交、不查阅答案，只读题目内容。

---

## `export/courses-resolved.json`

考试入口缓存，避免每次抓取都进课程页重新解析。**删除该文件是安全的**，下次抓取会自动重建。

```jsonc
{
  "大学生心理健康教育": {
    "secret": "4e5b5c59475b4859454a585858445e4350",   // 课程加密标识（recruitAndCourseId）
    "listRid": "qdnlqk0hsU55bNK59Oo4Bg%3D%3D",        // 考试页 listRid，已 URL 编码
    "courseId": 1000101708,
    "recruitId": 435122,
    "updatedAt": "2026-10-10T10:24:35.398Z"
  }
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `secret` | string \| null | 从视频页 URL 的 `recruitAndCourseId` 解出 |
| `listRid` | string \| null | **已 URL 编码**（含 `%3D%3D` 后缀），直接拼进地址即可，不要重复编码 |
| `courseId` / `recruitId` | number | |
| `updatedAt` | string | 写入时间（ISO 8601） |

> 缺 `listRid` 只会让下次抓取多花时间解析入口，**不算错误**（校验器只给提示）。

### 由它拼出的试卷地址

```
https://onlineexamh5new.zhihuishu.com/stuExamWeb.html#/webExamList?recruitId=<listRid>
```

---

## `config/credentials.json`（兼容 `account-live.json` / `account.json`）

| 字段 | 必填 | 说明 |
|---|---|---|
| `school` | 是 | 学校名，**必须与登录页下拉框文本完全一致**（差一个字会选错校区） |
| `studentId` | 是 | 学号 |
| `password` | 是 | 密码 |
| `realName` | 否 | 显示名，出现在文档封面。缺失时封面显示 `school + studentId` |

> 该文件含明文密码，**不要提交到仓库**。`config/credentials.json` 是默认凭据库；旧的 `account-live.json`、`account.json` 仍按顺序兜底读取。字段名可用别名（`university`/`学校`、`userId`/`学号` 等），详见 [`CREDENTIALS.md`](CREDENTIALS.md)。

---

## 校验器做了什么

`recon/validate-data.mjs` 分两层：

**结构层**（按 Schema）

- 必填字段是否存在、类型是否匹配、`questionType.name` 是否在枚举内

**业务规则层**（Schema 表达不了的）

| 检查 | 触发条件 | 为什么重要 |
|---|---|---|
| 未抓到试卷 | `paper == null` | 该作业内容缺失 |
| 空试卷 | `paper` 存在但题目数为 0 | 接口返回异常 |
| **疑似已提交** | 不满足 `state===1 && backNum===3 && score===null` | 安全底线：脚本绝不应改变作业状态 |
| 题目无选项 | `questionOptions.length === 0` | 抓取不完整 |

输出示例：

```
✓ papers.json  export/papers.json
   统计: {课程:3,作业:27,题目:191,选项:642,未抓到试卷:0,空试卷:0,疑似已提交:0,题型:{单选题:79,多选题:50,判断题:62}}
   结构与业务规则均通过
```

---

## `export/patrol-report.json` / `export/patrol-state.json`（巡检）

`patrol` 产生的两个文件，没有 Schema，但结构稳定：

| 文件 | 内容 |
|---|---|
| `export/patrol-report.json` | 本次巡检结果：`at`、统计（总作业 / 未提交 / 新作业 / 状态变化 / 临近截止）、`items`（逐作业的课程、作业名、状态、分数、截止时间、剩余小时、标记） |
| `export/patrol-state.json` | 历史快照 `{ items: { "<课程>|<作业id>|<examId>": { state, score, backNum, endDate, firstSeen, lastSeen, deadlineNotifiedOn } } }`，用于识别新作业、状态变化与截止提醒去重 |

`patrol` 会顺带把平台最新状态同步回 `papers.json` 的对应字段（`state` / `score` / `endDate` 等），但不会删除本地已有条目，也不会写入试卷内容。删除 `patrol-state.json` 后，下次巡检会重建基线（不会把存量作业误报为新作业）。

---

## `export/deadline-board.html`（截止看板）

`deadline` 生成的单文件 HTML，`patrol`（非 `--dry`）结束后也会自动刷新。无 Schema，但渲染逻辑只依赖以下字段：

| 来源 | 用到的字段 |
|---|---|
| `export/papers.json` | `courseName`、`id`、`examId`、`state`、`score`、`backNum`、`endDate`、`startTime`、`courseId`、`examName`、`meetCourseType` |
| `export/courses-resolved.json` | `recruitId`（拼「去作答」链接；缺失时链接为空） |
| `export/patrol-report.json` | `at`、`user`（显示最近巡检时间与账号） |
| 文件系统 | `papers.json` 的修改时间（显示数据更新时间） |

- **只读渲染**：不修改 `papers.json`，不启动浏览器，不访问网络。
- **分组规则**：未提交（`Number(state) === 1 && score == null`）按截止时间分为 `overdue` / `today`（<24h）/ `d3`（<72h）/ `d7`（<168h）/ `later` / `none`（无截止）；已提交单独归入 `done`。
- **去重**：按 `<课程>|<作业id>|<examId>` 去重，避免历史合并产生重复卡片。
- **位置**：默认 `export/deadline-board.html`，可用 `--out <目录>` 重定向（文件名固定）。
- **不含试卷正文**：页面只展示作业元信息与链接，不包含题目、选项或答案。

---

## 文档类产物（非结构化数据）

以下产物是给人看的成品，没有 Schema；但它们**必须与 `papers.json` 保持内容一致**，一致性由 `recon/verify-md.mjs` 逐题逐选项回查来保证。

| 产物 | 生成命令 | 一致性校验 |
|---|---|---|
| `export/智慧树作业题库_打印版.md` | `docs --formats md` | ✅ 逐题逐选项回查 |
| `export/智慧树作业题库.md` | `docs --formats md-bare` | 内容同上，仅去掉打印样式块 |
| `export/智慧树作业题库_打印版.docx` | `docs --formats docx` | 同源生成（读同一个 `papers.json`） |
| `export/智慧树作业题库_打印版.pdf` | `docs --formats pdf` | 由打印版 MD 渲染而来 |
| `export/智慧树作业题库_打印预览.html` | `docs --formats pdf` | 同上，中间产物 |
| `export/智慧树课程数据.xlsx` | `docs --formats xlsx` | 数据源是 `export/raw.json`（课程与视频），**不是** `papers.json` |

校验方式：

```powershell
node zhs.mjs verify            # 数据契约 + 文档完整性 + 产物清单
node recon/verify-md.mjs       # 只看 Markdown 命中率
```

---

## 版本兼容

- Schema 采用 draft-07 子集，校验器只做"关键结构"约束；**平台新增字段不会导致校验失败**。
- 若平台改动导致结构变化，先跑 `node zhs.mjs verify` 看具体报错，再决定是修 Schema 还是修抓取。
- `papers.json` 没有版本号字段；如需存档对比，建议按日期另存（例如 `papers-20261010.json`）。
