# 安卓悬浮窗 —— 接口设计与实现指南

## 定位

在安卓设备上提供悬浮窗，识别屏幕上的题目并给出答案。与 Windows/浏览器插件共用同一套 `answer-engine` 核心逻辑。

## 技术选型

| 方案 | 优点 | 缺点 | 推荐度 |
|---|---|---|---|
| **悬浮窗 + 截屏** | 无需 root，兼容性好 | 需要用户每次授权截屏 | ★★★★ |
| **悬浮窗 + 无障碍服务** | 可自动读取屏幕内容 | 需要开启无障碍权限 | ★★★★ |
| **Xposed/Frida** | 功能最强 | 需要 root，风险高 | ★ |

**推荐方案**：悬浮窗 + 无障碍服务（AccessibilityService）

## 核心组件

### 1. 悬浮窗服务（FloatingWindowService）

```kotlin
class FloatingWindowService : Service() {
    private lateinit var windowManager: WindowManager
    private lateinit var floatView: View

    override fun onCreate() {
        super.onCreate()
        // 创建悬浮窗（TYPE_APPLICATION_OVERLAY 需要 SYSTEM_ALERT_WINDOW 权限）
        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
            PixelFormat.TRANSLUCENT
        )
        floatView = LayoutInflater.from(this).inflate(R.layout.float_window, null)
        windowManager.addView(floatView, params)
    }
}
```

### 2. 无障碍服务（AccessibilityService）

```kotlin
class QuestionAccessibilityService : AccessibilityService() {
    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        // 监听窗口内容变化，读取题目文本
        val rootNode = rootInActiveWindow ?: return
        val questions = extractQuestions(rootNode)
        if (questions.isNotEmpty()) {
            // 发送题目到悬浮窗或 AI
        }
    }

    private fun extractQuestions(root: AccessibilityNodeInfo): List<Question> {
        // 遍历节点树，提取题干和选项
        // 关键节点特征：
        // - 题干：包含"【单选题】"、"【多选题】"等标记的文本
        // - 选项：以 A. B. C. D. 开头的文本
        // - 或根据特定 ViewId（如 com.zhihuishu:id/subject_describe）
    }
}
```

### 3. AI 调用（与桌面端共用接口）

```kotlin
suspend fun askAI(prompt: String, config: AIConfig): Answer {
    val client = OkHttpClient()
    val request = Request.Builder()
        .url(config.baseUrl + "/chat/completions")
        .addHeader("Authorization", "Bearer ${config.apiKey}")
        .post(jsonBody.toRequestBody("application/json".toMediaType()))
        .build()

    val response = client.newCall(request).execute()
    return parseAnswer(response.body?.string())
}
```

## 与现有代码的复用

| 模块 | 复用方式 |
|---|---|
| `answer-engine.mjs` | 核心逻辑用 Kotlin 重写（normalize、judgeValue、lettersToIndexes） |
| `ai.mjs` | 直接用 OkHttp 调用，接口格式一致 |
| `answer.mjs` | 提示词模板与作答编排（题型规则、多选题复核）可参照迁移；多模态识别需安卓端截图 |

## 权限申请

```xml
<!-- AndroidManifest.xml -->
<uses-permission android:name="android.permission.SYSTEM_ALERT_WINDOW" />
<uses-permission android:name="android.permission.INTERNET" />

<service
    android:name=".FloatingWindowService"
    android:enabled="true"
    android:exported="false" />

<service
    android:name=".QuestionAccessibilityService"
    android:permission="android.permission.BIND_ACCESSIBILITY_SERVICE"
    android:enabled="true"
    android:exported="true">
    <intent-filter>
        <action android:name="android.accessibilityservice.AccessibilityService" />
    </intent-filter>
    <meta-data
        android:name="android.accessibilityservice"
        android:resource="@xml/accessibility_service_config" />
</service>
```

## 配置同步

与桌面端共用 `md-ai-answer/config.json`：

```json
{
  "baseUrl": "https://api.deepseek.com/v1",
  "apiKey": "sk-...",
  "model": "deepseek-chat"
}
```

安卓端可通过以下方式同步：
1. 手动输入（悬浮窗设置页）
2. 扫码传输（桌面端生成二维码）
3. 局域网 HTTP（桌面端 `server/index.mjs` 已监听 127.0.0.1，可改 0.0.0.0）

## 实现路线图

| 阶段 | 内容 | 状态 |
|---|---|---|
| v1 | 悬浮窗 + 手动输入题目 → AI 给答案 | 待做 |
| v2 | 无障碍服务自动读取题目 | 待做 |
| v3 | 截屏识别（多模态 AI） | 待做 |
| v4 | 一键回填（需无障碍点击） | 待做 |

## 注意事项

- **隐私**：截屏/读取屏幕内容涉及隐私，需明确告知用户
- **合规**：仅用于学习辅助，不保证答案正确
- **电量**：无障碍服务常驻后台，注意电量优化白名单
- **兼容性**：不同安卓厂商（MIUI、EMUI 等）对悬浮窗权限管理不同，需适配
