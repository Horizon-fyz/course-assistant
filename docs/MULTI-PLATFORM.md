# 多端使用指南

## 平台对照

| 平台 | 入口 | 读题方式 | 点击能力 | 适用场景 |
|---|---|---|---|---|
| **Windows 桌面** | `智慧树课程助手.exe` | 原生 WinForms 窗口展示目录；后台 CDP 接管已登录浏览器读 DOM | ✅ 可自动看课 / 答题 | 网页版智慧树 |
| **安卓** | 待开发 | 截屏 / 无障碍 | ⚠️ 需无障碍 | 手机 App |

---

## Windows 桌面

原生 WinForms 窗口（`desktop/native/CourseHelper.cs`），**不内嵌浏览器**：界面只负责展示课程目录、完成状态与运行日志，网页登录与操作由后台 CDP 接管已登录的浏览器。

```powershell
# 一键构建：dist 目录 + 便携版 zip + 安装程序 exe
powershell -NoProfile -ExecutionPolicy Bypass -File packaging\build-automation.ps1
```

构建后进入 `dist\智慧树一键全自动\`，双击 `智慧树课程助手.exe`。

**流程**：
1. 点「登录」——在接管的浏览器里登录智慧树（会话会固化）；
2. 点「刷新目录」——扫描每门课的章节 / 课节 / 时长 / 完成状态；
3. 左侧选课程，右侧选一节课；
4. 点「开始完成这节」——后台真实播放，完成后自动刷新目录状态；
5. 「运行日志」区实时显示进度，可随时「停止观看」。

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
| 读取课程目录 / 题目 | ✅ 自动 |
| 播放视频（真实播放，脚本调 `play` 会被风控） | ✅ 自动 |
| 点选答案 | ✅ 自动 |
| 点击「提交作业」 | ⚠️ 默认自动；`--no-submit` 可关闭，`--cross-check` 存疑题不提交 |

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
