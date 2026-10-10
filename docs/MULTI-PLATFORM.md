# 多端悬浮窗使用指南

## 平台对照

| 平台 | 入口 | 读题方式 | 点击能力 | 适用场景 |
|---|---|---|---|---|
| **Windows 桌面** | `pad.ps1` / `pad-controller.ps1` | 截屏 → 多模态 AI | ❌ 只读 | 任何窗口化应用 |
| **浏览器插件** | Chrome/Edge 扩展 | DOM 读取（精确） | ✅ 可点击 | 网页版智慧树 |
| **安卓** | 待开发 | 截屏 / 无障碍 | ⚠️ 需无障碍 | 手机 App |

---

## Windows 桌面

### 模式 1：只读悬浮窗（已有）

```powershell
# 截屏识别当前屏幕，给答案（不点击）
node zhs.mjs pad
# 或
powershell -NoProfile -ExecutionPolicy Bypass -File md-ai-answer\pad\pad.ps1
```

**快捷键**：`Alt+Q` 识别并作答

### 模式 2：接管悬浮窗（新增）

```powershell
# 列出待完成作业，手动打开后接管
powershell -NoProfile -ExecutionPolicy Bypass -File md-ai-answer\pad\pad-controller.ps1
```

**流程**：
1. 悬浮窗列出所有未提交作业
2. 选中 → 点「打开选中作业」→ 浏览器打开
3. 页面加载完成后，运行：
   ```bash
   node src\apply-homework.mjs --apply
   ```
4. 脚本模拟人类点击，只保存不提交

---

## 浏览器插件（推荐）

### 安装

1. 打开 Chrome/Edge → 扩展管理 → 开发者模式
2. 加载已解压的扩展程序 → 选择 `extension/` 目录

### 使用

1. **配置 AI**：点击插件图标，填 `baseUrl` / `apiKey` / `model`
2. **打开作业页**：智慧树网页版，进入作业/考试
3. **扫描题目**：点插件「扫描题目」或悬浮窗「扫描」
4. **获取答案**：点「获取答案」→ 悬浮窗显示
5. **回填**：点「回填（不提交）」→ 模拟人类点击选项
6. **检查页面**：确认无误后**手动提交**

### 视频弹题

- 插件自动检测 `#playTopic-dialog` 弹窗
- 弹题出现时点「扫描」即可识别

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
