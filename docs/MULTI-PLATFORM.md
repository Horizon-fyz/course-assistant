# 多端悬浮窗使用指南

## 平台对照

| 平台 | 入口 | 读题方式 | 点击能力 | 适用场景 |
|---|---|---|---|---|
| **Windows 桌面** | `智慧树助手.exe` | 内置浏览器读 DOM；截屏 | ✅ 可点击 | 网页版智慧树 / 任何窗口 |
| **安卓** | 待开发 | 截屏 / 无障碍 | ⚠️ 需无障碍 | 手机 App |

---

## Windows 桌面

自带基于 WebView2 的浏览器窗口，可直接在窗口内登录、读题、回填，无需截屏。

```powershell
# 打包便携版：生成 dist\智慧树助手\，整个目录可拷走，双击「智慧树助手.exe」运行
powershell -NoProfile -ExecutionPolicy Bypass -File build-portable.ps1
```

**流程**：
1. 在窗口内登录智慧树，进入作业 / 考试页面；
2. 点工具栏「扫描本页」——读取页面题目并调用 AI 生成答案；
3. 点「助手面板」打开置顶小窗，逐题查看答案（← → 翻页）；
4. 点「回填本页」——按人的节奏点击选项（只点选项，**不会点「提交作业」**）。

---

## 安卓（待开发）

详见 [ANDROID.md](ANDROID.md)。核心思路：
- 悬浮窗 + 无障碍服务读取屏幕
- 与桌面端共用 AI 接口和答案引擎
- 一键回填需无障碍点击权限

---

## 安全边界（所有平台）

| 操作 | 是否自动 |
|---|---|
| 读取题目 | ✅ 自动 |
| 给出答案 | ✅ 自动 |
| 点击选项 | ⚠️ 需确认（--apply 或点按钮） |
| 点击「保存/下一题」 | ⚠️ 需确认 |
| 点击「提交作业」 | ❌ **绝不自动** |

---

## 配置文件

所有平台共用 `md-ai-answer/config.json`：

```json
{
  "baseUrl": "https://api.deepseek.com/v1",
  "apiKey": "sk-你的key",
  "model": "deepseek-chat",
  "temperature": 0.2
}
```

或环境变量：
```powershell
$env:AI_BASE_URL = "https://api.deepseek.com/v1"
$env:AI_API_KEY = "sk-..."
$env:AI_MODEL = "deepseek-chat"
```
