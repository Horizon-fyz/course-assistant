// desktop/host/Program.cs —— WinForms + WebView2 外壳（独立悬浮窗 + 截屏视觉识题）
//
// 现行架构：完全独立的置顶悬浮窗，配合用户自己的浏览器使用。
//   1. 用户用自己的浏览器打开智慧树作业页；
//   2. 悬浮窗按「开始识题」后定时截屏（dHash 变化检测），把画面交给通义千问 qwen-vl；
//   3. 命中本地题库直接给答案，否则问 AI 并写回题库；
//   4. 只显示答案，人工点击作答（不做任何自动点击）。
//
//   悬浮窗   ：置顶、无边框、可拖拽；开始/停止识题、截屏一次、上一题/下一题
//   设置窗口 ：AI 视觉模型配置、题库管理、关于
//
// 注意：下方仍保留旧「内置浏览器 + 网页回填/自动登录」的全部自动化源码（CreateMainForm、
//       BeginInit、AutoLogin*、ScanPage/ApplyAnswers、READ_PAGE_JS/CAPTURE_JS 等），
//       仅作为历史参考保留、默认不再调用；新的运行入口是 CreateFloatForm()。
//
// 语法约束：本机只有 .NET Framework 的 C# 5 编译器，故不使用字符串插值、?.、nameof 等。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using System.Web.Script.Serialization;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

static class Host
{
    static string ExeDir;
    static string AppDir;       // <ExeDir>\app
    static string LogPath;
    static string ConfigPath;
    static string DataDir;
    static int Port;
    static string Origin;
    static Process NodeProc;

    /** 旧内置浏览器外壳（保留不调用） */
    static Form MainForm;
    static WebView2 MainView;
    static TextBox UrlBox;
    static Label StatusLabel;

    static Form AssistantForm;
    static WebView2 AssistantView;

    static Form SettingsForm;
    static WebView2 SettingsView;

    /** 独立悬浮窗（现行主入口） */
    static Form FloatForm;
    static WebView2 FloatView;
    static System.Windows.Forms.Timer CaptureTimer;  // WinForms 定时器，固定跑在 UI 线程
    static bool VisionRunning;         // 是否处于「实时识题」状态
    static bool VisionBusy;            // 正在请求 /api/vision，避免重入
    static volatile bool CaptureBusy;  // 后台正在截屏/编码，避免定时器叠加触发
    static long LastHash;              // 上一次截屏的 dHash（9x8 差分哈希）
    static bool LastWasEmpty;          // 上一次识别是否「没识别到题目」（用于放宽变化阈值、尽快重试）
    static DateTime LastCallUtc = DateTime.MinValue;
    static DateTime LastTickUtc = DateTime.MinValue;   // 上一次定时器触发时刻，用于发现 UI 线程卡顿
    static volatile string CurrentMsg;                 // UI 线程当前正在处理的消息类型，供看门狗定位卡死位置

    static CoreWebView2Environment Env;
    /** WebView2 环境创建任务：启动时尽早并行预热，避免它与后端启动、建窗互相串行等待 */
    static Task<CoreWebView2Environment> EnvTask;
    /** WebView2 浏览器参数：关掉首运行向导 / 后台上网 / 组件更新 / 扩展等，显著缩短浏览器进程冷启动 */
    const string WebView2Args = "--disable-gpu --no-first-run --no-default-browser-check --disable-background-networking --disable-component-update --disable-sync --disable-extensions --disable-default-apps --disable-breakpad";

    /** 右下角系统托盘 */
    static NotifyIcon TrayIcon;
    static ContextMenuStrip TrayMenu;
    static bool TrayHintShown;         // 首次收进托盘只提示一次气泡
    static Icon AppIcon;               // 程序自绘图标：托盘/任务栏共用，避免 SystemIcons 共享句柄在 Win11 托盘渲染空白
    static int MsgTaskbarCreated;      // 资源管理器重启时广播的注册消息，收到需重新添加托盘图标
    static bool Quitting;              // 正在真正退出：放行窗口关闭，避免被 FormClosing 拦回

    /** 启动加速：后端在后台线程拉起，就绪后再导航悬浮窗；窗口不再等后端 */
    static bool BackendReady;
    static bool FloatNavigated;

    /** 单实例：再双击一次 exe 只把已有悬浮窗显示出来，不再起新进程（即便托盘图标没找到也能恢复） */
    static Mutex SingleMutex;
    static EventWaitHandle ShowSignal;

    /** 最近一次识别到的题目（含 answer/reason/source），悬浮窗按此渲染 */
    static string StateJson = "{\"questions\":[],\"answers\":{},\"cursor\":0,\"running\":false,\"busy\":false,\"bankCount\":0,\"status\":\"就绪\"}";

    /** 「截屏 → 提取 → 输出」三步流水线的步骤状态，悬浮窗步骤面板据此逐步点亮 */
    static string StepsJson = "[{\"key\":\"capture\",\"title\":\"截屏\",\"status\":\"pending\",\"detail\":\"\",\"at\":0},{\"key\":\"extract\",\"title\":\"提取（千问）\",\"status\":\"pending\",\"detail\":\"\",\"at\":0},{\"key\":\"reason\",\"title\":\"输出（DeepSeek）\",\"status\":\"pending\",\"detail\":\"\",\"at\":0}]";
    static long CaptureStamp;   // 最近一次截屏的时间戳，供前端刷新 <img src="/api/capture/last?t=...">

    static readonly JavaScriptSerializer Js = new JavaScriptSerializer();

    /** 默认配置：识别用通义千问视觉模型（DashScope 兼容模式），思考用 DeepSeek 文本模型。
     *  识别模型用 qwen3-vl-plus：旧版 qwen-vl-* / qwen2.5-vl-* 对账号已返回 403 access_denied。 */
    static readonly string DefaultConfig =
        "{\r\n  \"school\": \"\",\r\n  \"studentId\": \"\",\r\n  \"password\": \"\",\r\n  \"visionBaseUrl\": \"https://dashscope.aliyuncs.com/compatible-mode/v1\",\r\n  \"visionApiKey\": \"\",\r\n  \"visionModel\": \"qwen3-vl-plus\",\r\n  \"reasonBaseUrl\": \"https://api.deepseek.com/v1\",\r\n  \"reasonApiKey\": \"\",\r\n  \"reasonModel\": \"deepseek-reasoner\",\r\n  \"temperature\": 0.1,\r\n  \"concurrency\": 3,\r\n  \"batchSize\": 5\r\n}";

    const string HOME_URL = "https://onlineweb.zhihuishu.com/onlinestuh5";
    const string LOGIN_URL = "https://login.zhihuishu.com/?origin=zhs&service=https%3A%2F%2Fonlineservice-api.zhihuishu.com%2Fgateway%2Ff%2Fv1%2Flogin%2Fgologin";
    const string API_USERINFO = "https://onlineservice-api.zhihuishu.com/gateway/f/v1/login/getLoginUserInfo";

    /** 同一个进程里只自动尝试登录一次，避免来回跳转死循环 */
    static bool AutoLoginTried;
    /** 正在自动登录中：避免两次流程叠在一起互相踩（会导致学校下拉选不中） */
    static bool AutoLoginRunning;
    /** 首次运行只自动打开一次设置窗口 */
    static bool WelcomeOpened;

    [STAThread]
    static void Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Js.MaxJsonLength = int.MaxValue;

        // 高 DPI：必须在任何窗口创建前开启，否则高分屏上整个界面会被系统拉伸变糊
        EnableDpiAwareness();

        // 单实例：已有进程在跑时，通知它把悬浮窗显示出来再退出本进程。
        // 这样即使没在托盘里找到图标，重新双击 exe 也能把悬浮窗叫回来。
        bool createdNew;
        SingleMutex = new Mutex(true, "ZHS_Assistant_SingleInstance_v1", out createdNew);
        if (!createdNew)
        {
            try { EventWaitHandle.OpenExisting("ZHS_Assistant_ShowSignal_v1").Set(); } catch { }
            return;
        }

        try { Run(); }
        catch (Exception ex)
        {
            Log("FATAL " + ex.ToString());
            MessageBox.Show(ex.Message, "智慧树助手 启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    static void Run()
    {
        ExeDir = Path.GetDirectoryName(Application.ExecutablePath);
        AppDir = Path.Combine(ExeDir, "app");
        LogPath = Path.Combine(ExeDir, "启动日志.txt");
        ConfigPath = Path.Combine(ExeDir, "config.json");
        DataDir = Path.Combine(ExeDir, "data");

        Log("──────── 启动 ────────");
        Log("exe      : " + Application.ExecutablePath);

        Directory.CreateDirectory(DataDir);
        if (!File.Exists(ConfigPath)) File.WriteAllText(ConfigPath, DefaultConfig, new UTF8Encoding(false));

        // 托盘图标作为启动第一步无条件创建：后续任何环节（WebView2 预热 / 建窗 / 后端）出错都不会拖累它，
        // 保证「不管怎么启动」，只要进程活着就一定能住进托盘。
        CreateTray();

        Port = FindFreePort();
        Origin = "http://127.0.0.1:" + Port;
        Log("空闲端口 : " + Port);

        // 记录「OS 进程创建 → 进入托管代码」的耗时：若这里已经是几十秒，说明慢在进程启动 / 杀软扫描，
        // 而不是应用内部逻辑，代码层面可优化的空间很小；若这里很快，则瓶颈在后面的 WebView2 / 后端。
        try
        {
            int bootMs = (int)(DateTime.Now - Process.GetCurrentProcess().StartTime).TotalMilliseconds;
            Log("进程启动到托管入口耗时: " + bootMs + " ms");
        }
        catch { }

        // 尽早并行预热 WebView2 环境（浏览器进程冷启动最耗时），与后端启动、建窗同时进行
        PrewarmWebView2();

        // 单实例信号：第二次启动的进程会 Set 这个事件来要求显示悬浮窗
        try
        {
            ShowSignal = new EventWaitHandle(false, EventResetMode.AutoReset, "ZHS_Assistant_ShowSignal_v1");
            var listener = new Thread(delegate()
            {
                while (true)
                {
                    try { ShowSignal.WaitOne(); } catch { break; }
                    // 再次双击 exe 时：先把托盘图标补回来（可能被资源管理器重启清掉过），再显示悬浮窗
                    try { OnUi(delegate { ReAddTrayIcon("再次启动唤起"); ShowFloat(); }); } catch { }
                }
            });
            listener.IsBackground = true;
            listener.Start();
        }
        catch (Exception ex) { Log("!! 单实例信号创建失败: " + ex.Message); }

        // 先把悬浮窗显示出来，再去拉后端——窗口不必等后端就绪，启动更快（托盘已在上面创建）
        CreateFloatForm();
        StartUiWatchdog();   // 卡死探针：UI 消息循环一旦长时间不响应，日志里会留下现场
        StartBackendAsync();

        Log("启动流程结束，进入消息循环");
        Application.Run(FloatForm);
    }

    /* ------------------------------ 日志 ------------------------------ */

    static readonly object LogLock = new object();

    static void Log(string msg)
    {
        try
        {
            // 多线程都会写日志（UI 线程 + node 输出线程 + 截屏线程），加锁避免并发追加抛异常丢日志
            lock (LogLock)
            {
                File.AppendAllText(LogPath,
                    "[" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + "] " + msg + "\r\n",
                    new UTF8Encoding(false));
            }
        }
        catch { }
    }

    /* ------------------------------ 后端 ------------------------------ */

    static int FindFreePort()
    {
        var l = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
        l.Start();
        int p = ((IPEndPoint)l.LocalEndpoint).Port;
        l.Stop();
        return p;
    }

    static string NodePath()
    {
        string local = Path.Combine(ExeDir, "node", "node.exe");
        if (File.Exists(local)) return local;
        return "node";
    }

    static void StartBackend()
    {
        string serve = Path.Combine(AppDir, "serve.mjs");
        if (!File.Exists(serve)) throw new Exception("缺少后端入口：\r\n" + serve);

        var psi = new ProcessStartInfo();
        psi.FileName = NodePath();
        psi.Arguments = "\"" + serve + "\"";
        psi.WorkingDirectory = AppDir;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.EnvironmentVariables["PORT"] = Port.ToString();
        psi.EnvironmentVariables["ZHS_CONFIG"] = ConfigPath;

        NodeProc = new Process();
        NodeProc.StartInfo = psi;
        NodeProc.OutputDataReceived += delegate(object s, DataReceivedEventArgs e) { if (e.Data != null) Log("[node] " + e.Data); };
        NodeProc.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e) { if (e.Data != null) Log("[node!] " + e.Data); };
        NodeProc.Start();
        NodeProc.BeginOutputReadLine();
        NodeProc.BeginErrorReadLine();
        Log("后端已拉起: " + psi.FileName);

        string health = Origin + "/api/health";
        for (int i = 0; i < 60; i++)
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create(health);
                req.Timeout = 1000;
                using (var resp = (HttpWebResponse)req.GetResponse())
                using (var sr = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                { sr.ReadToEnd(); Log("后端就绪: " + health); return; }
            }
            catch { System.Threading.Thread.Sleep(400); }
        }
        throw new Exception("后端启动超时（" + health + "）");
    }

    /** 后台线程拉起后端，就绪后再导航悬浮窗——避免阻塞 UI 线程、拖慢窗口出现 */
    static void StartBackendAsync()
    {
        var t = new Thread(delegate()
        {
            try { StartBackend(); }
            catch (Exception ex)
            {
                Log("!! 后端启动失败: " + ex.Message);
                try { OnUi(delegate { ShowError(FloatView, "后端启动失败：\r\n" + ex.Message); }); } catch { }
                return;
            }
            BackendReady = true;
            OnUi(delegate { TryNavigateFloat(); });
        });
        t.IsBackground = true;
        t.Start();
    }

    /** 后端与 WebView2 都就绪后，才把悬浮窗导航到 float.html（只会导航一次） */
    static void TryNavigateFloat()
    {
        if (FloatNavigated || !BackendReady) return;
        if (FloatView == null || FloatView.IsDisposed) return;
        var core = FloatView.CoreWebView2;
        if (core == null) return;
        FloatNavigated = true;
        string url = Origin + "/desktop/ui/float.html";
        try { core.Navigate(url); Log("悬浮窗: 已导航 → " + url); }
        catch (Exception ex) { Log("!! 悬浮窗导航失败: " + ex.Message); }
    }

    /* ------------------------------ 独立悬浮窗（现行入口） ------------------------------ */

    /** 悬浮窗 UI 线程调度：后台线程拿到的结果统一回到 UI 线程再改状态 */
    static void OnUi(Action a)
    {
        try
        {
            if (FloatForm != null && !FloatForm.IsDisposed && FloatForm.IsHandleCreated) FloatForm.BeginInvoke(a);
            else a();
        }
        catch { }
    }

    /** 探测 UI 线程是否还在处理消息：投递一个空操作并限时等待；超时即说明消息循环被占住。 */
    static bool UiPumpAlive(int timeoutMs)
    {
        var f = FloatForm;
        if (f == null || f.IsDisposed || !f.IsHandleCreated) return false;
        using (var done = new ManualResetEvent(false))
        {
            try { f.BeginInvoke((Action)delegate { try { done.Set(); } catch { } }); }
            catch { return false; }
            return done.WaitOne(timeoutMs);
        }
    }

    /**
     * UI 看门狗：Windows 判定「未响应」的阈值约 5s，这里只要消息循环 3s 不干活就记一条日志，
     * 并带上当时正在处理的消息类型，方便下次卡死时直接定位到具体分支。
     * 只记录、不干预——避免看门狗自己参与恢复反而把现场搅乱。
     */
    static void StartUiWatchdog()
    {
        var t = new Thread(delegate()
        {
            bool reported = false;
            while (true)
            {
                try { Thread.Sleep(2000); } catch { break; }
                bool alive = UiPumpAlive(3000);
                if (!alive && !reported)
                {
                    reported = true;
                    Log("!! UI 无响应: 消息循环卡住，当前处理=" + (CurrentMsg == null ? "(空闲)" : CurrentMsg));
                }
                else if (alive && reported)
                {
                    reported = false;
                    Log("UI 已恢复响应");
                }
            }
        });
        t.IsBackground = true;
        t.Start();
    }

    /* ------------------------------ 高 DPI 感知 ------------------------------ */

    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
    [DllImport("shcore.dll")] static extern int SetProcessDpiAwareness(int value);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern uint GetDpiForSystem();

    /**
     * 必须在创建任何窗口之前调用：开启「逐显示器 DPI 感知」。
     * 非 DPI 感知进程在高分屏上会被系统把整个窗口位图拉伸放大，WebView2 里的页面因此发糊；
     * 开启后页面按屏幕真实物理分辨率渲染，观感清晰。逐级回退以兼容旧系统。
     */
    static void EnableDpiAwareness()
    {
        try { if (SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)) return; } catch { }  // Win10 1703+：PER_MONITOR_AWARE_V2
        try { if (SetProcessDpiAwareness(2) == 0) return; } catch { }                 // Win8.1+：PROCESS_PER_MONITOR_DPI_AWARE
        try { SetProcessDPIAware(); } catch { }                                        // 兜底：系统 DPI 感知
    }

    /** 当前屏幕缩放比例（96 DPI 记作 1.0）。窗口尺寸与边距都按它换算成物理像素。 */
    static float DpiScale()
    {
        try { uint dpi = GetDpiForSystem(); if (dpi >= 72 && dpi <= 960) return dpi / 96f; } catch { }
        try { using (Graphics g = Graphics.FromHwnd(IntPtr.Zero)) { if (g.DpiX >= 72) return g.DpiX / 96f; } } catch { }
        return 1f;
    }

    /** 逻辑像素 → 物理像素 */
    static int Dp(float scale, int logical) { return (int)Math.Round(logical * scale); }

    /* ------------------------------ 窗口圆角 ------------------------------ */

    [DllImport("dwmapi.dll")]
    static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

    const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;
    const int DWMWCP_ROUND = 2;

    /** 有标题栏的标准窗口：交给 Win11 DWM 原生圆角（带抗锯齿）；旧系统静默忽略。 */
    static void TryNativeRound(Form f)
    {
        if (f == null) return;
        try
        {
            int pref = DWMWCP_ROUND;
            DwmSetWindowAttribute(f.Handle, DWMWA_WINDOW_CORNER_PREFERENCE, ref pref, 4);
        }
        catch { }
    }

    /**
     * 无边框窗口：WebView2 不支持分层窗（TransparencyKey），故用 Region 把窗口裁成圆角。
     * 半径与页面卡片 border-radius 对齐，裁掉的正好是卡片圆角外的透明区，
     * 四角因此真正透明，不会露出窗口方形实色底。
     * @param logicalRadius 逻辑像素半径（96 DPI 下的 CSS px），运行时按窗口 DPI 缩放
     */
    static void ApplyRoundRegion(Form f, int logicalRadius)
    {
        if (f == null) return;
        EventHandler apply = delegate { SetRoundRegion(f, logicalRadius); };
        f.HandleCreated += apply;
        f.Resize += apply;
        if (f.IsHandleCreated) SetRoundRegion(f, logicalRadius);
    }

    static void SetRoundRegion(Form f, int logicalRadius)
    {
        if (f == null || !f.IsHandleCreated) return;
        try
        {
            float scale = 1f;
            using (Graphics g = f.CreateGraphics()) { scale = g.DpiX / 96f; }
            int r = (int)Math.Round(logicalRadius * scale);
            int w = f.Width, h = f.Height;
            if (w <= 0 || h <= 0) return;

            using (var path = new System.Drawing.Drawing2D.GraphicsPath())
            {
                int d = r * 2;
                if (d <= 0) path.AddRectangle(new Rectangle(0, 0, w, h));
                else
                {
                    path.AddArc(0, 0, d, d, 180, 90);
                    path.AddArc(w - d, 0, d, d, 270, 90);
                    path.AddArc(w - d, h - d, d, d, 0, 90);
                    path.AddArc(0, h - d, d, d, 90, 90);
                    path.CloseFigure();
                }
                var old = f.Region;
                f.Region = new Region(path);
                if (old != null) old.Dispose();
            }
        }
        catch { }
    }

    /* --------------- 截屏排除：让悬浮窗不出现在截屏里（免 Hide/Show 闪烁） --------------- */

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool SetWindowDisplayAffinity(IntPtr hWnd, uint dwAffinity);

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool GetWindowDisplayAffinity(IntPtr hWnd, out uint pdwAffinity);

    const uint WDA_NONE = 0x00000000;
    const uint WDA_EXCLUDEFROMCAPTURE = 0x00000011;

    static bool FloatCaptureExcluded = false;

    /* ------------------- 拖动窗口：交给系统原生「移动窗口」循环 ------------------- */

    [DllImport("user32.dll")] static extern bool ReleaseCapture();
    [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

    const int WM_NCLBUTTONDOWN = 0x00A1;
    const int HTCAPTION = 2;

    /* 缩放方向命中码：WM_NCLBUTTONDOWN 传这些值即进入系统原生「缩放窗口」循环 */
    const int HTLEFT = 10;
    const int HTRIGHT = 11;
    const int HTTOP = 12;
    const int HTTOPLEFT = 13;
    const int HTTOPRIGHT = 14;
    const int HTBOTTOM = 15;
    const int HTBOTTOMLEFT = 16;
    const int HTBOTTOMRIGHT = 17;

    /**
     * 让 Windows 自带的窗口移动循环接管拖动，鼠标在哪窗口就跟到哪。
     * 之前是前端逐帧回传屏幕坐标、由宿主设 Location：每一帧都要走一遍
     * 「JS → WebView2 IPC → UI 线程」的往返，天然滞后且会被节流，所以窗口总是追不上鼠标。
     */
    static void StartNativeDrag()
    {
        if (FloatForm == null || FloatForm.IsDisposed || !FloatForm.IsHandleCreated) return;
        try
        {
            // 鼠标左键此刻被 WebView2 子窗口捕获着；必须先释放，系统移动循环才拿得到鼠标输入
            ReleaseCapture();
            SendMessage(FloatForm.Handle, WM_NCLBUTTONDOWN, (IntPtr)HTCAPTION, IntPtr.Zero);
        }
        catch (Exception ex) { Log("!! 拖动失败: " + ex.Message); }
    }

    /**
     * 与移动窗口同一套机制：把方向映射成 HT* 命中码交给系统原生「缩放窗口」循环，
     * 由 OS 跟踪鼠标逐帧调整窗口边界，避免前端回传屏幕坐标带来的 DPI 单位偏差与 IPC 滞后。
     * 边缘侦测必须在前端完成（WebView2 子窗口吞掉父窗体命中测试，父窗体收不到落在它上面的 WM_NCHITTEST）。
     */
    static void StartNativeResize(string dir)
    {
        if (FloatForm == null || FloatForm.IsDisposed || !FloatForm.IsHandleCreated) return;
        int ht;
        switch (dir)
        {
            case "n": ht = HTTOP; break;
            case "s": ht = HTBOTTOM; break;
            case "e": ht = HTRIGHT; break;
            case "w": ht = HTLEFT; break;
            case "ne": ht = HTTOPRIGHT; break;
            case "nw": ht = HTTOPLEFT; break;
            case "se": ht = HTBOTTOMRIGHT; break;
            case "sw": ht = HTBOTTOMLEFT; break;
            default: return;
        }
        try
        {
            ReleaseCapture();
            SendMessage(FloatForm.Handle, WM_NCLBUTTONDOWN, (IntPtr)ht, IntPtr.Zero);
        }
        catch (Exception ex) { Log("!! 缩放失败: " + ex.Message); }
    }

    /**
     * 声明窗口「不被截屏捕获」：GDI BitBlt / DXGI / Windows.Graphics.Capture 都拍不到它，
     * 屏幕上看依旧正常。这样截屏识题时就不必再 Hide/Show 悬浮窗，从根上消除闪烁。
     *
     * 需 Win10 2004 (build 19041) 及以上；旧系统会把 0x11 降级成 WDA_MONITOR（截屏里是黑块），
     * 故设置后用 GetWindowDisplayAffinity 复核：拿到的不是 0x11 就清空并返回 false，调用方回退旧方案。
     * 注意：须在窗口可见之前调用，已显示的窗口 DWM 会有一段延迟。
     */
    static bool ExcludeFromCapture(Form f)
    {
        if (f == null) return false;
        try
        {
            IntPtr h = f.Handle;   // 访问 Handle 会在显示前提前创建句柄
            if (!SetWindowDisplayAffinity(h, WDA_EXCLUDEFROMCAPTURE)) return false;
            uint cur;
            if (!GetWindowDisplayAffinity(h, out cur)) return false;
            if (cur != WDA_EXCLUDEFROMCAPTURE)
            {
                SetWindowDisplayAffinity(h, WDA_NONE);   // 被降级：清掉，免得留下黑块
                return false;
            }
            return true;
        }
        catch { return false; }
    }

    /* --------------------- 抓屏：临时提升线程 DPI 感知 --------------------- */

    // 临时把「当前线程」的 DPI 感知提升到每显示器级别，用于抓取真实物理分辨率的整屏。
    [DllImport("user32.dll")]
    static extern IntPtr SetThreadDpiAwarenessContext(IntPtr dpiContext);

    static readonly IntPtr DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = new IntPtr(-4);

    static void CreateFloatForm()
    {
        FloatForm = new Form();
        FloatForm.Text = "智慧树助手";
        FloatForm.FormBorderStyle = FormBorderStyle.None;
        FloatForm.StartPosition = FormStartPosition.Manual;
        // 逻辑尺寸 384x540；高 DPI 下换算成物理像素，窗口观感大小不变、页面按物理分辨率渲染更清晰
        float dpi = DpiScale();
        int fw = Dp(dpi, 384), fh = Dp(dpi, 540);
        FloatForm.AutoScaleMode = AutoScaleMode.None;   // 尺寸已按 DPI 手算，禁止 WinForms 再缩放一次
        FloatForm.Size = new Size(fw, fh);
        // 原生缩放循环的最小尺寸：由系统 WM_GETMINMAXINFO 约束，拖到再小也拉不下去
        FloatForm.MinimumSize = new Size(Dp(dpi, 300), Dp(dpi, 360));
        FloatForm.TopMost = true;
        // 显示在任务栏：作为常规顶层窗口，任务栏有按钮、Alt+Tab 可切换
        FloatForm.ShowInTaskbar = true;
        FloatForm.Icon = AppIcon ?? (AppIcon = BuildAppIcon());   // 与托盘同一个自绘图标，任务栏按钮同样可识别
        FloatForm.BackColor = Color.FromArgb(22, 24, 30);

        var wa = Screen.PrimaryScreen.WorkingArea;
        FloatForm.Location = new Point(wa.Right - fw - Dp(dpi, 24), wa.Top + Dp(dpi, 80));

        FloatView = new WebView2();
        FloatView.Dock = DockStyle.Fill;
        FloatForm.Controls.Add(FloatView);

        // 点「叉」/任务栏关闭/Alt+F4 都只收进托盘，不退出（退出请用托盘菜单「退出」）
        FloatForm.FormClosing += delegate(object s, FormClosingEventArgs e)
        {
            if (!Quitting)
            {
                e.Cancel = true;
                HideToTray();
            }
        };
        FloatForm.FormClosed += delegate(object s, FormClosedEventArgs e)
        {
            if (!Quitting) Log("悬浮窗关闭");
        };

        // 截屏排除：须在 Show 之前设置，DWM 才会从一开始就不把它放进捕获流（避免闪烁）
        FloatCaptureExcluded = ExcludeFromCapture(FloatForm);
        Log("悬浮窗截屏排除=" + FloatCaptureExcluded);

        FloatForm.Show();
        Log("悬浮窗已显示");

        ApplyRoundRegion(FloatForm, 12);   // 无边框窗口圆角：半径对齐 CSS 卡片 --r-lg(12px)

        // 先只把 WebView2 控件建好，页面等后端就绪后再导航（TryNavigateFloat），启动更快
        BeginInit(FloatView, null, "悬浮窗");

        // 定时截屏：WinForms 定时器固定跑在 UI 线程，截屏改 Opacity/可见性都安全
        CaptureTimer = new System.Windows.Forms.Timer();
        CaptureTimer.Interval = 1200;
        CaptureTimer.Tick += delegate { OnTick(); };
        CaptureTimer.Start();
    }

    /* ------------------------------ 系统托盘 ------------------------------ */

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int RegisterWindowMessage(string lpString);

    /**
     * 自绘程序图标：项目里没有 ico 资源，运行时画一个（深色圆底 + 「智」字）。
     * 必须用程序自己持有的 Icon 实例——SystemIcons.Application 是系统共享句柄，
     * Windows 11 上 NotifyIcon 用它经常注册成功但托盘里渲染不出来（日志显示已添加、实际看不到）。
     * GetHicon 产生的句柄随进程存活即可，不主动 DestroyIcon（提前销毁会让已显示的托盘图标变空）。
     */
    static Icon BuildAppIcon()
    {
        try
        {
            const int sz = 32;
            using (var bmp = new Bitmap(sz, sz))
            {
                using (var g = Graphics.FromImage(bmp))
                {
                    g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                    using (var bg = new SolidBrush(Color.FromArgb(24, 160, 88)))   // 智慧树绿
                        g.FillEllipse(bg, 0, 0, sz - 1, sz - 1);
                    using (var fg = new SolidBrush(Color.White))
                    using (var font = new Font("微软雅黑", 15f, FontStyle.Bold, GraphicsUnit.Pixel))
                        g.DrawString("智", font, fg, 3, 2);
                }
                // GetHicon 会复制出一份独立的 HICON；位图随即释放不影响该图标
                return Icon.FromHandle(bmp.GetHicon());
            }
        }
        catch (Exception ex)
        {
            Log("!! 自绘图标失败，回退系统图标: " + ex.Message);
            return (Icon)SystemIcons.Application.Clone();   // 也要用独立副本，别直接用共享句柄
        }
    }

    /**
     * 重新添加托盘图标：启动时若资源管理器托盘尚未就绪，NIM_ADD 会静默失败且之后永远不出现；
     * 另外资源管理器重启（TaskbarCreated 广播）也会把所有托盘图标清掉。
     * 统一用「Visible=false 再 true」删了重加，两种情况都能恢复。
     */
    static void ReAddTrayIcon(string why)
    {
        if (Quitting || TrayIcon == null) return;
        try
        {
            TrayIcon.Visible = false;
            TrayIcon.Visible = true;
            Log("托盘图标重新添加（" + why + "）");
        }
        catch (Exception ex) { Log("!! 托盘图标重加失败: " + ex.Message); }
    }

    /** 任务栏重建探针：Explorer 崩溃重启会广播 TaskbarCreated，届时托盘图标需要重新添加 */
    sealed class TrayMessageFilter : IMessageFilter
    {
        public bool PreFilterMessage(ref Message m)
        {
            if (m.Msg == MsgTaskbarCreated) ReAddTrayIcon("任务栏重建");
            return false;   // 不拦截，消息照常分发
        }
    }

    /**
     * 右下角托盘图标：右键菜单可显示/隐藏悬浮窗、退出程序；双击图标还原悬浮窗。
     * 悬浮窗最小化或关闭都收进托盘（HideToTray），不直接退出，避免误关。
     */
    static void CreateTray()
    {
        TrayMenu = new ContextMenuStrip();
        var miShow = new ToolStripMenuItem("显示悬浮窗");
        miShow.Click += delegate { ShowFloat(); };
        var miHide = new ToolStripMenuItem("隐藏悬浮窗");
        miHide.Click += delegate { HideFloat(); };
        var miQuit = new ToolStripMenuItem("退出");
        miQuit.Click += delegate { QuitApp(); };
        TrayMenu.Items.Add(miShow);
        TrayMenu.Items.Add(miHide);
        TrayMenu.Items.Add(new ToolStripSeparator());
        TrayMenu.Items.Add(miQuit);
        // 菜单弹出前按悬浮窗可见性动态启用/禁用，避免出现无效项
        TrayMenu.Opening += delegate
        {
            bool visible = FloatForm != null && !FloatForm.IsDisposed
                           && FloatForm.Visible && FloatForm.WindowState != FormWindowState.Minimized;
            miShow.Enabled = !visible;
            miHide.Enabled = visible;
        };

        if (AppIcon == null) AppIcon = BuildAppIcon();
        TrayIcon = new NotifyIcon();
        TrayIcon.Icon = AppIcon;
        TrayIcon.Text = "智慧树助手";        // 托盘提示文本上限 63 字符
        TrayIcon.ContextMenuStrip = TrayMenu;
        TrayIcon.DoubleClick += delegate { ShowFloat(); };
        TrayIcon.Visible = true;
        Log("托盘图标已显示");

        // 资源管理器重启 → 重新添加；启动早期托盘未就绪的静默失败 → 稍后补注册一次
        MsgTaskbarCreated = RegisterWindowMessage("TaskbarCreated");
        Application.AddMessageFilter(new TrayMessageFilter());
        var retry = new System.Windows.Forms.Timer();
        retry.Interval = 4000;
        retry.Tick += delegate
        {
            retry.Stop();
            try { retry.Dispose(); } catch { }
            ReAddTrayIcon("启动补注册");
        };
        retry.Start();
    }

    /** 把悬浮窗收进系统托盘：隐藏窗口，首次给出气泡提示，避免用户以为程序退出了 */
    static void HideToTray()
    {
        // 托盘图标不可用时绝不隐藏窗口，否则会彻底失联（既没窗口也没图标）——这正是「住不进托盘」的坑
        if (TrayIcon == null) CreateTray();
        if (TrayIcon == null)
        {
            Log("托盘图标不可用，取消收进托盘，保持窗口显示");
            return;
        }
        HideFloat();
        if (TrayIcon != null && !TrayHintShown)
        {
            TrayHintShown = true;
            try
            {
                TrayIcon.ShowBalloonTip(2500, "智慧树助手",
                    "已收进托盘，双击右下角图标可重新打开。", ToolTipIcon.Info);
            }
            catch { }
        }
    }

    static void QuitApp()
    {
        if (Quitting) return;   // 防止退出流程重入
        Quitting = true;
        try { VisionRunning = false; if (CaptureTimer != null) CaptureTimer.Stop(); } catch { }
        try { if (TrayIcon != null) { TrayIcon.Visible = false; TrayIcon.Dispose(); TrayIcon = null; } } catch { }
        try { KillNodeTree(); } catch { }
        try { if (FloatView != null && !FloatView.IsDisposed) FloatView.Dispose(); } catch { }
        Application.Exit();
        // Application.Exit 只结束消息循环；若尚有残留线程/子进程，进程会挂在后台，只能靠任务管理器强杀，
        // 而强杀又可能被安全软件驱动拦成僵尸进程。这里直接强制结束当前进程，确保「退出」后立即消失、绝不残留。
        Environment.Exit(0);
    }

    /** 结束后台拉起的 node 后端，连同它派生的子进程一并收掉（node 可能再拉起子进程） */
    static void KillNodeTree()
    {
        var p = NodeProc;
        if (p == null) return;
        int pid = -1;
        try { if (!p.HasExited) pid = p.Id; } catch { }
        if (pid <= 0) return;
        try { p.Kill(); } catch { }
        try
        {
            var psi = new ProcessStartInfo("taskkill", "/F /T /PID " + pid);
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            using (var k = Process.Start(psi)) { if (k != null) k.WaitForExit(3000); }
        }
        catch { }
    }

    static Form OwnerWindow()
    {
        if (FloatForm != null && !FloatForm.IsDisposed) return FloatForm;
        if (MainForm != null && !MainForm.IsDisposed) return MainForm;
        return null;
    }

    static void ShowFloat()
    {
        if (FloatForm == null || FloatForm.IsDisposed) return;
        if (FloatForm.WindowState == FormWindowState.Minimized)
        {
            FloatForm.WindowState = FormWindowState.Normal;
        }
        FloatForm.Show();
        FloatForm.BringToFront();
        FloatForm.Activate();
    }

    static void HideFloat()
    {
        if (FloatForm == null || FloatForm.IsDisposed) return;
        FloatForm.Hide();
    }

    static void ToggleFloat()
    {
        if (FloatForm == null || FloatForm.IsDisposed) return;
        if (FloatForm.WindowState == FormWindowState.Minimized || !FloatForm.Visible) ShowFloat();
        else FloatForm.Hide();
    }

    /* --------------------------- 截屏 / dHash 变化检测 --------------------------- */

    /**
     * 抓整个虚拟屏幕（多显示器合并）。
     * 关键：本进程未声明 DPI 感知时，SystemInformation.VirtualScreen 会返回被缩放后的
     * 「逻辑分辨率」（如 3840x2160 的屏幕在 250% 缩放下只剩 1536x864），此时 CopyFromScreen
     * 只能截到物理屏幕的左上角一小块，右侧/下方题目会被裁掉。
     * 因此把抓屏放到一个「临时线程」上，先把该线程提升为每显示器 DPI 感知，拿到真实物理
     * 分辨率再抓取；界面本身仍保持原样（不受 DPI 影响），只修截屏。
     */
    static Bitmap CaptureFull()
    {
        Bitmap result = null;
        Exception error = null;
        var th = new Thread(() =>
        {
            IntPtr prev = IntPtr.Zero;
            bool raised = false;
            try { prev = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2); raised = prev != IntPtr.Zero; }
            catch { /* 旧系统不支持：退回未缩放逻辑分辨率 */ }
            try
            {
                var v = SystemInformation.VirtualScreen;
                var bmp = new Bitmap(v.Width, v.Height);
                using (var g = Graphics.FromImage(bmp)) g.CopyFromScreen(v.Left, v.Top, 0, 0, v.Size);
                result = bmp;
            }
            catch (Exception ex) { error = ex; }
            finally { if (raised) { try { SetThreadDpiAwarenessContext(prev); } catch { } } }
        });
        th.IsBackground = true;
        th.Start();
        th.Join();
        if (error != null) throw error;
        return result;
    }

    static int Gray(Color c) { return (c.R + c.G + c.B) / 3; }

    /** 9x8 灰度差分哈希（dHash）= 64 位，装入 long */
    static long HashOf(Bitmap bmp)
    {
        using (var small = new Bitmap(9, 8))
        {
            using (var g = Graphics.FromImage(small))
            {
                g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBilinear;
                g.DrawImage(bmp, 0, 0, 9, 8);
            }
            long hash = 0;
            int bit = 0;
            for (int y = 0; y < 8; y++)
            {
                int prev = Gray(small.GetPixel(0, y));
                for (int x = 1; x < 9; x++)
                {
                    int cur = Gray(small.GetPixel(x, y));
                    if (cur > prev) hash |= (1L << bit);
                    prev = cur;
                    bit++;
                }
            }
            return hash;
        }
    }

    static int Ham(long a, long b)
    {
        long x = a ^ b;
        int n = 0;
        while (x != 0) { n += (int)(x & 1L); x >>= 1; }
        return n;
    }

    /** 缩到最宽 maxW 并转成 JPEG 的 dataURL（给视觉模型） */
    static string ToJpegDataUrl(Bitmap src, int maxW, long quality)
    {
        Bitmap use = src;
        Bitmap scaled = null;
        if (src.Width > maxW)
        {
            int w = maxW;
            int h = (int)((double)src.Height * maxW / src.Width);
            scaled = new Bitmap(w, h);
            using (var g = Graphics.FromImage(scaled))
            {
                g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                g.DrawImage(src, 0, 0, w, h);
            }
            use = scaled;
        }
        try
        {
            ImageCodecInfo jpg = null;
            var codecs = ImageCodecInfo.GetImageEncoders();
            for (int i = 0; i < codecs.Length; i++)
                if (codecs[i].FormatID == ImageFormat.Jpeg.Guid) { jpg = codecs[i]; break; }

            var ep = new EncoderParameters(1);
            var eq = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, quality);
            ep.Param[0] = eq;
            try
            {
                using (var ms = new MemoryStream())
                {
                    if (jpg != null) use.Save(ms, jpg, ep);
                    else use.Save(ms, ImageFormat.Jpeg);
                    return "data:image/jpeg;base64," + Convert.ToBase64String(ms.ToArray());
                }
            }
            finally
            {
                // EncoderParameter / EncoderParameters 都持有 GDI+ 对象，必须释放；
                // 否则每次截屏都泄漏，连续识题一段时间后耗尽 GDI 句柄导致界面卡死。
                eq.Dispose();
                ep.Dispose();
            }
        }
        finally
        {
            if (scaled != null) scaled.Dispose();
        }
    }

    /**
     * 截一张「干净」的屏幕（不含悬浮窗），供视觉模型识别；hash 输出用于变化检测。
     * 悬浮窗已声明「不被截屏捕获」时，画面里本来就没有它，直接截即可（不会闪烁）；
     * 该能力不可用时（旧系统）回退：Hide → 截屏 → Show。
     * 必须在 UI 线程调用。
     */
    static string CaptureCleanDataUrl(out long hash)
    {
        hash = 0;
        bool wasVisible = FloatForm != null && !FloatForm.IsDisposed && FloatForm.Visible;
        bool hideNeeded = wasVisible && !FloatCaptureExcluded;
        string dataUrl = null;
        try
        {
            if (hideNeeded)
            {
                FloatForm.Hide();
                Application.DoEvents();
                Thread.Sleep(150);
            }
            dataUrl = CaptureAndEncode(out hash);
        }
        catch (Exception ex) { Log("!! 截屏失败: " + ex.Message); }
        finally
        {
            if (hideNeeded) RestoreFloat();
        }
        return dataUrl;
    }

    /**
     * 抓整屏 → dHash → JPEG(dataURL) → 落盘。纯计算、不碰 UI，可在后台线程调用。
     * 定时识题走这里，避免把「整屏抓取 + JPEG 编码 + 写盘」全压在 UI 线程上拖死界面。
     */
    static string CaptureAndEncode(out long hash)
    {
        hash = 0;
        using (var bmp = CaptureFull())
        {
            hash = HashOf(bmp);
            string dataUrl = ToJpegDataUrl(bmp, 2200, 90L);
            try
            {
                string hp = Path.Combine(DataDir, "last-capture.jpg");
                string b64 = dataUrl.Substring(dataUrl.IndexOf(',') + 1);
                File.WriteAllBytes(hp, Convert.FromBase64String(b64));
                Log("截屏: " + bmp.Width + "x" + bmp.Height + " jpeg=" + new FileInfo(hp).Length + "B");
            }
            catch (Exception ex2) { Log("!! 保存截屏失败: " + ex2.Message); }
            return dataUrl;
        }
    }

    /* --------------------------- 识题主流程 --------------------------- */

    static void OnTick()
    {
        // 卡顿探针：定时器间隔本应 ~1.2s，若明显拉长说明 UI 线程曾被占用（界面可能短暂无响应）
        DateTime now = DateTime.UtcNow;
        if (LastTickUtc != DateTime.MinValue)
        {
            double gap = (now - LastTickUtc).TotalMilliseconds;
            // 3s 以上说明 UI 线程被占住过；上限 60s 以排除系统睡眠/唤醒造成的间隔异常
            if (gap > 3000 && gap < 60000) Log("!! UI 卡顿: 定时器间隔 " + (int)gap + "ms");
        }
        LastTickUtc = now;

        if (!VisionRunning || VisionBusy || CaptureBusy) return;
        if ((now - LastCallUtc).TotalMilliseconds < 2500) return;  // 节流

        // 旧系统拿不到「截屏排除」时，只能先把悬浮窗藏起来再截，免得把它自己拍进去。
        // 藏/显必须在 UI 线程做；其余（抓屏、编码、写盘）全部丢到后台线程，别占住消息循环。
        bool hideNeeded = FloatForm != null && !FloatForm.IsDisposed && FloatForm.Visible && !FloatCaptureExcluded;
        if (hideNeeded) { try { FloatForm.Hide(); } catch { } }

        CaptureBusy = true;
        ThreadPool.QueueUserWorkItem(delegate
        {
            try
            {
                if (hideNeeded) Thread.Sleep(120);   // 等窗口真正从画面上撤下
                long h;
                string dataUrl = CaptureAndEncode(out h);
                OnUi(delegate { FinishCapture(h, dataUrl, hideNeeded); });
            }
            catch (Exception ex)
            {
                Log("!! 截屏失败: " + ex.Message);
                if (hideNeeded) OnUi(delegate { RestoreFloat(); });
            }
            finally { CaptureBusy = false; }
        });
    }

    /** 后台截屏完成后回 UI 线程收尾：恢复悬浮窗 → 变化检测 → 必要时发起识别 */
    static void FinishCapture(long h, string dataUrl, bool hideNeeded)
    {
        if (hideNeeded) RestoreFloat();
        if (string.IsNullOrEmpty(dataUrl)) return;
        if (!VisionRunning || VisionBusy) return;

        // 画面基本没变（比如只是时钟跳动）→ 不重复问 AI；
        // 但上一次没识别到题目时阈值放宽到 1（一丁点变化就重试），
        // 避免「页面分步渲染、题目出现时哈希变化不足 6 位」导致一直停在「未识别到题目」。
        int need = LastWasEmpty ? 1 : 6;
        if (LastHash != 0 && Ham(LastHash, h) < need) return;

        LastHash = h;
        LastCallUtc = DateTime.UtcNow;
        RecognizeOnce(dataUrl);
    }

    static void RestoreFloat()
    {
        try { if (FloatForm != null && !FloatForm.IsDisposed) FloatForm.Show(); } catch { }
    }

    static void StartVision()
    {
        VisionRunning = true;
        LastHash = 0;
        LastCallUtc = DateTime.MinValue;
        PublishStatus("已开启，正在识别…");
        OnTick();
    }

    static void StopVision()
    {
        VisionRunning = false;
        PublishStatus("已停止");
    }

    static void ToggleVision()
    {
        if (VisionRunning) StopVision(); else StartVision();
    }

    /* --------------------------- 步骤面板（截屏 → 提取 → 输出） --------------------------- */

    static Dictionary<string, object> NewStep(string key, string title, string status, string detail, long at)
    {
        var s = new Dictionary<string, object>();
        s["key"] = key;
        s["title"] = title;
        s["status"] = status;
        s["detail"] = detail;
        s["at"] = at;
        return s;
    }

    /** 把三步流水线重置为「待运行」 */
    static void ResetSteps()
    {
        var list = new List<object>();
        list.Add(NewStep("capture", "截屏", "pending", "", 0L));
        list.Add(NewStep("extract", "提取（千问）", "pending", "", 0L));
        list.Add(NewStep("reason", "输出（DeepSeek）", "pending", "", 0L));
        StepsJson = Js.Serialize(list);
    }

    /** 更新某一步的状态（pending/running/done/error）与详情；detail 传 null 表示保留原值 */
    static void UpdateStep(string key, string status, string detail)
    {
        var list = Js.Deserialize<List<object>>(StepsJson);
        if (list == null) list = new List<object>();
        bool found = false;
        for (int i = 0; i < list.Count; i++)
        {
            var s = AsDict(list[i]);
            if (s == null || Str(s, "key") != key) continue;
            if (status != null) s["status"] = status;
            if (detail != null) s["detail"] = detail;
            s["at"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            found = true;
            break;
        }
        if (!found)
        {
            list.Add(NewStep(key, key, status ?? "pending", detail ?? "", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()));
        }
        StepsJson = Js.Serialize(list);
    }

    /** 把当前处于「running」的步骤标记为失败（用于后台两步调用任一环节抛错时定位） */
    static void MarkRunningStepError(string msg)
    {
        var list = Js.Deserialize<List<object>>(StepsJson);
        if (list == null) list = new List<object>();
        for (int i = 0; i < list.Count; i++)
        {
            var s = AsDict(list[i]);
            if (s != null && Str(s, "status") == "running")
            {
                s["status"] = "error";
                s["detail"] = msg;
                s["at"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                break;
            }
        }
        StepsJson = Js.Serialize(list);
    }

    /**
     * 后台线程串行两步调用：
     *   ① /api/vision/extract —— 千问只提取题干/题型/选项（不作答）
     *   ② /api/vision/reason  —— 题库命中优先，未命中交 DeepSeek 推理
     * 每完成一步都回 UI 线程刷新步骤面板，实现「每一步都有显示」。
     */
    static void RecognizeOnce(string dataUrl)
    {
        if (VisionBusy) return;
        VisionBusy = true;

        // 截屏已在调用前完成（CaptureAndEncode 已写好 last-capture.jpg）
        ResetSteps();
        CaptureStamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        UpdateStep("capture", "done", "已截取当前屏幕");
        UpdateStep("extract", "running", "千问识别中…");
        PublishStatus("提取中…");
        Log("识题请求: dataUrl=" + (dataUrl == null ? 0 : dataUrl.Length) + "B");

        Task.Run(delegate
        {
            string err = null;
            Dictionary<string, object> finalRes = null;
            try
            {
                var cfg = ReadConfig();

                // —— 第二步：提取（千问只识别，不作答）——
                var b1 = new Dictionary<string, object>();
                b1["image"] = dataUrl;
                b1["config"] = cfg;
                var r1 = Js.Deserialize<Dictionary<string, object>>(PostJson(Origin + "/api/vision/extract", Js.Serialize(b1), 120000));
                bool ok1 = r1 != null && r1.ContainsKey("ok") && Convert.ToBoolean(r1["ok"]);
                if (!ok1) throw new Exception(Str(r1, "error").Length > 0 ? Str(r1, "error") : "提取失败：无返回");

                var extracted = AsObjList(r1.ContainsKey("questions") ? r1["questions"] : null);
                int n = extracted.Count;

                string titles = "";
                for (int i = 0; i < n; i++)
                {
                    var q = AsDict(extracted[i]);
                    if (q == null) continue;
                    string st = Str(q, "stem");
                    if (st.Length > 26) st = st.Substring(0, 26) + "…";
                    titles += (titles.Length > 0 ? "；" : "") + (i + 1) + ". " + st;
                }
                string detail1 = n == 0 ? "未识别到题目" : ("识别到 " + n + " 题：" + titles);

                OnUi(delegate
                {
                    UpdateStep("extract", "done", detail1);
                    UpdateStep("reason", n == 0 ? "done" : "running", n == 0 ? "无题目可作答" : "DeepSeek 思考中…");
                    UpdateState(new Dictionary<string, object>());
                });

                if (n == 0)
                {
                    finalRes = new Dictionary<string, object>();
                    finalRes["ok"] = true;
                    finalRes["questions"] = new List<object>();
                    finalRes["bankCount"] = 0;
                }
                else
                {
                    // —— 第三步：输出（题库命中优先 + DeepSeek 推理）——
                    var b2 = new Dictionary<string, object>();
                    b2["questions"] = extracted;
                    b2["config"] = cfg;
                    finalRes = Js.Deserialize<Dictionary<string, object>>(PostJson(Origin + "/api/vision/reason", Js.Serialize(b2), 120000));
                }
            }
            catch (Exception ex) { err = ex.Message; }

            string e2 = err;
            Dictionary<string, object> f2 = finalRes;
            OnUi(delegate
            {
                VisionBusy = false;
                if (e2 != null)
                {
                    MarkRunningStepError(e2);
                    PublishStatus("识别失败：" + e2);
                }
                else ApplyVisionResult(f2);
            });
        });
    }

    static void ApplyVisionResult(Dictionary<string, object> res)
    {
        if (res == null) { Log("识别结果: res=null"); MarkRunningStepError("无返回"); PublishStatus("识别失败：无返回"); return; }
        bool ok = res.ContainsKey("ok") && Convert.ToBoolean(res["ok"]);
        if (!ok) { Log("识别结果: ok=false err=" + Str(res, "error")); MarkRunningStepError(Str(res, "error")); PublishStatus("识别失败：" + Str(res, "error")); return; }

        var questions = AsObjList(res.ContainsKey("questions") ? res["questions"] : null);
        int bankCount = res.ContainsKey("bankCount") ? Convert.ToInt32(res["bankCount"]) : 0;
        Log("识别结果: questions=" + questions.Count + " bank=" + bankCount);
        LastWasEmpty = questions.Count == 0;

        var qlist = new List<object>();
        var answers = new Dictionary<string, object>();
        int fromBank = 0, fromAi = 0;
        for (int i = 0; i < questions.Count; i++)
        {
            var q = AsDict(questions[i]);
            if (q == null) continue;
            string qid = Convert.ToString(i + 1);

            var item = new Dictionary<string, object>();
            item["id"] = qid;
            item["number"] = qid;
            item["type"] = Str(q, "type");
            item["stem"] = Str(q, "stem");
            item["options"] = q.ContainsKey("options") ? q["options"] : new List<object>();
            qlist.Add(item);

            var a = new Dictionary<string, object>();
            a["answer"] = Str(q, "answer");
            a["reason"] = Str(q, "reason");
            a["source"] = Str(q, "source");
            answers[qid] = a;
            if (Str(q, "source") == "bank") fromBank++; else fromAi++;
        }

        if (questions.Count > 0)
        {
            UpdateStep("reason", "done", questions.Count + " 题已作答（题库 " + fromBank + " / AI " + fromAi + "）");
        }

        var state = new Dictionary<string, object>();
        state["questions"] = qlist;
        state["answers"] = answers;
        state["cursor"] = 0;
        state["running"] = VisionRunning;
        state["busy"] = false;
        state["bankCount"] = bankCount;
        state["status"] = qlist.Count == 0 ? "未识别到题目" : ("识别到 " + qlist.Count + " 题，请人工核对后作答");
        state["steps"] = Js.Deserialize<List<object>>(StepsJson);
        state["captureAt"] = CaptureStamp;
        StateJson = Js.Serialize(state);
        BroadcastState();
    }

    static void UpdateState(Dictionary<string, object> patch)
    {
        var cur = Js.Deserialize<Dictionary<string, object>>(StateJson);
        foreach (var kv in patch) cur[kv.Key] = kv.Value;
        // 步骤面板与截屏时间戳始终随状态下发，前端据此逐步点亮并刷新缩略图
        cur["steps"] = Js.Deserialize<List<object>>(StepsJson);
        cur["captureAt"] = CaptureStamp;
        StateJson = Js.Serialize(cur);
        BroadcastState();
    }

    static void PublishStatus(string status)
    {
        var p = new Dictionary<string, object>();
        p["status"] = status;
        p["running"] = VisionRunning;
        p["busy"] = VisionBusy;
        UpdateState(p);
    }

    static void BroadcastState()
    {
        var evt = new Dictionary<string, object>();
        evt["event"] = "state:update";
        evt["data"] = Js.Deserialize<Dictionary<string, object>>(StateJson);
        Broadcast(Js.Serialize(evt));
    }

    /* --------------------------- HTTP 小工具 --------------------------- */

    static string PostJson(string url, string json, int timeoutMs)
    {
        try
        {
            var req = (HttpWebRequest)WebRequest.Create(url);
            req.Method = "POST";
            req.ContentType = "application/json; charset=utf-8";
            req.Timeout = timeoutMs;
            req.ReadWriteTimeout = timeoutMs;
            byte[] data = Encoding.UTF8.GetBytes(json);
            req.ContentLength = data.Length;
            using (var s = req.GetRequestStream()) s.Write(data, 0, data.Length);
            using (var resp = (HttpWebResponse)req.GetResponse())
            using (var sr = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                return sr.ReadToEnd();
        }
        catch (WebException we)
        {
            if (we.Response != null)
            {
                using (var sr = new StreamReader(we.Response.GetResponseStream(), Encoding.UTF8))
                    return sr.ReadToEnd();
            }
            throw;
        }
    }

    static string GetText(string url, int timeoutMs)
    {
        var req = (HttpWebRequest)WebRequest.Create(url);
        req.Timeout = timeoutMs;
        using (var resp = (HttpWebResponse)req.GetResponse())
        using (var sr = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
            return sr.ReadToEnd();
    }

    /** JSON 数组（object[] / ArrayList 都实现 IList）→ List<object> */
    static List<object> AsObjList(object o)
    {
        var res = new List<object>();
        var l = o as System.Collections.IList;
        if (l == null) return res;
        foreach (var it in l) res.Add(it);
        return res;
    }

    static int BankCount()
    {
        try
        {
            string f = Path.Combine(DataDir, "bank.json");
            if (!File.Exists(f)) return 0;
            var bank = Js.Deserialize<Dictionary<string, object>>(File.ReadAllText(f, Encoding.UTF8));
            if (bank == null || !bank.ContainsKey("entries")) return 0;
            var entries = AsDict(bank["entries"]);
            return entries == null ? 0 : entries.Count;
        }
        catch { return 0; }
    }

    /* ------------------------------ 主窗口（内置浏览器） ------------------------------ */

    static Button MakeBtn(string text, int w)
    {
        var b = new Button();
        b.Text = text;
        b.Width = w;
        b.Height = 26;
        b.Margin = new Padding(2, 4, 2, 2);
        b.FlatStyle = FlatStyle.System;
        return b;
    }

    static void CreateMainForm()
    {
        MainForm = new Form();
        MainForm.Text = "智慧树助手";
        MainForm.Width = 1100;
        MainForm.Height = 800;
        MainForm.MinimumSize = new Size(900, 620);
        MainForm.StartPosition = FormStartPosition.CenterScreen;
        MainForm.Icon = SystemIcons.Application;

        var bar = new FlowLayoutPanel();
        bar.Dock = DockStyle.Top;
        bar.Height = 40;
        bar.WrapContents = false;
        bar.Padding = new Padding(6, 0, 6, 0);

        var btnHome = MakeBtn("智慧树", 68);
        var btnBack = MakeBtn("后退", 56);
        var btnReload = MakeBtn("刷新", 56);
        var btnLogin = MakeBtn("自动登录", 78);
        var btnScan = MakeBtn("扫描本页", 78);
        var btnApply = MakeBtn("回填本页", 78);
        var btnAssistant = MakeBtn("助手面板", 78);
        var btnSettings = MakeBtn("设置", 56);

        UrlBox = new TextBox();
        UrlBox.Width = 470;
        UrlBox.Margin = new Padding(6, 5, 2, 2);
        UrlBox.Text = HOME_URL;

        bar.Controls.Add(btnHome);
        bar.Controls.Add(btnBack);
        bar.Controls.Add(btnReload);
        bar.Controls.Add(btnLogin);
        bar.Controls.Add(btnScan);
        bar.Controls.Add(btnApply);
        bar.Controls.Add(btnAssistant);
        bar.Controls.Add(btnSettings);
        bar.Controls.Add(UrlBox);

        StatusLabel = new Label();
        StatusLabel.Dock = DockStyle.Bottom;
        StatusLabel.Height = 24;
        StatusLabel.TextAlign = ContentAlignment.MiddleLeft;
        StatusLabel.Padding = new Padding(8, 0, 8, 0);
        StatusLabel.Text = "就绪";

        MainView = new WebView2();
        MainView.Dock = DockStyle.Fill;

        // 注意顺序：Fill 先加（最后参与布局），Top/Bottom 后加
        MainForm.Controls.Add(MainView);
        MainForm.Controls.Add(StatusLabel);
        MainForm.Controls.Add(bar);

        btnHome.Click += delegate { Navigate(HOME_URL); };
        btnBack.Click += delegate { try { if (MainView.CoreWebView2 != null) MainView.CoreWebView2.GoBack(); } catch { } };
        btnReload.Click += delegate
        {
            try
            {
                if (MainView.CoreWebView2 == null) return;
                MainView.CoreWebView2.Reload();
                SetStatus("正在刷新当前页面…");
            }
            catch (Exception ex) { Log("!! 刷新失败: " + ex.Message); }
        };
        btnLogin.Click += delegate { AutoLoginTried = true; AutoLogin(); };
        btnScan.Click += delegate { ScanPage(null, 0); };
        btnApply.Click += delegate { ApplyAnswers(null, 0); };
        btnAssistant.Click += delegate { ToggleAssistant(); };
        btnSettings.Click += delegate { OpenSettings(); };
        UrlBox.KeyDown += delegate(object s, KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Enter && UrlBox.Text.Trim().Length > 0) { Navigate(UrlBox.Text.Trim()); e.SuppressKeyPress = true; }
        };

        MainForm.FormClosed += delegate(object s, FormClosedEventArgs e)
        {
            Log("主窗口关闭，退出");
            QuitApp();
        };
        MainForm.Show();
        Log("主窗口已显示");

        BeginInit(MainView, HOME_URL, "主窗口");
        UrlBox.Text = HOME_URL;
        SetStatus("已打开智慧树首页，请登录后进入作业页");
    }

    static void SetStatus(string text)
    {
        try { StatusLabel.Text = text; } catch { }
    }

    static void Navigate(string url)
    {
        if (MainView == null || MainView.CoreWebView2 == null) return;
        if (!url.StartsWith("http://") && !url.StartsWith("https://")) url = "https://" + url;
        Log("导航 → " + url);
        try { MainView.CoreWebView2.Navigate(url); UrlBox.Text = url; } catch (Exception ex) { Log("!! 导航失败: " + ex.Message); }
    }

    /* ------------------------------ WebView2 初始化 ------------------------------ */

    /** 尽早开始创建 WebView2 环境（会拉起浏览器进程，是启动最耗时的一步）。
     *  只创建一次，后续所有视图共用；被 BeginInit 与启动流程并发调用也安全。 */
    static void PrewarmWebView2()
    {
        if (EnvTask != null || Env != null) return;
        string folder = Path.Combine(ExeDir, "webview-data");
        Log("WebView2: 预热环境 → " + folder);
        var opts = new CoreWebView2EnvironmentOptions(WebView2Args);
        EnvTask = CoreWebView2Environment.CreateAsync(null, folder, opts);
    }

    static async void BeginInit(WebView2 view, string url, string label)
    {
        try
        {
            if (Env == null)
            {
                PrewarmWebView2();                 // 若启动流程已预热则直接复用同一个任务
                Log(label + ": 等待 WebView2 环境就绪");
                Env = await EnvTask;
                Log(label + ": 环境已创建，运行时版本 " + Env.BrowserVersionString);
            }
            await view.EnsureCoreWebView2Async(Env);
            // 无边框窗口（悬浮窗/助手面板）背景透明：让页面 body 的透明区露出窗口，
            // 配合窗口圆角 Region，四角才真正透出桌面而不是方块实色。
            if (view == FloatView || view == AssistantView)
            {
                try { view.DefaultBackgroundColor = Color.Transparent; } catch { }
            }
            Log(label + ": 控件就绪");
            view.CoreWebView2.WebMessageReceived += delegate(object s2, CoreWebView2WebMessageReceivedEventArgs e2) { OnMessage(view, e2); };

            // 页面用 window.open / target=_blank 打开的新窗口，一律并到主窗口里渲染。
            //
            // 为什么不能直接 Handled=true + Navigate：
            //   「开始答题」这类是 window.open('about:blank') 之后再赋 location / 写内容，
            //   自己导航过去只会得到一张空白页。
            // 为什么不能 e2.NewWindow = 主窗口的 CoreWebView2：
            //   实测会把主窗口当前的页面整个销毁（页面直接没了），更糟。
            // 正解：给弹窗一个隐藏的辅助 WebView2，等它真正要去某个地址时，把这地址转给主窗口。
            view.CoreWebView2.NewWindowRequested += delegate(object s2, CoreWebView2NewWindowRequestedEventArgs e2)
            {
                string target = e2.Uri;
                Log(label + ": 拦截新窗口请求 → " + (target.Length > 0 ? target : "(空)"));
                try
                {
                    var host = EnsurePopupHost();
                    if (host != null)
                    {
                        e2.NewWindow = host.CoreWebView2;
                        e2.Handled = true;
                        MainForm.BringToFront();
                        MainForm.Activate();
                        // about:blank 时接收器本来就在 about:blank，不会触发导航事件，
                        // 所以这里主动起一个"内容搬运"检查（应对纯 document.write 的弹窗）
                        if (target.Length == 0 || target.StartsWith("about:")) TryCopyPopupContent(8);
                        return;
                    }
                }
                catch (Exception ex) { Log("!! 辅助窗口创建失败: " + ex.Message); }

                // 兜底：至少别弹出我们控制不到的独立窗口；真实地址就直接在主窗口加载
                e2.Handled = true;
                if (target.Length > 0 && target.StartsWith("http"))
                {
                    try { MainView.CoreWebView2.Navigate(target); } catch { }
                }
            };

            // 辅助窗口：只为接住弹窗，用户看不到
            view.CoreWebView2.NavigationCompleted += delegate(object s2, CoreWebView2NavigationCompletedEventArgs e2)
            {
                Log(label + ": 导航完成 success=" + e2.IsSuccess + " status=" + e2.WebErrorStatus);

                // 重定向链里前一次导航会被中断（ConnectionAborted / OperationCanceled），
                // 这是正常现象，不能当错误报出来，否则红字会盖住页面。
                bool aborted = e2.WebErrorStatus == CoreWebView2WebErrorStatus.ConnectionAborted
                            || e2.WebErrorStatus == CoreWebView2WebErrorStatus.OperationCanceled;
                if (e2.IsSuccess || aborted) ClearError(view);
                else ShowError(view, "页面加载失败：" + e2.WebErrorStatus + "\r\n地址：" + url);

                if (e2.IsSuccess && view == MainView)
                {
                    try { UrlBox.Text = MainView.CoreWebView2.Source; } catch { }

                    // 首次运行：账号没配好就直接把设置窗口打开到账号区，省得用户找不到入口
                    if (!WelcomeOpened)
                    {
                        WelcomeOpened = true;
                        var c0 = ReadConfig();
                        if (Str(c0, "studentId").Length == 0 || Str(c0, "password").Length == 0)
                        {
                            Log("首次运行：账号未配置 → 自动打开设置页的账号区");
                            SetStatus("请先在设置里填写「学号 / 密码」，填完点「立即自动登录」");
                            OpenSettings("settings");
                        }
                    }

                    // 落到登录页且配了凭据 → 自动登录一次（避免来回跳转，只试一次）
                    string cur = "";
                    try { cur = MainView.CoreWebView2.Source; } catch { }
                    if (!AutoLoginTried && cur.IndexOf("login.zhihuishu.com", StringComparison.OrdinalIgnoreCase) >= 0)
                    {
                        var c = ReadConfig();
                        if (Str(c, "school").Length > 0 && Str(c, "studentId").Length > 0 && Str(c, "password").Length > 0)
                        {
                            AutoLoginTried = true;
                            Log("检测到登录页且有凭据 → 自动登录");
                            AutoLogin();
                        }
                    }
                }
            };
            // 抓包脚本必须在本页第一个脚本之前注入，否则会漏掉早期接口
            if (view == MainView)
            {
                try
                {
                    await view.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(CAPTURE_JS);
                    Log(label + ": 已注入抓包脚本");
                }
                catch (Exception ex) { Log("!! 注入抓包脚本失败: " + ex.Message); }
            }

            // url 为空表示「控件先建好、页面稍后再导航」（悬浮窗等后端就绪再加载）
            if (!string.IsNullOrEmpty(url))
            {
                view.CoreWebView2.Navigate(url);
                Log(label + ": 已导航 → " + url);
            }
            else if (view == FloatView)
            {
                // 控件就绪；若此时后端也已就绪则立即导航，否则等后端回调 TryNavigateFloat
                TryNavigateFloat();
            }

            // 主窗口就绪后，顺手把弹窗接收器建好（NewWindowRequested 必须同步响应）
            if (view == MainView) InitPopupHost();
        }
        catch (Exception ex)
        {
            Log("!! " + label + " WebView2 初始化失败: " + ex.ToString());
            ShowError(view, "WebView2 初始化失败：\r\n" + ex.Message +
                "\r\n\r\n请确认已安装「Microsoft Edge WebView2 Runtime」。");
        }
    }

    /** 当前显示的错误提示层（按窗口记，成功导航后移除） */
    static readonly Dictionary<WebView2, Label> ErrorLabels = new Dictionary<WebView2, Label>();

    static void ShowError(WebView2 view, string text)
    {
        try
        {
            var host = view.Parent;
            if (host == null) return;
            Label old;
            if (ErrorLabels.TryGetValue(view, out old) && old != null) { try { host.Controls.Remove(old); old.Dispose(); } catch { } }

            var lbl = new Label();
            lbl.Dock = DockStyle.Fill;
            lbl.BackColor = Color.White;
            lbl.ForeColor = Color.FromArgb(200, 40, 40);
            lbl.Padding = new Padding(28);
            lbl.Font = new Font("Microsoft YaHei", 10F);
            lbl.Text = text;
            host.Controls.Add(lbl);
            lbl.BringToFront();
            ErrorLabels[view] = lbl;
        }
        catch { }
    }

    /** 页面恢复正常后把错误提示层撤掉 */
    static void ClearError(WebView2 view)
    {
        try
        {
            Label lbl;
            if (!ErrorLabels.TryGetValue(view, out lbl) || lbl == null) return;
            var host = lbl.Parent;
            if (host != null) { host.Controls.Remove(lbl); }
            lbl.Dispose();
            ErrorLabels.Remove(view);
        }
        catch { }
    }

    /* ------------------------------ 助手面板 / 设置窗口 ------------------------------ */

    static void ToggleAssistant()
    {
        if (AssistantForm != null && !AssistantForm.IsDisposed) { AssistantForm.Close(); return; }
        OpenAssistant();
    }

    static void OpenAssistant()
    {
        if (AssistantForm != null && !AssistantForm.IsDisposed) { AssistantForm.Show(); AssistantForm.BringToFront(); return; }

        AssistantForm = new Form();
        AssistantForm.FormBorderStyle = FormBorderStyle.None;
        AssistantForm.StartPosition = FormStartPosition.Manual;
        float dpi = DpiScale();
        int aw = Dp(dpi, 430), ah = Dp(dpi, 560);
        AssistantForm.AutoScaleMode = AutoScaleMode.None;   // 尺寸已按 DPI 手算，禁止 WinForms 再缩放
        AssistantForm.Size = new Size(aw, ah);
        AssistantForm.TopMost = true;
        AssistantForm.ShowInTaskbar = false;
        AssistantForm.Text = "助手面板";

        var wa = Screen.PrimaryScreen.WorkingArea;
        AssistantForm.Location = new Point(wa.Right - aw - Dp(dpi, 40), wa.Top + Dp(dpi, 60));

        AssistantView = new WebView2();
        AssistantView.Dock = DockStyle.Fill;
        AssistantForm.Controls.Add(AssistantView);
        AssistantForm.Show();
        Log("助手面板已创建");

        ApplyRoundRegion(AssistantForm, 12);   // 与悬浮窗同一套 float.html，圆角一致

        BeginInit(AssistantView, Origin + "/desktop/ui/float.html", "助手面板");
    }

    /**
     * 打开设置窗口。
     * @param tab 直接定位到某个标签页（如 "settings" 账号与 AI 配置）；空则默认第一页
     */
    static void OpenSettings(string tab = null)
    {
        string url = Origin + "/desktop/ui/index.html" + (string.IsNullOrEmpty(tab) ? "" : "#" + tab);

        if (SettingsForm != null && !SettingsForm.IsDisposed)
        {
            SettingsForm.Show();
            SettingsForm.BringToFront();
            SettingsForm.Activate();
            try { if (SettingsView != null && SettingsView.CoreWebView2 != null) SettingsView.CoreWebView2.Navigate(url); } catch { }
            return;
        }

        SettingsForm = new Form();
        SettingsForm.Text = "智慧树助手 · 设置";
        float dpi = DpiScale();
        SettingsForm.AutoScaleMode = AutoScaleMode.None;   // 尺寸已按 DPI 手算，禁止 WinForms 再缩放
        SettingsForm.Width = Dp(dpi, 940);
        SettingsForm.Height = Dp(dpi, 720);
        SettingsForm.StartPosition = FormStartPosition.CenterParent;
        SettingsForm.Icon = SystemIcons.Application;

        SettingsView = new WebView2();
        SettingsView.Dock = DockStyle.Fill;
        SettingsForm.Controls.Add(SettingsView);
        SettingsForm.Show(OwnerWindow());      // 指定 Owner，CenterParent 才会生效
        TryNativeRound(SettingsForm);          // Win11 原生圆角（有标题栏的标准窗口）
        SettingsForm.BringToFront();
        SettingsForm.Activate();
        Log("设置窗口已打开: " + url);

        BeginInit(SettingsView, url, "设置窗口");
    }

    /* ------------------------------ 消息桥 ------------------------------ */

    static void Broadcast(string json)
    {
        try { if (FloatView != null && FloatView.CoreWebView2 != null) FloatView.CoreWebView2.PostWebMessageAsJson(json); } catch { }
        try { if (AssistantView != null && AssistantView.CoreWebView2 != null) AssistantView.CoreWebView2.PostWebMessageAsJson(json); } catch { }
        try { if (SettingsView != null && SettingsView.CoreWebView2 != null) SettingsView.CoreWebView2.PostWebMessageAsJson(json); } catch { }
    }

    static void Reply(WebView2 view, int id, object data)
    {
        // id==0 是前端 post() 发的「单向通知」（拖拽这类高频消息），本就不等应答。
        // 若照样回包，每次 mousemove 都会往渲染进程塞一条消息，堆积起来会把消息循环拖死 → 界面未响应。
        if (id == 0) return;
        var o = new Dictionary<string, object>();
        o["id"] = id; o["ok"] = true; o["data"] = data;
        try { view.CoreWebView2.PostWebMessageAsJson(Js.Serialize(o)); } catch { }
    }

    static void ReplyError(WebView2 view, int id, string msg)
    {
        if (id == 0) return;   // 同上：单向通知不需要应答
        var o = new Dictionary<string, object>();
        o["id"] = id; o["ok"] = false; o["error"] = msg;
        try { view.CoreWebView2.PostWebMessageAsJson(Js.Serialize(o)); } catch { }
    }

    static Dictionary<string, object> AsDict(object o) { return o as Dictionary<string, object>; }

    static string Str(Dictionary<string, object> d, string k)
    {
        if (d == null || !d.ContainsKey(k) || d[k] == null) return "";
        return Convert.ToString(d[k]);
    }

    static Dictionary<string, object> ReadConfig()
    {
        try { return Js.Deserialize<Dictionary<string, object>>(File.ReadAllText(ConfigPath, Encoding.UTF8)); }
        catch { return Js.Deserialize<Dictionary<string, object>>(DefaultConfig); }
    }

    static void OnMessage(WebView2 view, CoreWebView2WebMessageReceivedEventArgs e)
    {
        Dictionary<string, object> msg;
        try { msg = Js.Deserialize<Dictionary<string, object>>(e.WebMessageAsJson); }
        catch (Exception ex) { Log("!! 消息解析失败: " + ex.Message); return; }
        if (msg == null || !msg.ContainsKey("id") || !msg.ContainsKey("type")) return;

        int id = Convert.ToInt32(msg["id"]);
        string type = Convert.ToString(msg["type"]);
        var p = msg.ContainsKey("payload") ? AsDict(msg["payload"]) : null;

        CurrentMsg = type;   // 看门狗据此判断 UI 卡死时正卡在哪个消息分支
        try
        {
            switch (type)
            {
                case "config:get":
                    {
                        var cfg = ReadConfig();
                        cfg["hasVisionApiKey"] = !string.IsNullOrEmpty(Str(cfg, "visionApiKey"));
                        cfg["hasReasonApiKey"] = !string.IsNullOrEmpty(Str(cfg, "reasonApiKey"));
                        Reply(view, id, cfg);
                        break;
                    }
                case "config:set":
                    {
                        var cur = ReadConfig();
                        if (p != null) foreach (var kv in p) cur[kv.Key] = kv.Value;
                        File.WriteAllText(ConfigPath, Js.Serialize(cur), new UTF8Encoding(false));
                        Reply(view, id, cur);
                        break;
                    }
                case "state:get":
                    Reply(view, id, Js.Deserialize<Dictionary<string, object>>(StateJson));
                    break;
                case "state:set":
                    {
                        var cur = Js.Deserialize<Dictionary<string, object>>(StateJson);
                        if (p != null) foreach (var kv in p) cur[kv.Key] = kv.Value;
                        StateJson = Js.Serialize(cur);
                        var evt = new Dictionary<string, object>();
                        evt["event"] = "state:update";
                        evt["data"] = cur;
                        Broadcast(Js.Serialize(evt));
                        Reply(view, id, cur);
                        break;
                    }
                case "float:open": ShowFloat(); Reply(view, id, true); break;
                case "float:show": ShowFloat(); Reply(view, id, true); break;
                case "float:hide": HideFloat(); Reply(view, id, true); break;
                case "float:close": Reply(view, id, true); HideToTray(); break;
                case "float:toggle":
                    {
                        bool was = FloatForm != null && !FloatForm.IsDisposed
                                   && FloatForm.Visible && FloatForm.WindowState != FormWindowState.Minimized;
                        ToggleFloat();
                        Reply(view, id, !(was));
                        break;
                    }
                case "float:minimize": Reply(view, id, true); HideToTray(); break;
                case "float:dragStart":
                    // 交给系统原生「移动窗口」循环拖动，窗口完全跟手。
                    // 用 BeginInvoke 让本次消息先返回，避免在 WebView2 的消息回调里同步进入系统模态循环。
                    OnUi(delegate { StartNativeDrag(); });
                    Reply(view, id, true); break;
                case "float:resizeStart":
                    // 交给系统原生「缩放窗口」循环，由 OS 逐帧调整窗口边界（与拖动同一套机制）。
                    if (FloatForm != null && p != null)
                    {
                        string d = Str(p, "dir");
                        OnUi(delegate { StartNativeResize(d); });
                    }
                    Reply(view, id, true); break;

                case "vision:once":
                    {
                        long h0;
                        string durl = CaptureCleanDataUrl(out h0);
                        if (string.IsNullOrEmpty(durl)) { ReplyError(view, id, "截屏失败"); break; }
                        LastHash = h0;
                        LastCallUtc = DateTime.UtcNow;
                        RecognizeOnce(durl);
                        Reply(view, id, true);
                        break;
                    }
                case "vision:start": StartVision(); Reply(view, id, true); break;
                case "vision:stop": StopVision(); Reply(view, id, true); break;
                case "vision:toggle": ToggleVision(); Reply(view, id, true); break;
                case "bank:get":
                    {
                        var bres = new Dictionary<string, object>();
                        bres["count"] = BankCount();
                        Reply(view, id, bres);
                        break;
                    }
                case "bank:clear":
                    {
                        try { string f = Path.Combine(DataDir, "bank.json"); if (File.Exists(f)) File.Delete(f); } catch { }
                        Reply(view, id, 0);
                        break;
                    }
                case "app:quit": Reply(view, id, true); QuitApp(); break;

                case "page:scan":
                    ScanPage(view, id);
                    break;
                case "page:apply":
                    ApplyAnswers(view, id);
                    break;
                case "page:login":
                    AutoLoginTried = true;
                    AutoLogin();
                    Reply(view, id, true);
                    break;
                case "page:open":
                    Navigate(Str(p, "url").Length > 0 ? Str(p, "url") : HOME_URL);
                    Reply(view, id, true);
                    break;
                case "settings:open":
                    OpenSettings(p != null ? Str(p, "tab") : null);
                    Reply(view, id, true);
                    break;

                case "file:pickBank":
                    {
                        var dlg = new OpenFileDialog();
                        dlg.Title = "选择题库 Markdown 文件";
                        dlg.Filter = "Markdown (*.md;*.markdown;*.txt)|*.md;*.markdown;*.txt|全部文件 (*.*)|*.*";
                        if (dlg.ShowDialog(SettingsForm) != DialogResult.OK) { Reply(view, id, null); break; }
                        var res = new Dictionary<string, object>();
                        res["path"] = dlg.FileName;
                        res["name"] = Path.GetFileName(dlg.FileName);
                        res["text"] = File.ReadAllText(dlg.FileName, Encoding.UTF8);
                        Reply(view, id, res);
                        break;
                    }
                case "file:saveText":
                    {
                        var sdlg = new SaveFileDialog();
                        sdlg.Title = "保存结果";
                        sdlg.FileName = Str(p, "defaultPath");
                        sdlg.Filter = "Markdown (*.md)|*.md|JSON (*.json)|*.json|全部文件 (*.*)|*.*";
                        if (sdlg.ShowDialog(SettingsForm) != DialogResult.OK) { Reply(view, id, null); break; }
                        File.WriteAllText(sdlg.FileName, p != null && p.ContainsKey("content") ? Convert.ToString(p["content"]) : "", new UTF8Encoding(false));
                        Reply(view, id, sdlg.FileName);
                        break;
                    }
                case "shell:open":
                    {
                        string url = Str(p, "url");
                        if (url.Length == 0) url = Convert.ToString(msg["payload"]);
                        Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
                        Reply(view, id, true);
                        break;
                    }
                case "app:info":
                    {
                        var info = new Dictionary<string, object>();
                        info["portableDir"] = ExeDir;
                        info["configPath"] = ConfigPath;
                        info["dataDir"] = DataDir;
                        info["version"] = "1.0.0";
                        info["electron"] = "WebView2 " + (Env != null ? Env.BrowserVersionString : "?");
                        info["packaged"] = true;
                        Reply(view, id, info);
                        break;
                    }
                default:
                    ReplyError(view, id, "未知消息类型: " + type);
                    break;
            }
        }
        catch (Exception ex)
        {
            Log("!! 处理 " + type + " 失败: " + ex.Message);
            ReplyError(view, id, ex.Message);
        }
        finally { CurrentMsg = null; }
    }

    /* ------------------------------ 读取页面题目 ------------------------------ */

    /** 在页面里运行的读取脚本：返回题目数组（与大软件的数据结构一致） */
    const string READ_PAGE_JS = @"
(function () {
  var clean = function (s) { return String(s || '').replace(/\s+/g, ' ').trim(); };
  var LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  // 用 .subject_stem 判定是否为一道题——填空题/简答题没有 .nodeLab，
  // 若按 .nodeLab 过滤会把它们整题丢掉（这就是以前有些题被跳过、且没有日志的原因）。
  var subs = Array.prototype.filter.call(
    document.querySelectorAll('.examPaper_subject'),
    function (s) { return s.querySelector('.subject_stem') || s.querySelector('.nodeLab'); });

  // 视频弹题
  if (!subs.length) {
    var dlg = document.querySelector('#playTopic-dialog .topic');
    if (dlg) {
      var typeName = clean((dlg.querySelector('.title-tit') || {}).innerText);
      var stemEl = dlg.querySelector('.topic-title span:not(.title-tit)');
      var opts = Array.prototype.map.call(dlg.querySelectorAll('.topic-item'), function (it, i) {
        var letter = clean((it.querySelector('.topic-option-item') || {}).innerText).replace(/[.\s]/g, '');
        return { key: letter || LABELS[i], text: clean((it.querySelector('.item-topic') || {}).innerText) };
      });
      var t = /多选/.test(typeName) ? 'multiple' : /判断/.test(typeName) ? 'judge' : 'single';
      return [{ id: 1, number: '1', section: '', type: t, stem: clean(stemEl ? stemEl.innerText : ''), options: opts }];
    }
    return [];
  }

  return Array.prototype.map.call(subs, function (s, qi) {
    var headText = clean((s.querySelector('.subject_stem') || {}).innerText);
    var m = headText.match(/【(.+?)】/);
    var typeName = m ? m[1] : '';
    var type = /多选|不定项/.test(typeName) ? 'multiple'
      : /判断/.test(typeName) ? 'judge'
      : /填空/.test(typeName) ? 'blank'
      : /简答|问答|论述/.test(typeName) ? 'essay' : 'single';

    var options = Array.prototype.map.call(s.querySelectorAll('.nodeLab'), function (lab, i) {
      var inp = lab.querySelector('input');
      var rowText = clean(lab.innerText);
      // 整行开头的选项字母（形如 A. / A、 / A)），其余是正文
      var rm = rowText.match(/^([A-Za-z])\s*[.、)）]\s*([\s\S]*)$/);

      // 选项正文：在 .node_detail / .examquestions-answer 里取**最长**的非空文本。
      // 不能只用 querySelector('.node_detail, .examquestions-answer')——它只返回文档中
      // 靠前的那个；若该元素是空占位、文字其实在另一个里，就会读成空（判断题常这样）。
      var txt = '';
      var boxes = lab.querySelectorAll('.node_detail, .examquestions-answer');
      for (var bi = 0; bi < boxes.length; bi++) {
        var bt = clean(boxes[bi].innerText);
        if (bt.length > txt.length) txt = bt;
      }
      // 兜底：上面都读不到时，用整行文字剥掉开头的选项字母
      if (!txt) txt = rm ? rm[2] : rowText;

      // 选项字母：优先整行开头的字母，其次 .label 里的 span，最后按下标给 A/B/C…
      var letter = rm ? rm[1].toUpperCase() : '';
      if (!letter) {
        var letterSpan = lab.querySelector('.label span');
        letter = clean(letterSpan ? letterSpan.innerText : '').replace(/[.、)）\s]/g, '');
      }
      return {
        key: letter || LABELS[i],
        id: inp ? inp.value : null,
        text: txt
      };
    });

    // 题干：优先 .subject_describe；真实考试页若没有这个类，就从 .subject_stem 里
    // 剔掉「题号 / 题型标签 / 分值 / 选项」等装饰块，剩下的当题干。
    var stem = clean((s.querySelector('.subject_describe') || {}).innerText);
    if (!stem) {
      var st = s.querySelector('.subject_stem');
      if (st) {
        var clone = st.cloneNode(true);
        var junk = clone.querySelectorAll('.subject_num, .subject_type_annex, .subject_type, .nodeLab, .subject_node');
        Array.prototype.forEach.call(junk, function (n) { if (n.parentNode) n.parentNode.removeChild(n); });
        stem = clean(clone.innerText).replace(/^\s*\d+\s*[.、)）]\s*/, '');
      }
    }

    return {
      id: qi + 1,
      number: String(qi + 1),
      section: '',
      type: type,
      stem: stem,
      options: options
    };
  });
})()";

    /**
     * 注入到页面的抓包脚本：把 XHR / fetch 的响应存进 window.__zhs_net（只留最近 60 条）。
     * 用于从「取题接口」的原始 JSON 里拿题干——页面本身把题干做成了非文本，DOM 读不到。
     */
    const string CAPTURE_JS = @"(function(){
  if (window.__zhs_net) return;
  window.__zhs_net = [];
  var cap = function (url, body) {
    try {
      window.__zhs_net.push({ url: String(url || '').slice(0, 220), body: String(body || '').slice(0, 300000) });
      if (window.__zhs_net.length > 60) window.__zhs_net.shift();
    } catch (e) {}
  };
  var OX = XMLHttpRequest.prototype.open, OS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { try { this.__zhs_url = u; } catch (e) {} return OX.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () {
    var x = this;
    try { x.addEventListener('load', function () { try { cap(x.__zhs_url, x.responseText); } catch (e) {} }); } catch (e) {}
    return OS.apply(this, arguments);
  };
  var of = window.fetch;
  if (of) {
    window.fetch = function () {
      var u = arguments[0];
      var p = of.apply(this, arguments);
      try {
        p.then(function (r) {
          try { r.clone().text().then(function (t) { cap((typeof u === 'string') ? u : (u && u.url), t); }); } catch (e) {}
        });
      } catch (e) {}
      return p;
    };
  }
})();";

    /* ------------------------------ 弹窗接住（隐藏辅助窗口） ------------------------------ */

    static Form PopupForm;
    static WebView2 PopupView;
    static bool PopupHostReady;

    /**
     * 预先建好一个隐藏的 WebView2，专门用来接 window.open 的弹窗。
     * 必须在 NewWindowRequested 之前就绪（那个事件必须同步响应，没法等异步初始化）。
     */
    static async void InitPopupHost()
    {
        if (PopupForm != null) return;
        try
        {
            PopupForm = new Form();
            PopupForm.FormBorderStyle = FormBorderStyle.None;
            PopupForm.ShowInTaskbar = false;
            PopupForm.StartPosition = FormStartPosition.Manual;
            PopupForm.Location = new Point(-32000, -32000);   // 挪到屏幕外
            PopupForm.Size = new Size(480, 360);
            PopupForm.Text = "（内部）弹窗接收器";

            PopupView = new WebView2();
            PopupView.Dock = DockStyle.Fill;
            PopupForm.Controls.Add(PopupView);
            PopupForm.Show();                                  // 必须 Show 才有句柄
            await PopupView.EnsureCoreWebView2Async(Env);

            var cw = PopupView.CoreWebView2;
            cw.NavigationStarting += delegate(object s, CoreWebView2NavigationStartingEventArgs e)
            {
                string u = e.Uri;
                if (u != null && u.StartsWith("http"))
                {
                    Log("弹窗要去: " + u + " → 转给主窗口");
                    try { e.Cancel = true; } catch { }
                    try
                    {
                        MainView.CoreWebView2.Navigate(u);
                        MainForm.BringToFront();
                        MainForm.Activate();
                        SetStatus("已在主窗口打开（弹窗已并入）");
                    }
                    catch (Exception ex) { Log("!! 主窗口导航失败: " + ex.Message); }
                }
                else Log("弹窗先落在: " + (u ?? "(空)"));
            };

            // 有些弹窗是 window.open() 之后纯 document.write 写内容、从不跳转：
            // 这种情况没有可转的地址，只能把接收器里的内容搬进主窗口。
            cw.NavigationCompleted += delegate(object s, CoreWebView2NavigationCompletedEventArgs e)
            {
                string u = "";
                try { u = cw.Source; } catch { }
                if (u == null || u == "" || u.StartsWith("about:")) TryCopyPopupContent(3);
            };

            PopupHostReady = true;
            Log("弹窗接收器已就绪");
        }
        catch (Exception ex) { Log("!! 弹窗接收器创建失败: " + ex.Message); }
    }

    /** 把「只写了内容、没跳转」的弹窗内容搬进主窗口 */
    static async void TryCopyPopupContent(int tries)
    {
        for (int i = 0; i < tries; i++)
        {
            await Task.Delay(400);
            if (PopupView == null || PopupView.CoreWebView2 == null) return;
            string raw;
            try
            {
                raw = await PopupView.CoreWebView2.ExecuteScriptAsync(
                    "(function(){try{return document.documentElement.outerHTML||'';}catch(e){return '';}})()");
            }
            catch { return; }
            string html = null;
            try { html = Js.Deserialize<string>(raw); } catch { }
            if (string.IsNullOrEmpty(html)) continue;
            if (html.Length > 300 && html.IndexOf("<body", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                Log("弹窗只写了内容（无跳转），搬进主窗口，长度 " + html.Length);
                try
                {
                    MainView.CoreWebView2.NavigateToString(html);
                    MainForm.BringToFront();
                    MainForm.Activate();
                    SetStatus("已在主窗口打开（弹窗内容已并入）");
                }
                catch (Exception ex) { Log("!! 搬运失败: " + ex.Message); }
                return;
            }
        }
    }

    /** 取弹窗接收器（未就绪时返回 null，调用方走兜底） */
    static WebView2 EnsurePopupHost()
    {
        if (!PopupHostReady || PopupView == null || PopupView.CoreWebView2 == null) return null;
        // 复位，准备接下一个弹窗
        try { PopupView.CoreWebView2.Navigate("about:blank"); } catch { }
        return PopupView;
    }

    /* ------------------------------ 自动登录 ------------------------------ */
    // 选择器均已在真实登录页核对过（见 recon/login/login-dom2.json）

    static string JsLit(string s) { return Js.Serialize(s ?? ""); }

    /** 在主窗口里执行脚本；出错（比如正在导航）返回 null */
    static async Task<string> Exec(string js)
    {
        try
        {
            if (MainView == null || MainView.CoreWebView2 == null) return null;
            return await MainView.CoreWebView2.ExecuteScriptAsync(js);
        }
        catch (Exception ex)
        {
            Log("  exec 失败: " + ex.Message.Split('\n')[0]);
            return null;
        }
    }

    /** 等页面加载完成 */
    static async Task WaitForLoad(int timeoutMs)
    {
        var t0 = DateTime.Now;
        while ((DateTime.Now - t0).TotalMilliseconds < timeoutMs)
        {
            var r = await Exec("document.readyState");
            if (r != null && r.Contains("complete")) return;
            await Task.Delay(500);
        }
    }

    /** 点最匹配该文字的最小元素（避免点到外层大容器） */
    static string ClickExactTextJs(string text)
    {
        return "(function(){var want=" + JsLit(text) + ";"
            + "var els=Array.prototype.slice.call(document.querySelectorAll('div,span,a,button,li'));"
            + "var best=null,bestArea=1e18;"
            + "for(var i=0;i<els.length;i++){"
            + "  if((els[i].innerText||'').trim()!==want) continue;"
            + "  var r=els[i].getBoundingClientRect(); if(r.width<=0||r.height<=0) continue;"
            + "  var a=r.width*r.height; if(a<bestArea){bestArea=a;best=els[i];}"
            + "} if(!best) return false; best.click(); return true;})()";
    }

    static string SelectSchoolJs(string school)
    {
        return "(function(){var inp=document.querySelector('input.el-select__input'); if(!inp) return false;"
            + "inp.click(); inp.focus();"
            + "var setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;"
            + "setter.call(inp," + JsLit(school) + ");"
            + "inp.dispatchEvent(new Event('input',{bubbles:true}));"
            + "inp.dispatchEvent(new KeyboardEvent('keyup',{bubbles:true,key:'a'}));"
            + "return true;})()";
    }

    static string PickSchoolJs(string school)
    {
        return "(function(){var want=" + JsLit(school) + ".replace(/\\s+/g,'');"
            + "var items=Array.prototype.slice.call(document.querySelectorAll('.el-select-dropdown__item'));"
            + "var vis=items.filter(function(e){var r=e.getBoundingClientRect();return r.width>0&&r.height>0;});"
            + "if(!vis.length) return 'no-dropdown';"
            + "var norm=function(e){return (e.innerText||'').replace(/\\s+/g,'').trim();};"
            + "for(var i=0;i<vis.length;i++){ if(norm(vis[i])===want){vis[i].click();return 'exact';} }"
            + "for(var j=0;j<vis.length;j++){ if(norm(vis[j]).indexOf(want)>=0){vis[j].click();return 'contains';} }"
            + "return 'none:'+vis.slice(0,5).map(norm).join('|');})()";
    }

    static string SetInputJs(string selector, string value)
    {
        return "(function(){var el=document.querySelector(" + JsLit(selector) + "); if(!el) return false;"
            + "var setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;"
            + "setter.call(el," + JsLit(value) + ");"
            + "el.dispatchEvent(new Event('input',{bubbles:true}));"
            + "el.dispatchEvent(new Event('change',{bubbles:true}));"
            + "return true;})()";
    }

    const string CHECK_AGREE_JS =
        "(function(){var cb=document.querySelector('input.el-checkbox__original');"
        + "if(cb&&cb.checked) return 'already';"
        + "var box=document.querySelector('.el-checkbox');"
        + "if(box){box.click(); return 'clicked';} return 'none';})()";

    const string CLICK_LOGIN_JS =
        "(function(){var b=document.querySelector('div.btn-block__grandient_login');"
        + "if(!b) return false; b.click(); return true;})()";

    /** 调一次登录态接口，把结果写到全局变量（ExecuteScriptAsync 不会等 Promise） */
    static async Task<int> CheckLoginCode()
    {
        await Exec("(function(){window.__zhsCode=null;"
            + "fetch(" + JsLit(API_USERINFO) + ",{credentials:'include'})"
            + ".then(function(r){return r.json();})"
            + ".then(function(j){window.__zhsCode=j.code;})"
            + ".catch(function(){window.__zhsCode=-1;});"
            + "return true;})()");
        for (int i = 0; i < 12; i++)
        {
            await Task.Delay(400);
            var raw = await Exec("window.__zhsCode");
            if (raw == null || raw == "null") continue;
            int code;
            if (int.TryParse(raw.Trim('"'), out code)) return code;
        }
        return -1;
    }

    /** 页面上是否出现了可见的易盾验证码 */
    static async Task<bool> CaptchaVisible()
    {
        var raw = await Exec("(function(){var n=0;"
            + "var ys=document.querySelectorAll('[class*=\"yidun\"]');"
            + "for(var i=0;i<ys.length;i++){var r=ys[i].getBoundingClientRect(); if(r.width>100&&r.height>60) n++;}"
            + "var fs=document.querySelectorAll('iframe');"
            + "for(var i=0;i<fs.length;i++){if(/dun\\.163|captcha|yidun/i.test(fs[i].src||'')) n++;}"
            + "return n;})()");
        int n;
        return raw != null && int.TryParse(raw, out n) && n > 0;
    }

    /**
     * 自动登录：打开登录页 → 学号登录 → 选学校 → 填学号密码 → 勾协议 → 提交 → 轮询。
     * 遇易盾验证码时提示人工完成，脚本继续等待。
     */
    static async void AutoLogin()
    {
        if (AutoLoginRunning)
        {
            Log("自动登录：已在执行中，忽略本次调用");
            return;
        }
        AutoLoginRunning = true;
        try { await AutoLoginCore(); }
        catch (Exception ex) { Log("!! 自动登录异常: " + ex.Message); SetStatus("自动登录失败：" + ex.Message); }
        finally { AutoLoginRunning = false; }
    }

    static async Task AutoLoginCore()
    {
        var cfg = ReadConfig();
        string school = Str(cfg, "school");
        string sid = Str(cfg, "studentId");
        string pwd = Str(cfg, "password");
        if (school.Length == 0 || sid.Length == 0 || pwd.Length == 0)
        {
            SetStatus("自动登录需要「学校 / 学号 / 密码」——已打开设置页，请填写后点「立即自动登录」");
            Log("自动登录：缺少凭据，打开设置页的账号区");
            OpenSettings("settings");
            return;
        }

        Log("自动登录：开始（学校=" + school + "，学号=" + sid + "，密码长度=" + pwd.Length + "）");
        SetStatus("自动登录：正在打开登录页…");
        Navigate(LOGIN_URL);
        await Task.Delay(2000);
        await WaitForLoad(30000);
        await Task.Delay(2500);

        if (await CheckLoginCode() == 200)
        {
            SetStatus("已经是登录状态，无需重新登录");
            Log("自动登录：已登录，直接跳过");
            Navigate(HOME_URL);
            return;
        }

        SetStatus("自动登录：切换到「学号登录」…");
        string r1 = await Exec(ClickExactTextJs("学号登录"));
        Log("  点击「学号登录」: " + r1);
        await Task.Delay(2200);

        SetStatus("自动登录：选择学校「" + school + "」…");
        await Exec(SelectSchoolJs(school));
        await Task.Delay(3000);
        string picked = await Exec(PickSchoolJs(school));
        Log("  学校下拉: " + picked);
        await Task.Delay(1500);

        SetStatus("自动登录：填写学号与密码…");
        string r2 = await Exec(SetInputJs("input[name=\"unid\"]", sid));
        string r3 = await Exec(SetInputJs("input[type=\"password\"]", pwd));
        Log("  填学号: " + r2 + "，填密码: " + r3);
        await Task.Delay(700);

        string agree = await Exec(CHECK_AGREE_JS);
        Log("  勾选协议: " + agree);
        await Task.Delay(700);

        SetStatus("自动登录：提交…");
        string submitted = await Exec(CLICK_LOGIN_JS);
        Log("  提交: " + submitted);

        var t0 = DateTime.Now;
        bool announced = false;
        while ((DateTime.Now - t0).TotalMinutes < 8)
        {
            await Task.Delay(3000);
            if (await CheckLoginCode() == 200)
            {
                SetStatus("✅ 自动登录成功");
                Log("自动登录：成功");
                await Task.Delay(1200);
                Navigate(HOME_URL);
                return;
            }
            if (!announced && await CaptchaVisible())
            {
                announced = true;
                SetStatus("⚠️ 出现人机验证，请在上方页面里手动完成（我会继续等待）");
                Log("自动登录：检测到易盾验证码，等待人工完成");
            }
        }
        SetStatus("自动登录超时，请手动登录");
        Log("自动登录：超时");
    }

    /* ------------------------------ 扫描 / 回填 ------------------------------ */

    static async void ScanPage(WebView2 replyView, int replyId)
    {
        if (MainView == null || MainView.CoreWebView2 == null)
        {
            SetStatus("浏览器还没准备好");
            if (replyView != null) ReplyError(replyView, replyId, "浏览器还没准备好");
            return;
        }

        // 先检查 AI 配置：没配 key 就直接引导去填，别等到后端回 400 才报错
        var cfg = ReadConfig();
        if (Str(cfg, "visionApiKey").Length == 0 || Str(cfg, "reasonApiKey").Length == 0)
        {
            SetStatus("还没配置 AI 密钥 —— 已在设置页，请填写识别/思考模型密钥后重试");
            Log("扫描中止：未配置 API 密钥");
            OpenSettings("settings");
            if (replyView != null) ReplyError(replyView, replyId, "还没配置 AI 密钥：请在「设置」页填写识别模型与思考模型的密钥，保存后再扫描。");
            return;
        }

        SetStatus("正在读取页面题目…");
        Log("扫描：读取页面");
        try
        {
            string raw = await MainView.CoreWebView2.ExecuteScriptAsync("(" + READ_PAGE_JS + ")");
            var list = Js.Deserialize<List<Dictionary<string, object>>>(raw);
            if (list == null || list.Count == 0)
            {
                SetStatus("页面上没读到题目 —— 请先进入作业/考试页面，或等页面加载完");
                Log("扫描：未读到题目");
                if (replyView != null) ReplyError(replyView, replyId, "页面上没读到题目，请先打开作业/考试页面。");
                return;
            }
            // —— 诊断：首题结构树 + 页面可见文字 ——
            // 树里能看到文本节点、body.innerText 能看到用户肉眼可见的文字；
            // 两者一对比就知道题干到底「在不在 DOM 里」（不在就是图片/动态字体渲染，得换思路）。
            try
            {
                string tree = TrimJson(await MainView.CoreWebView2.ExecuteScriptAsync(
@"(function(){
  var s=document.querySelector('.examPaper_subject');
  if(!s) return '';
  var out=[];
  var walk=function(el,d){
    if(d>6) return;
    var tag=el.tagName.toLowerCase();
    var cls=(el.className||'').toString().split(/\s+/).slice(0,2).join('.');
    var own='';
    for(var i=0;i<el.childNodes.length;i++){var n=el.childNodes[i];if(n.nodeType===3) own+=n.nodeValue;}
    own=own.replace(/\s+/g,' ').trim();
    if(tag==='img'){var src=el.getAttribute('src')||'';own='[img]'+(src?(' '+src.slice(-22)):'');}
    out.push(new Array(d+1).join('  ')+tag+(cls?'.'+cls:'')+(own?(' :: '+own.slice(0,50)):''));
    for(var j=0;j<el.children.length;j++) walk(el.children[j],d+1);
  };
  walk(s,0);
  var d=document.querySelector('.subject_describe');
  var cs=d?getComputedStyle(d):null;
  out.push('[describe] textContent='+(d?d.textContent.slice(0,60):'?')+' innerText='+(d?d.innerText.slice(0,60):'?')+' bg='+(cs?cs.backgroundImage.slice(0,60):'?')+' kids='+(d?d.children.length:'?'));
  return out.join(' | ');
})()"));
                Log("  首题结构: " + Cut(tree, 1800));
            }
            catch (Exception ex) { Log("!! 打印首题结构失败: " + ex.Message); }
            try
            {
                string bodyText = TrimJson(await MainView.CoreWebView2.ExecuteScriptAsync(
@"(function(){
  var t=document.body.innerText||'';
  return 'len='+t.length+' :: '+t.replace(/\s+/g,' ').slice(0,1500);
})()"));
                Log("  页面可见文字: " + bodyText);
            }
            catch (Exception ex) { Log("!! 打印页面文字失败: " + ex.Message); }
            // 从抓到的网络响应里找「取题接口」——真实题干多半在这里的 JSON 里
            try
            {
                string capRaw = await MainView.CoreWebView2.ExecuteScriptAsync(
@"(function(){
  var arr = window.__zhs_net || [];
  var out = [];
  for (var i = 0; i < arr.length; i++) {
    var b = arr[i].body || '';
    if (/subject|examPaper|question|题干|选项|answerList|paperId|topic|exam/i.test(b) || /exam|paper|topic|question|quiz/i.test(arr[i].url)) {
      out.push({ url: arr[i].url, len: b.length, snip: b.slice(0, 700) });
    }
  }
  return { total: arr.length, hits: out.slice(-6) };
})()");
                var capObj = Js.Deserialize<Dictionary<string, object>>(capRaw);
                if (capObj != null)
                {
                    Log("  抓包：共 " + Convert.ToString(capObj.ContainsKey("total") ? capObj["total"] : "0") + " 条，候选如下");
                    foreach (var h in AsDictList(capObj.ContainsKey("hits") ? capObj["hits"] : null))
                        Log("  包[" + Str(h, "len") + "] " + Str(h, "url") + " :: " + Cut(Str(h, "snip"), 700));
                }
            }
            catch (Exception ex) { Log("!! 打印抓包失败: " + ex.Message); }

            Log("扫描到 " + list.Count + " 题，开始生成答案…");
            SetStatus("扫描到 " + list.Count + " 题，正在调用 AI 生成答案…");

            // 交给内置后端调用 AI（复用同一份 config.json 与提示词）
            string answersJson = await Task.Run(delegate { return PostAnswer(raw); });
            var answers = Js.Deserialize<Dictionary<string, object>>(answersJson);

            var state = new Dictionary<string, object>();
            state["questions"] = list;
            state["answers"] = answers;
            state["sourceName"] = "当前网页";
            state["cursor"] = 0;
            StateJson = Js.Serialize(state);

            var evt = new Dictionary<string, object>();
            evt["event"] = "state:update";
            evt["data"] = state;
            Broadcast(Js.Serialize(evt));

            int got = 0;
            foreach (var kv in answers) { var a = kv.Value as Dictionary<string, object>; if (a != null && Str(a, "answer").Length > 0) got++; }
            LogScanDetail(list, answers);
            SetStatus("扫描完成：" + list.Count + " 题 / " + got + " 个答案（看「助手面板」或点「回填本页」）");
            Log("扫描完成：" + list.Count + " 题，" + got + " 个答案");
            if (replyView != null) Reply(replyView, replyId, state);
        }
        catch (Exception ex)
        {
            Log("!! 扫描失败: " + ex.ToString());
            SetStatus("扫描失败：" + ex.Message);
            if (replyView != null) ReplyError(replyView, replyId, ex.Message);
        }
    }

    /** 把题目交给内置后端 /api/answer（后端读 config.json 里的 AI 配置） */
    static string PostAnswer(string questionsJson)
    {
        string url = Origin + "/api/answer";
        string body = "{\"questions\":" + questionsJson + "}";
        var req = (HttpWebRequest)WebRequest.Create(url);
        req.Method = "POST";
        req.ContentType = "application/json; charset=utf-8";
        req.Timeout = 180000;
        req.ReadWriteTimeout = 180000;
        byte[] bytes = Encoding.UTF8.GetBytes(body);
        req.ContentLength = bytes.Length;
        using (var rs = req.GetRequestStream()) rs.Write(bytes, 0, bytes.Length);

        string text;
        try
        {
            using (var resp = (HttpWebResponse)req.GetResponse())
            using (var sr = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                text = sr.ReadToEnd();
        }
        catch (WebException we)
        {
            // 后端会把真正原因写在响应体里（如"配置不完整，缺少 apiKey"），必须读出来
            string detail = we.Message;
            var er = we.Response as HttpWebResponse;
            if (er != null)
            {
                try
                {
                    using (var sr = new StreamReader(er.GetResponseStream(), Encoding.UTF8))
                        detail = sr.ReadToEnd();
                }
                catch { }
            }
            throw new Exception(ExtractBackendError(detail));
        }

        var obj = Js.Deserialize<Dictionary<string, object>>(text);
        if (obj != null && obj.ContainsKey("answers")) return Js.Serialize(obj["answers"]);
        throw new Exception("后端未返回答案：" + text.Substring(0, Math.Min(200, text.Length)));
    }

    /** 从后端返回的 {"ok":false,"error":"..."} 里取出 error 文本 */
    static string ExtractBackendError(string json)
    {
        try
        {
            var o = Js.Deserialize<Dictionary<string, object>>(json);
            if (o != null && o.ContainsKey("error")) return Convert.ToString(o["error"]);
        }
        catch { }
        return json;
    }

    /**
     * 把任意集合（object[] / ArrayList / List<Dictionary<..>>）统一成字典列表。
     * 注意：JSON 反序列化后数组是 object[]，直接 `as List<object>` 会得到 null——
     * 这正是"扫描完却说没扫描过"的原因。
     */
    static List<Dictionary<string, object>> AsDictList(object o)
    {
        var list = new List<Dictionary<string, object>>();
        var arr = o as System.Collections.IEnumerable;
        if (arr == null) return list;
        foreach (var it in arr)
        {
            var d = it as Dictionary<string, object>;
            if (d != null) list.Add(d);
        }
        return list;
    }

    /**
     * 诊断：把每题的类型 / 题干 / 选项，以及 AI 的答案与理由写进日志。
     * 用于定位「某类题型没做」——先看是"题目没读全"还是"模型答非所问"。
     */
    static void LogScanDetail(List<Dictionary<string, object>> list, Dictionary<string, object> answers)
    {
        try
        {
            foreach (var q in list)
            {
                string qid = Str(q, "id");
                var opts = q.ContainsKey("options") ? AsDictList(q["options"]) : new List<Dictionary<string, object>>();
                var optTexts = new List<string>();
                foreach (var o in opts) optTexts.Add(Str(o, "key") + "." + Str(o, "text"));
                var a = (answers != null && answers.ContainsKey(qid)) ? answers[qid] as Dictionary<string, object> : null;
                Log("  Q" + qid + " [" + Str(q, "type") + "] " + Cut(Str(q, "stem"), 40)
                    + " | 选项" + optTexts.Count + ": " + Cut(string.Join(" / ", optTexts.ToArray()), 90)
                    + " | AI=" + Cut(Str(a, "answer"), 20) + " 理由=" + Cut(Str(a, "reason"), 40));
            }
        }
        catch (Exception ex) { Log("!! 打印扫描详情失败: " + ex.Message); }
    }

    /** 截断成单行，避免日志里塞进整段题干 */
    static string Cut(string s, int n)
    {
        s = (s ?? "").Replace("\r", " ").Replace("\n", " ");
        return s.Length <= n ? s : s.Substring(0, n) + "...";
    }

    /** BuildClickJs 返回形如 "... | 0101"：末段出现 1 才算真的选中过选项 */
    static bool SelectedAny(string result)
    {
        if (result == null) return false;
        int bar = result.LastIndexOf('|');
        if (bar < 0) return false;
        for (int i = bar + 1; i < result.Length; i++) if (result[i] == '1') return true;
        return false;
    }

    /**
     * 判断题语义判定：把「正确/对/是/√/true」判为 true，「错误/错/否/×/false」判为 false，其余为 null。
     * 页面选项与 AI 答案用词经常不一致（页面"对"、AI"正确"），靠语义而不是字面去匹配。
     */
    static string JudgeSemantic(string text)
    {
        string t = (text ?? "").Replace(" ", "").Replace("\u3000", "").Replace(".", "").Replace("。", "")
            .Replace("、", "").Replace("，", "").Replace("；", "").Replace("：", "").ToLowerInvariant();
        if (t.Length == 0) return null;
        string[] yes = { "正确", "对", "对的", "是", "是的", "true", "t", "√", "✓", "v" };
        string[] no = { "错误", "错", "错的", "不对", "否", "不是", "false", "f", "×", "✗", "x" };
        foreach (var w in yes) if (t == w) return "true";
        foreach (var w in no) if (t == w) return "false";
        foreach (var w in yes) if (w.Length > 1 && t.Contains(w)) return "true";
        foreach (var w in no) if (w.Length > 1 && t.Contains(w)) return "false";
        return null;
    }

    /**
     * AI 是否「没给出可用答案」：弃权、自述读不到题、或明显不是选项的文字。
     * 命中就宁可不填——填错比空着更糟。
     */
    static bool IsNoAnswer(string ans)
    {
        string t = (ans ?? "").Replace(" ", "").Replace("\u3000", "").Trim();
        if (t.Length == 0) return true;
        // 明确的弃权 / 自述读不到题（长词用「包含」匹配，正常答案不会碰到）
        string[] phrases = { "无法判断", "无法确定", "无法作答", "无法识别", "不能确定", "不确定", "不知道", "缺少题干", "题干缺失", "题干为空", "无选项", "没有选项" };
        foreach (var w in phrases) if (t.Contains(w)) return true;
        // 短词只做整串相等，避免误伤（例如答案正文里出现「无」字）
        string[] exact = { "略", "无", "未知", "n/a", "na", "null", "none" };
        foreach (var w in exact) if (t.Equals(w, StringComparison.OrdinalIgnoreCase)) return true;
        return false;
    }

    /** 按扫描结果点击页面选项（只点选项，不点提交） */
    static async void ApplyAnswers(WebView2 replyView, int replyId)
    {
        if (MainView == null || MainView.CoreWebView2 == null)
        {
            SetStatus("浏览器还没准备好");
            if (replyView != null) ReplyError(replyView, replyId, "浏览器还没准备好");
            return;
        }
        var st = Js.Deserialize<Dictionary<string, object>>(StateJson);
        var questions = st.ContainsKey("questions") ? AsDictList(st["questions"]) : new List<Dictionary<string, object>>();
        if (questions.Count == 0)
        {
            SetStatus("还没扫描过题目，请先点「扫描本页」");
            if (replyView != null) ReplyError(replyView, replyId, "还没扫描过题目，请先点「扫描本页」。");
            return;
        }

        var answers = st.ContainsKey("answers")
            ? Js.Deserialize<Dictionary<string, object>>(Js.Serialize(st["answers"]))
            : new Dictionary<string, object>();

        SetStatus("正在回填…（模拟人类节奏，绝不提交）");
        Log("回填：开始，共 " + questions.Count + " 题");
        int applied = 0, skipped = 0, failed = 0;
        var failedList = new List<int>();
        var skippedWhy = new List<string>();

        for (int qi = 0; qi < questions.Count; qi++)
        {
            var q = questions[qi] as Dictionary<string, object>;
            if (q == null) continue;
            var a = answers.ContainsKey((qi + 1).ToString()) ? answers[(qi + 1).ToString()] as Dictionary<string, object> : null;
            string ans = Str(a, "answer");
            if (ans.Length == 0)
            {
                skipped++; Log("  第 " + (qi + 1) + " 题 → 跳过：AI 没给出答案");
                skippedWhy.Add((qi + 1) + "题（AI 没给答案）");
                continue;
            }

            var allOpts = q.ContainsKey("options") ? AsDictList(q["options"]) : new List<Dictionary<string, object>>();
            string qtype = Str(q, "type");

            // —— 安全阀：读不到题目、或 AI 答不出来时，宁可不填，也不瞎填 —
            // （题干都没读到就让 AI 猜，猜出来的基本是错的，比空着更糟。）
            if (Str(q, "stem").Length == 0)
            {
                skipped++; skippedWhy.Add((qi + 1) + "题（题干没读到，未填）");
                Log("  第 " + (qi + 1) + " 题 → 跳过：题干为空，未填");
                continue;
            }
            if (IsNoAnswer(ans))
            {
                skipped++; skippedWhy.Add((qi + 1) + "题（AI 无法作答，未填）");
                Log("  第 " + (qi + 1) + " 题 → 跳过：AI 未给出可用答案（" + ans + "）");
                continue;
            }
            // 选择题（单选/多选/判断）却没读到选项 → 说明没读全，别当填空题乱写
            if (allOpts.Count == 0 && (qtype == "single" || qtype == "multiple" || qtype == "judge"))
            {
                skipped++; skippedWhy.Add((qi + 1) + "题（选择题没读到选项，未填）");
                Log("  第 " + (qi + 1) + " 题 → 跳过：选择题没读到选项，未填");
                continue;
            }

            // 没有选项 → 填空题 / 简答题：往输入框里写文字
            if (allOpts.Count == 0)
            {
                string r2 = null;
                try { r2 = TrimJson(await MainView.CoreWebView2.ExecuteScriptAsync(BuildFillTextJs(qi, Str(q, "stem"), ans))); }
                catch (Exception ex) { Log("!! 第 " + (qi + 1) + " 题填文本异常: " + ex.Message); }
                Log("  第 " + (qi + 1) + " 题[填空/简答] → " + r2);
                if (r2 != null && r2.IndexOf("filled", StringComparison.Ordinal) >= 0) applied++;
                else if (r2 != null && r2.IndexOf("no-question", StringComparison.Ordinal) >= 0)
                { skipped++; skippedWhy.Add((qi + 1) + "题（页面上找不到这道题）"); }
                else if (r2 != null && r2.IndexOf("no-input", StringComparison.Ordinal) >= 0)
                { skipped++; skippedWhy.Add((qi + 1) + "题（找不到输入框，需手动填）"); }
                else { failed++; failedList.Add(qi + 1); }
                await Task.Delay(180 + new Random().Next(140));
                continue;
            }

            // 取「选中项的文字」——按文字点，不按下标点：
            // 平台的选择题选项顺序每次渲染都可能变，按下标会点错。
            var wantTexts = new List<string>();
            foreach (var o in allOpts)
            {
                string key = Str(o, "key");
                if (key.Length > 0 && ans.IndexOf(key, StringComparison.OrdinalIgnoreCase) >= 0) wantTexts.Add(Str(o, "text"));
            }
            // 判断题兜底：AI 可能答「正确/错误/对/错」而非字母 A/B。
            // 页面选项与 AI 用词常不一致（页面"对"、AI"正确"），这里按语义(true/false)匹配。
            if (wantTexts.Count == 0)
            {
                string want = JudgeSemantic(ans);
                if (want != null)
                {
                    foreach (var o in allOpts)
                    {
                        if (JudgeSemantic(Str(o, "text")) == want) { wantTexts.Add(Str(o, "text")); break; }
                    }
                    if (wantTexts.Count > 0) Log("  第 " + (qi + 1) + " 题 → 判断题语义匹配：" + ans + " → " + wantTexts[0]);
                }
            }

            if (wantTexts.Count == 0)
            {
                // 答案不是选项字母（例如判断题 AI 直接答了「正确」/「错误」）：
                // 那就拿答案本身当选项文字去匹配，而不是直接放弃。
                foreach (var piece in ans.Split(new[] { '；', ';', '、', ',', '，', '/', '|', ' ' }, StringSplitOptions.RemoveEmptyEntries))
                {
                    string t = piece.Trim();
                    if (t.Length > 0) wantTexts.Add(t);
                }
                if (wantTexts.Count == 0)
                {
                    skipped++;
                    Log("  第 " + (qi + 1) + " 题 → 跳过：答案「" + ans + "」既不是字母、也没有可用文字");
                    skippedWhy.Add((qi + 1) + "题（答案无法匹配）");
                    continue;
                }
                Log("  第 " + (qi + 1) + " 题 → 答案「" + ans + "」不是字母，改按文字匹配");
            }

            string js = BuildClickJs(qi, Str(q, "stem"), wantTexts);
            string result = null;
            try
            {
                result = await MainView.CoreWebView2.ExecuteScriptAsync(js);
                result = TrimJson(result);
            }
            catch (Exception ex)
            {
                Log("!! 第 " + (qi + 1) + " 题点击异常: " + ex.Message);
                skipped++; skippedWhy.Add((qi + 1) + "题（点击异常）");
                continue;
            }

            Log("  第 " + (qi + 1) + " 题[" + ans + "] → " + result);
            if (result != null && result.IndexOf("FAIL", StringComparison.Ordinal) >= 0)
            { failed++; failedList.Add(qi + 1); skippedWhy.Add((qi + 1) + "题（点了没生效）"); }
            else if (result == null || result.IndexOf("no-question", StringComparison.Ordinal) >= 0)
            { skipped++; skippedWhy.Add((qi + 1) + "题（页面上找不到这道题）"); }
            else if (!SelectedAny(result))
            { failed++; failedList.Add(qi + 1); skippedWhy.Add((qi + 1) + "题（选项没匹配上：" + ans + "）"); }
            else applied++;

            // 模拟人类节奏
            await Task.Delay(180 + new Random().Next(140));
        }

        string tail = skippedWhy.Count > 0 ? ("；未处理：" + string.Join("、", skippedWhy.ToArray())) : "";
        SetStatus("回填完成：已填 " + applied + " 题" + tail);
        Log("回填完成：applied=" + applied + " failed=" + failed + " skipped=" + skipped);
        if (replyView != null) Reply(replyView, replyId, applied);
    }

    /** ExecuteScriptAsync 的结果是 JSON 字面量，去掉外层引号（并还原转义） */
    static string TrimJson(string raw)
    {
        if (raw == null) return null;
        try { return Js.Deserialize<string>(raw); } catch { }
        return raw.Trim('"');
    }

    /**
     * 填空题 / 简答题：把答案文字写进题目里的输入框。
     * 答案用 "；" 分隔多个空位时，按顺序分配到多个输入框。
     */
    static string BuildFillTextJs(int qi, string stem, string answer)
    {
        var sb = new StringBuilder();
        sb.Append("(function(){");
        sb.Append("var clean=function(s){return String(s||'').replace(/\\s+/g,' ').trim();};");
        sb.Append("var norm=function(s){return clean(s).replace(/[\\s\\u3000]/g,'').replace(/[^0-9A-Za-z\\u4e00-\\u9fa5]/g,'').toLowerCase();};");
        sb.Append("var ans=").Append(JsLit(answer)).Append(";");
        sb.Append("var wantStem=").Append(JsLit(stem)).Append(";");
        sb.Append("var subs=Array.prototype.filter.call(document.querySelectorAll('.examPaper_subject'),function(s){return s.querySelector('.subject_stem')||s.querySelector('.nodeLab');});");
        sb.Append("var key=norm(wantStem).slice(0,18);");
        sb.Append("var sub=subs[").Append(qi).Append("];");
        sb.Append("var cur=sub?norm(clean((sub.querySelector('.subject_describe')||{}).innerText)):'';");
        sb.Append("if(!sub||(key&&cur.indexOf(key)<0)){for(var i=0;i<subs.length;i++){");
        sb.Append("  var t=norm(clean((subs[i].querySelector('.subject_describe')||{}).innerText));");
        sb.Append("  if(key&&t.indexOf(key)>=0){sub=subs[i];break;}}}");
        sb.Append("if(!sub)return 'no-question';");
        // 输入框：优先取选项行以外的可编辑元素
        sb.Append("var all=Array.prototype.slice.call(sub.querySelectorAll('textarea, input[type=text], input:not([type])'));");
        sb.Append("var boxes=all.filter(function(el){return !el.closest('.nodeLab');});");
        sb.Append("if(!boxes.length)boxes=all;");
        sb.Append("if(!boxes.length)return 'no-input';");
        sb.Append("var setVal=function(el,v){");
        sb.Append("  var proto=(el.tagName==='TEXTAREA')?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype;");
        sb.Append("  var setter=Object.getOwnPropertyDescriptor(proto,'value').set;");
        sb.Append("  setter.call(el,v);");
        sb.Append("  el.dispatchEvent(new Event('input',{bubbles:true}));");
        sb.Append("  el.dispatchEvent(new Event('change',{bubbles:true}));");
        sb.Append("};");
        sb.Append("var parts=String(ans).split(/[；;]/).map(function(s){return clean(s);}).filter(Boolean);");
        sb.Append("if(parts.length>1&&parts.length<=boxes.length){for(var k=0;k<parts.length;k++)setVal(boxes[k],parts[k]);}");
        sb.Append("else setVal(boxes[0],String(ans).trim());");
        sb.Append("return 'filled | '+boxes.map(function(b){return b.value;}).join(' | ');");
        sb.Append("})()");
        return sb.ToString();
    }

    /**
     * 生成点击脚本：按题干找到题目、按选项文字找到要点的选项、点完回读校验。
     * 返回形如 "=,ok,-,ok | 0101"（逐项结果 | 最终勾选状态）。
     */
    static string BuildClickJs(int qi, string stem, List<string> texts)
    {
        var sb = new StringBuilder();
        sb.Append("(function(){");
        sb.Append("var clean=function(s){return String(s||'').replace(/\\s+/g,' ').trim();};");
        sb.Append("var norm=function(s){return clean(s).replace(/[\\s\\u3000]/g,'').replace(/[^0-9A-Za-z\\u4e00-\\u9fa5]/g,'').toLowerCase();};");
        sb.Append("var wantTexts=").Append(Js.Serialize(texts)).Append(";");
        sb.Append("var wantStem=").Append(JsLit(stem)).Append(";");
        sb.Append("var subs=Array.prototype.filter.call(document.querySelectorAll('.examPaper_subject'),function(s){return s.querySelector('.subject_stem')||s.querySelector('.nodeLab');});");
        sb.Append("var key=norm(wantStem).slice(0,18);");
        sb.Append("var sub=subs[").Append(qi).Append("];");
        // 下标对不上（题干不符）时，按题干重新找题目
        sb.Append("var cur=sub?norm(clean((sub.querySelector('.subject_describe')||{}).innerText)):'';");
        sb.Append("if(!sub||(key&&cur.indexOf(key)<0)){for(var i=0;i<subs.length;i++){");
        sb.Append("  var t=norm(clean((subs[i].querySelector('.subject_describe')||{}).innerText));");
        sb.Append("  if(key&&t.indexOf(key)>=0){sub=subs[i];break;}}}");
        sb.Append("if(!sub)return 'no-question';");
        sb.Append("var labs=Array.prototype.slice.call(sub.querySelectorAll('.nodeLab'));");
        // 按选项文字定位要点的项
        sb.Append("var want={};");
        sb.Append("for(var w=0;w<wantTexts.length;w++){var wt=norm(wantTexts[w]);if(!wt)continue;");
        sb.Append("  for(var j=0;j<labs.length;j++){");
        sb.Append("    var el=labs[j].querySelector('.node_detail,.examquestions-answer')||labs[j];");
        sb.Append("    var lt=norm(clean(el.innerText));");
        sb.Append("    if(lt===wt||lt.indexOf(wt)>=0||wt.indexOf(lt)>=0){want[j]=true;break;}}}");
        sb.Append("var report=[];");
        sb.Append("for(var k=0;k<labs.length;k++){");
        sb.Append("  var inp=labs[k].querySelector('input');var should=!!want[k];");
        sb.Append("  if(inp&&inp.checked===should){report.push(should?'=':'-');continue;}");
        sb.Append("  var cands=[labs[k].querySelector('.label'),labs[k].querySelector('.fl'),inp,labs[k]];");
        sb.Append("  var ok=false;");
        sb.Append("  for(var c=0;c<cands.length&&!ok;c++){var el=cands[c];if(!el)continue;");
        sb.Append("    try{el.click();}catch(e){}");
        sb.Append("    if(inp&&inp.checked===should)ok=true;}");
        // 最后兜底：只改状态 + 补 change/input。
        // 注意不能补 click——对 checkbox 来说派发 click 会触发默认行为把状态又切回去。
        sb.Append("  if(!ok&&inp){try{if(inp.checked!==should){inp.checked=should;");
        sb.Append("    inp.dispatchEvent(new Event('input',{bubbles:true}));");
        sb.Append("    inp.dispatchEvent(new Event('change',{bubbles:true}));}");
        sb.Append("    if(inp.checked===should)ok=true;}catch(e){}}");
        sb.Append("  report.push(ok?'ok':'FAIL');}");
        sb.Append("var got=labs.map(function(l){var i=l.querySelector('input');return i&&i.checked?1:0;}).join('');");
        sb.Append("return report.join(',')+' | '+got;");
        sb.Append("})()");
        return sb.ToString();
    }
}
