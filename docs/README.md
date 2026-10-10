# 接口文档索引

三类调用方式，按需要选：

| 文档 | 面向 | 内容 |
|---|---|---|
| [`API-cli.md`](API-cli.md) | 命令行 / 脚本 / 定时任务 / 另一个 AI | 每个命令的参数、返回值、退出码、副作用、失败处理对照表 |
| [`API-node.md`](API-node.md) | 在 JS 里复用 | `src/browser.mjs`、`src/login-flow.mjs`、`src/session.mjs` 的完整函数签名与返回结构 |
| [`DATA-CONTRACT.md`](DATA-CONTRACT.md) | 读产物文件的下游程序 | `papers.json` / `courses-resolved.json` 的字段定义、取值、陷阱 |

机器可读入口：

| 文件 | 用途 |
|---|---|
| [`tools.json`](tools.json) | 工具清单（命令、参数、产物、退出码、限制），可直接喂给程序或 AI 做工具发现 |
| [`schemas/papers.schema.json`](schemas/papers.schema.json) | 题库数据结构 JSON Schema (draft-07) |
| [`schemas/courses-resolved.schema.json`](schemas/courses-resolved.schema.json) | 考试入口缓存 Schema |

## 30 秒上手

```powershell
node zhs.mjs doctor      # 环境是否就绪（退出码 0 = 就绪）
node zhs.mjs all         # 抓题 + 生成文档 + 校验（退出码 0 = 全部成功）
```

下游程序只读产物的话，读这两个文件即可：

```
export/papers.json            题库数据（课程名 → 作业数组）
export/courses-resolved.json  考试入口缓存
```

结构校验：

```powershell
node zhs.mjs verify             # 退出码 0 通过 / 3 不通过
node recon/validate-data.mjs    # 只看数据契约，输出更细
```

## 退出码约定

| 码 | 含义 | 调用方应对 |
|---|---|---|
| `0` | 成功 | — |
| `1` | 出错 | 看 stderr；环境问题跑 `doctor` |
| `2` | 未登录 | 跑 `login`（可能需要人工过验证码） |
| `3` | 校验不通过 | 跑 `verify` 看具体哪条规则 |

## 相关文档

- [`../README.md`](../README.md) —— 人类使用的完整说明
- [`../HANDOFF.md`](../HANDOFF.md) —— 当前状态与交接
- [`../SITE-REPORT.md`](../SITE-REPORT.md) —— 站点侦察：接口清单、签名机制、红线
- [`../DOMAIN-REPORT.md`](../DOMAIN-REPORT.md) —— 全域巡检：子域名、可达性、能力矩阵
