// 智慧树课程助手 —— 原生 WinForms 窗口（不内嵌网页）
// 视觉基准：Linear 深色设计系统（docs/DESIGN.md、awesome-design-md/design-md/linear.app）
// 编译：csc /target:winexe /codepage:65001 /r:System.Web.Extensions.dll ...

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace ZhsCourseHelper
{
    static class Program
    {
        [STAThread]
        static void Main()
        {
            try { Native.SetProcessDPIAware(); }
            catch { }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            Application.ThreadException += delegate(object s, ThreadExceptionEventArgs e) { Report(e.Exception); };
            AppDomain.CurrentDomain.UnhandledException += delegate(object s, UnhandledExceptionEventArgs e) { Report(e.ExceptionObject as Exception); };

            Theme.Init();
            Application.Run(new MainForm());
        }

        static void Report(Exception ex)
        {
            if (ex == null) return;
            try
            {
                string path = Path.Combine(Path.GetDirectoryName(Application.ExecutablePath), "gui-error.log");
                File.AppendAllText(path, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + ex + "\r\n\r\n", Encoding.UTF8);
            }
            catch { }

            try
            {
                MessageBox.Show(ex.Message + "\r\n\r\n详细信息已写入 gui-error.log",
                    "智慧树课程助手", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            catch { }
        }
    }

    static class Native
    {
        [System.Runtime.InteropServices.DllImport("user32.dll")]
        internal static extern bool SetProcessDPIAware();

        [System.Runtime.InteropServices.DllImport("uxtheme.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
        internal static extern int SetWindowTheme(IntPtr hWnd, string pszSubAppName, string pszSubIdList);

        [System.Runtime.InteropServices.DllImport("dwmapi.dll")]
        internal static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int attrValue, int attrSize);

        internal static void DarkTitleBar(IntPtr hwnd)
        {
            if (hwnd == IntPtr.Zero) return;
            try
            {
                int on = 1;
                if (DwmSetWindowAttribute(hwnd, 20, ref on, 4) != 0)
                {
                    DwmSetWindowAttribute(hwnd, 19, ref on, 4);
                }

                // Windows 11 22H2+：即使沉浸式深色未生效，也强制标题栏跟随应用配色
                int caption = ColorRef(Theme.Canvas);
                DwmSetWindowAttribute(hwnd, 35, ref caption, 4);

                int text = ColorRef(Theme.Ink);
                DwmSetWindowAttribute(hwnd, 36, ref text, 4);

                int border = ColorRef(Theme.Hairline);
                DwmSetWindowAttribute(hwnd, 34, ref border, 4);
            }
            catch { }
        }

        static int ColorRef(Color c)
        {
            return (c.R) | (c.G << 8) | (c.B << 16);
        }

        internal static void DarkScroll(Control c)
        {
            if (c == null || !c.IsHandleCreated) return;
            try { SetWindowTheme(c.Handle, "DarkMode_Explorer", null); }
            catch { }
        }
    }

    static class Theme
    {
        // canvas / surfaces
        public static readonly Color Canvas = Hex("#010102");
        public static readonly Color Surface1 = Hex("#0f1011");
        public static readonly Color Surface2 = Hex("#141516");
        public static readonly Color Surface3 = Hex("#18191a");
        public static readonly Color Surface4 = Hex("#191a1b");

        // hairlines
        public static readonly Color Hairline = Hex("#23252a");
        public static readonly Color HairlineStrong = Hex("#34343a");
        public static readonly Color HairlineTertiary = Hex("#3e3e44");

        // ink
        public static readonly Color Ink = Hex("#f7f8f8");
        public static readonly Color InkMuted = Hex("#d0d6e0");
        public static readonly Color InkSubtle = Hex("#8a8f98");
        public static readonly Color InkTertiary = Hex("#62666d");

        // accents
        public static readonly Color Primary = Hex("#5e6ad2");
        public static readonly Color PrimaryHover = Hex("#828fff");
        public static readonly Color PrimaryPressed = Hex("#5e69d1");
        public static readonly Color Success = Hex("#27a644");
        public static readonly Color Warning = Hex("#d97706");
        public static readonly Color Danger = Hex("#e5484d");

        public static float Scale = 1f;

        public static Font Title;
        public static Font Subtitle;
        public static Font Body;
        public static Font BodyStrong;
        public static Font Small;
        public static Font Tiny;
        public static Font Mono;
        public static Font MonoSmall;
        public static Font ButtonFont;
        public static Font CourseName;
        public static Font Pill;
        public static Font Mark;
        public static Font Section;

        public static int S(int v)
        {
            return (int)Math.Round(v * Scale);
        }

        public static void Init()
        {
            try
            {
                using (Graphics g = Graphics.FromHwnd(IntPtr.Zero))
                {
                    Scale = g.DpiX / 96f;
                }
            }
            catch { Scale = 1f; }

            if (Scale < 1f) Scale = 1f;
            if (Scale > 3f) Scale = 3f;

            string ui = Pick("Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI");
            string mono = Pick("Consolas", "Cascadia Mono", "Courier New");

            Title = new Font(ui, 13f, FontStyle.Bold);
            Subtitle = new Font(ui, 9f);
            Body = new Font(ui, 9.5f);
            BodyStrong = new Font(ui, 9.5f, FontStyle.Bold);
            Small = new Font(ui, 8.5f);
            Tiny = new Font(ui, 8f);
            ButtonFont = new Font(ui, 9f);
            CourseName = new Font(ui, 10f, FontStyle.Bold);
            Pill = new Font(ui, 8.5f);
            Mark = new Font(ui, 12f, FontStyle.Bold);
            Section = new Font(ui, 10.5f, FontStyle.Bold);
            Mono = new Font(mono, 9f);
            MonoSmall = new Font(mono, 8.25f);
        }

        static string Pick(params string[] names)
        {
            foreach (string n in names)
            {
                try
                {
                    using (FontFamily f = new FontFamily(n)) { return f.Name; }
                }
                catch { }
            }
            return FontFamily.GenericSansSerif.Name;
        }

        static Color Hex(string h)
        {
            int v = Convert.ToInt32(h.Substring(1), 16);
            return Color.FromArgb(255, (v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF);
        }
    }

    static class Draw
    {
        public static GraphicsPath Round(Rectangle r, int radius)
        {
            GraphicsPath p = new GraphicsPath();
            if (r.Width <= 0 || r.Height <= 0) return p;

            int d = Math.Min(radius * 2, Math.Min(r.Width, r.Height));
            if (d <= 0)
            {
                p.AddRectangle(r);
                return p;
            }

            p.AddArc(r.X, r.Y, d, d, 180, 90);
            p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            p.CloseFigure();
            return p;
        }

        public static void FillRound(Graphics g, Rectangle r, int radius, Color c)
        {
            using (GraphicsPath p = Round(r, radius))
            using (SolidBrush b = new SolidBrush(c))
            {
                g.FillPath(b, p);
            }
        }

        public static void StrokeRound(Graphics g, Rectangle r, int radius, Color c)
        {
            Rectangle rr = new Rectangle(r.X, r.Y, r.Width - 1, r.Height - 1);
            if (rr.Width <= 0 || rr.Height <= 0) return;
            using (GraphicsPath p = Round(rr, radius))
            using (Pen pen = new Pen(c))
            {
                g.DrawPath(pen, p);
            }
        }

        public static Color Blend(Color a, Color b, double t)
        {
            if (t < 0) t = 0;
            if (t > 1) t = 1;
            return Color.FromArgb(
                (int)Math.Round(a.R + (b.R - a.R) * t),
                (int)Math.Round(a.G + (b.G - a.G) * t),
                (int)Math.Round(a.B + (b.B - a.B) * t));
        }

        public static void HLine(Graphics g, int x1, int x2, int y, Color c)
        {
            using (Pen p = new Pen(c))
            {
                g.DrawLine(p, x1, y, x2, y);
            }
        }
    }

    class Card : Panel
    {
        public Card()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint
                | ControlStyles.OptimizedDoubleBuffer
                | ControlStyles.UserPaint
                | ControlStyles.ResizeRedraw, true);
            BackColor = Theme.Canvas;
            DoubleBuffered = true;
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.Clear(BackColor);
            g.SmoothingMode = SmoothingMode.AntiAlias;

            Rectangle r = new Rectangle(0, 0, Width, Height);
            Draw.FillRound(g, r, Theme.S(12), Theme.Surface1);
            Draw.StrokeRound(g, r, Theme.S(12), Theme.Hairline);

            base.OnPaint(e);
        }
    }

    enum ButtonKind
    {
        Primary,
        Secondary,
        Ghost,
        Danger
    }

    class UiButton : Control
    {
        ButtonKind kind;
        bool hover;
        bool pressed;

        public UiButton(string text, ButtonKind kind)
        {
            this.kind = kind;
            Text = text;
            Font = Theme.ButtonFont;
            BackColor = Theme.Surface1;
            ForeColor = Theme.Ink;
            Height = Theme.S(34);
            Cursor = Cursors.Hand;
            TabStop = false;
            SetStyle(ControlStyles.AllPaintingInWmPaint
                | ControlStyles.OptimizedDoubleBuffer
                | ControlStyles.UserPaint
                | ControlStyles.ResizeRedraw, true);
        }

        public ButtonKind Kind
        {
            get { return kind; }
            set { kind = value; Invalidate(); }
        }

        public int FitWidth(int minWidth)
        {
            Size sz = TextRenderer.MeasureText(Text, Font);
            int w = sz.Width + Theme.S(14) * 2;
            if (w < minWidth) w = minWidth;
            Width = w;
            return w;
        }

        protected override void OnMouseEnter(EventArgs e)
        {
            hover = true;
            Invalidate();
            base.OnMouseEnter(e);
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            hover = false;
            pressed = false;
            Invalidate();
            base.OnMouseLeave(e);
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            if (e.Button == MouseButtons.Left) { pressed = true; Invalidate(); }
            base.OnMouseDown(e);
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            pressed = false;
            Invalidate();
            base.OnMouseUp(e);
        }

        protected override void OnEnabledChanged(EventArgs e)
        {
            Invalidate();
            base.OnEnabledChanged(e);
        }

        protected override void OnTextChanged(EventArgs e)
        {
            Invalidate();
            base.OnTextChanged(e);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.Clear(BackColor);
            g.SmoothingMode = SmoothingMode.AntiAlias;

            Rectangle r = new Rectangle(0, 0, Width, Height);
            int rad = Theme.S(8);

            Color fill = Color.Empty;
            Color text = Theme.Ink;
            Color border = Color.Empty;
            bool hasBorder = false;

            if (!Enabled)
            {
                fill = Theme.Surface2;
                text = Theme.InkTertiary;
                border = Theme.Hairline;
                hasBorder = true;
            }
            else if (kind == ButtonKind.Primary)
            {
                fill = pressed ? Theme.PrimaryPressed : (hover ? Theme.PrimaryHover : Theme.Primary);
                text = Color.White;
            }
            else if (kind == ButtonKind.Danger)
            {
                fill = (hover || pressed) ? Draw.Blend(Theme.Surface1, Theme.Danger, 0.14) : Theme.Surface1;
                text = Theme.Danger;
                border = Draw.Blend(Theme.Surface1, Theme.Danger, 0.42);
                hasBorder = true;
            }
            else if (kind == ButtonKind.Secondary)
            {
                fill = (hover || pressed) ? Theme.Surface2 : Theme.Surface1;
                text = Theme.Ink;
                border = (hover || pressed) ? Theme.HairlineTertiary : Theme.HairlineStrong;
                hasBorder = true;
            }
            else
            {
                fill = (hover || pressed) ? Theme.Surface2 : BackColor;
                text = Theme.InkMuted;
            }

            if (fill != BackColor) Draw.FillRound(g, r, rad, fill);
            if (hasBorder) Draw.StrokeRound(g, r, rad, border);

            Rectangle tr = new Rectangle(Theme.S(6), 0, Width - Theme.S(12), Height);
            TextRenderer.DrawText(g, Text, Font, tr, text,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter
                | TextFormatFlags.NoPrefix | TextFormatFlags.EndEllipsis);
        }
    }

    class StatusPill : Control
    {
        string label = "就绪";
        Color dot = Theme.InkTertiary;

        public StatusPill()
        {
            Font = Theme.Pill;
            BackColor = Theme.Canvas;
            Height = Theme.S(28);
            Width = Theme.S(84);
            SetStyle(ControlStyles.AllPaintingInWmPaint
                | ControlStyles.OptimizedDoubleBuffer
                | ControlStyles.UserPaint
                | ControlStyles.ResizeRedraw, true);
        }

        public void SetState(string text, Color color)
        {
            label = text;
            dot = color;
            Size sz = TextRenderer.MeasureText(label, Font);
            Width = sz.Width + Theme.S(30);
            Invalidate();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.Clear(BackColor);
            g.SmoothingMode = SmoothingMode.AntiAlias;

            Rectangle r = new Rectangle(0, 0, Width, Height);
            Draw.FillRound(g, r, Height / 2, Theme.Surface1);
            Draw.StrokeRound(g, r, Height / 2, Theme.Hairline);

            int d = Theme.S(6);
            int cy = Height / 2;
            using (SolidBrush b = new SolidBrush(dot))
            {
                g.FillEllipse(b, Theme.S(11), cy - d / 2, d, d);
            }

            Rectangle tr = new Rectangle(Theme.S(22), 0, Width - Theme.S(29), Height);
            TextRenderer.DrawText(g, label, Font, tr, Theme.InkMuted,
                TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix);
        }
    }

    class BrandMark : Control
    {
        public BrandMark()
        {
            BackColor = Theme.Canvas;
            Size = new Size(Theme.S(30), Theme.S(30));
            SetStyle(ControlStyles.AllPaintingInWmPaint
                | ControlStyles.OptimizedDoubleBuffer
                | ControlStyles.UserPaint
                | ControlStyles.ResizeRedraw, true);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.Clear(BackColor);
            g.SmoothingMode = SmoothingMode.AntiAlias;

            Rectangle r = new Rectangle(0, 0, Width, Height);
            Draw.FillRound(g, r, Theme.S(8), Theme.Primary);
            TextRenderer.DrawText(g, "智", Theme.Mark, r, Color.White,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix);
        }
    }

    class Course
    {
        public string Name = "";
        public string Error = "";
        public List<Chapter> Chapters = new List<Chapter>();
        public int Lessons;
        public int Studied;
        public int Known;

        public void Count()
        {
            Lessons = 0;
            Studied = 0;
            Known = 0;
            foreach (Chapter ch in Chapters)
            {
                foreach (Lesson l in ch.Lessons)
                {
                    Lessons++;
                    if (l.Studied.HasValue)
                    {
                        Known++;
                        if (l.Studied.Value) Studied++;
                    }
                }
            }
        }
    }

    class Chapter
    {
        public string No = "";
        public string Name = "";
        public List<Lesson> Lessons = new List<Lesson>();
    }

    class Lesson
    {
        public string No = "";
        public string Title = "";
        public int Seconds;
        public string Time = "";
        public bool? Studied;
    }

    class Catalog
    {
        public string At = "";
        public List<Course> Courses = new List<Course>();
    }

    static class CatalogStore
    {
        public static Catalog Load(string path, out string error)
        {
            error = null;
            try
            {
                if (!File.Exists(path))
                {
                    error = "还没有扫描过目录";
                    return null;
                }

                string text = File.ReadAllText(path, Encoding.UTF8);
                JavaScriptSerializer ser = new JavaScriptSerializer();
                ser.MaxJsonLength = 32 * 1024 * 1024;

                Dictionary<string, object> root = ser.DeserializeObject(text) as Dictionary<string, object>;
                if (root == null)
                {
                    error = "目录文件格式不正确";
                    return null;
                }

                Catalog cat = new Catalog();
                cat.At = Str(Get(root, "at"));

                object arr = Get(root, "courses");
                object[] list = arr as object[];
                if (list != null)
                {
                    foreach (object o in list)
                    {
                        Dictionary<string, object> d = o as Dictionary<string, object>;
                        if (d == null) continue;

                        Course c = new Course();
                        c.Name = Str(Get(d, "course"));
                        c.Error = Str(Get(d, "error"));

                        object chs = Get(d, "chapters");
                        object[] chList = chs as object[];
                        if (chList != null)
                        {
                            foreach (object co in chList)
                            {
                                Dictionary<string, object> cd = co as Dictionary<string, object>;
                                if (cd == null) continue;

                                Chapter ch = new Chapter();
                                ch.No = Str(Get(cd, "no"));
                                ch.Name = Str(Get(cd, "name"));

                                object ls = Get(cd, "lessons");
                                object[] lList = ls as object[];
                                if (lList != null)
                                {
                                    foreach (object lo in lList)
                                    {
                                        Dictionary<string, object> ld = lo as Dictionary<string, object>;
                                        if (ld == null) continue;

                                        Lesson l = new Lesson();
                                        l.No = Str(Get(ld, "no"));
                                        l.Title = Str(Get(ld, "title"));
                                        l.Seconds = Int(Get(ld, "seconds"));
                                        l.Time = Str(Get(ld, "time"));
                                        if (l.Time.Length == 0) l.Time = FormatSeconds(l.Seconds);
                                        l.Studied = Bool3(Get(ld, "studied"));
                                        ch.Lessons.Add(l);
                                    }
                                }

                                c.Chapters.Add(ch);
                            }
                        }

                        c.Count();
                        cat.Courses.Add(c);
                    }
                }

                return cat;
            }
            catch (Exception ex)
            {
                error = ex.Message;
                return null;
            }
        }

        public static string FormatSeconds(int sec)
        {
            if (sec <= 0) return "";
            int m = sec / 60;
            int s = sec % 60;
            return m.ToString("00") + ":" + s.ToString("00");
        }

        static object Get(Dictionary<string, object> d, string key)
        {
            object v;
            if (d != null && d.TryGetValue(key, out v)) return v;
            return null;
        }

        static string Str(object o)
        {
            if (o == null) return "";
            return Convert.ToString(o).Trim();
        }

        static int Int(object o)
        {
            if (o == null) return 0;
            try { return Convert.ToInt32(o); }
            catch { return 0; }
        }

        static bool? Bool3(object o)
        {
            if (o == null) return null;
            if (o is bool) return (bool)o;
            if (o is int) return (int)o == 1;
            if (o is long) return (long)o == 1;
            if (o is double) return (double)o == 1d;
            if (o is decimal) return (decimal)o == 1m;

            string s = Convert.ToString(o).Trim().ToLowerInvariant();
            if (s == "true" || s == "1") return true;
            if (s == "false" || s == "0") return false;
            return null;
        }
    }

    class AppEnv
    {
        public string ExeDir = "";
        public string WorkDir = "";
        public string Script = "";
        public string NodeExe = "";

        public string CatalogPath
        {
            get { return Path.Combine(Path.Combine(WorkDir, "export"), "course-catalog.json"); }
        }

        public static AppEnv Detect()
        {
            AppEnv env = new AppEnv();
            string exeDir = Path.GetDirectoryName(Application.ExecutablePath);
            env.ExeDir = exeDir;

            string work = null;
            string cur = exeDir;
            for (int i = 0; i < 7 && cur != null; i++)
            {
                if (File.Exists(Path.Combine(cur, "zhs.mjs"))) { work = cur; break; }
                string sub = Path.Combine(cur, "app");
                if (File.Exists(Path.Combine(sub, "zhs.mjs"))) { work = sub; break; }
                DirectoryInfo p = Directory.GetParent(cur);
                cur = p == null ? null : p.FullName;
            }

            if (work == null) work = exeDir;
            env.WorkDir = work;
            env.Script = Path.Combine(work, "zhs.mjs");
            env.NodeExe = FindNode(exeDir, work);
            return env;
        }

        static string FindNode(string exeDir, string workDir)
        {
            List<string> cand = new List<string>();
            cand.Add(Path.Combine(exeDir, "runtime", "node.exe"));
            cand.Add(Path.Combine(workDir, "runtime", "node.exe"));
            try
            {
                DirectoryInfo p = Directory.GetParent(workDir);
                if (p != null) cand.Add(Path.Combine(p.FullName, "runtime", "node.exe"));
            }
            catch { }
            cand.Add(Path.Combine(workDir, "node.exe"));
            cand.Add(Path.Combine(exeDir, "node.exe"));
            cand.Add(Path.Combine(exeDir, "node", "node.exe"));

            foreach (string c in cand)
            {
                try { if (File.Exists(c)) return c; }
                catch { }
            }

            string path = Environment.GetEnvironmentVariable("PATH");
            if (!String.IsNullOrEmpty(path))
            {
                foreach (string part in path.Split(';'))
                {
                    string t = part.Trim().Trim('"');
                    if (t.Length == 0) continue;
                    try
                    {
                        string f = Path.Combine(t, "node.exe");
                        if (File.Exists(f)) return f;
                    }
                    catch { }
                }
            }

            try
            {
                string f = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe");
                if (File.Exists(f)) return f;
            }
            catch { }

            return "";
        }
    }

    class JobRunner
    {
        Process proc;
        public string Kind = "";

        public event Action<string, bool> Line;
        public event Action<int> Done;

        public bool Busy
        {
            get { return proc != null; }
        }

        public bool Start(string exe, string args, string workDir)
        {
            if (proc != null) return false;

            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = exe;
            psi.Arguments = args;
            psi.WorkingDirectory = workDir;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            psi.StandardErrorEncoding = Encoding.UTF8;

            Process p = new Process();
            p.StartInfo = psi;
            p.OutputDataReceived += delegate(object s, DataReceivedEventArgs e)
            {
                if (e.Data != null) Emit(e.Data, false);
            };
            p.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e)
            {
                if (e.Data != null) Emit(e.Data, true);
            };

            try
            {
                if (!p.Start()) return false;
            }
            catch (Exception ex)
            {
                Emit("无法启动进程：" + ex.Message, true);
                return false;
            }

            proc = p;

            try
            {
                p.BeginOutputReadLine();
                p.BeginErrorReadLine();
            }
            catch { }

            Thread t = new Thread(delegate()
            {
                int code = -1;
                try
                {
                    p.WaitForExit();
                    p.WaitForExit();
                    code = p.ExitCode;
                }
                catch { }

                proc = null;
                Action<int> d = Done;
                if (d != null)
                {
                    try { d(code); }
                    catch { }
                }
            });
            t.IsBackground = true;
            t.Start();
            return true;
        }

        public void Stop()
        {
            Process p = proc;
            if (p == null) return;

            try
            {
                ProcessStartInfo psi = new ProcessStartInfo("taskkill", "/PID " + p.Id.ToString() + " /T /F");
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                Process k = Process.Start(psi);
                if (k != null) k.WaitForExit(4000);
            }
            catch
            {
                try { p.Kill(); }
                catch { }
            }
        }

        void Emit(string line, bool isError)
        {
            Action<string, bool> h = Line;
            if (h == null) return;
            try { h(line, isError); }
            catch { }
        }
    }

    class CourseList : ListBox
    {
        int hotIndex = -1;

        public CourseList()
        {
            DrawMode = DrawMode.OwnerDrawFixed;
            ItemHeight = Theme.S(62);
            BorderStyle = BorderStyle.None;
            IntegralHeight = false;
            BackColor = Theme.Surface1;
            ForeColor = Theme.Ink;
            Font = Theme.Body;
            DoubleBuffered = true;
            HorizontalScrollbar = false;
            SetStyle(ControlStyles.OptimizedDoubleBuffer, true);
        }

        // 原生 ListBox 的背景擦除会让滚动闪白，这里直接吃掉该消息
        protected override void WndProc(ref Message m)
        {
            if (m.Msg == 0x0007) // WM_ERASEBKGND
            {
                m.Result = (IntPtr)1;
                return;
            }
            base.WndProc(ref m);
        }

        // 悬停行直接画到屏幕，不走 WM_PAINT：原生 ListBox 无真正双缓冲，
        // 每次 Invalidate 都会重绘整块可见区域，鼠标划过时就会频闪。
        void RepaintRow(int index)
        {
            if (index < 0 || index >= Items.Count) return;
            Rectangle r = GetItemRectangle(index);
            if (r.Height <= 0) return;
            DrawItemState state = GetSelected(index) ? DrawItemState.Selected : DrawItemState.None;
            using (Graphics g = CreateGraphics())
            {
                g.SetClip(ClientRectangle);
                DrawItemEventArgs e = new DrawItemEventArgs(g, Font, r, index, state);
                OnDrawItem(e);
            }
        }

        protected override void OnDrawItem(DrawItemEventArgs e)
        {
            if (e.Index < 0 || e.Index >= Items.Count) return;

            Course c = Items[e.Index] as Course;
            if (c == null) return;

            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;

            using (SolidBrush bg = new SolidBrush(Theme.Surface1))
            {
                g.FillRectangle(bg, e.Bounds);
            }

            Rectangle row = new Rectangle(
                e.Bounds.X + Theme.S(6),
                e.Bounds.Y + Theme.S(2),
                e.Bounds.Width - Theme.S(12),
                e.Bounds.Height - Theme.S(4));
            if (row.Width <= 0 || row.Height <= 0) return;

            bool sel = (e.State & DrawItemState.Selected) == DrawItemState.Selected;
            bool hot = e.Index == hotIndex;

            if (sel || hot)
            {
                Draw.FillRound(g, row, Theme.S(8), Theme.Surface2);
            }

            int pad = Theme.S(14);
            if (sel)
            {
                Rectangle bar = new Rectangle(row.X + Theme.S(5), row.Y + Theme.S(11), Theme.S(3), row.Height - Theme.S(22));
                Draw.FillRound(g, bar, Theme.S(2), Theme.Primary);
            }

            int x = row.X + pad;
            int w = row.Right - pad - x;
            if (w < Theme.S(20)) w = Theme.S(20);

            string name = c.Name.Length > 0 ? c.Name : "（未命名课程）";
            TextRenderer.DrawText(g, name, Theme.CourseName,
                new Rectangle(x, row.Y + Theme.S(9), w, Theme.S(19)),
                Theme.Ink,
                TextFormatFlags.Left | TextFormatFlags.VerticalCenter
                | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix);

            string meta;
            Color metaColor = Theme.InkTertiary;
            if (c.Error.Length > 0)
            {
                meta = "扫描失败 · 点右上角刷新重试";
                metaColor = Theme.Warning;
            }
            else if (c.Lessons == 0)
            {
                meta = "没有目录数据";
            }
            else if (c.Known == 0)
            {
                meta = c.Chapters.Count.ToString() + " 章 · " + c.Lessons.ToString() + " 节 · 状态未知";
            }
            else
            {
                meta = c.Chapters.Count.ToString() + " 章 · " + c.Lessons.ToString() + " 节 · 已完成 "
                    + c.Studied.ToString() + " / " + c.Lessons.ToString();
            }

            TextRenderer.DrawText(g, meta, Theme.Small,
                new Rectangle(x, row.Y + Theme.S(29), w, Theme.S(16)),
                metaColor,
                TextFormatFlags.Left | TextFormatFlags.VerticalCenter
                | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix);

            // 进度条
            Rectangle track = new Rectangle(x, row.Bottom - Theme.S(13), w, Theme.S(3));
            if (track.Width > 0)
            {
                Draw.FillRound(g, track, Theme.S(2), Theme.Surface3);
                if (c.Lessons > 0 && c.Studied > 0)
                {
                    int fw = (int)Math.Round(track.Width * (c.Studied / (double)c.Lessons));
                    if (fw < Theme.S(3)) fw = Theme.S(3);
                    Rectangle fill = new Rectangle(track.X, track.Y, fw, track.Height);
                    Draw.FillRound(g, fill, Theme.S(2), Theme.Primary);
                }
            }
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            int idx = IndexFromPoint(e.Location);
            if (idx != hotIndex)
            {
                int old = hotIndex;
                hotIndex = idx;
                RepaintRow(old);
                RepaintRow(hotIndex);
            }
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            base.OnMouseLeave(e);
            if (hotIndex != -1)
            {
                int old = hotIndex;
                hotIndex = -1;
                RepaintRow(old);
            }
        }
    }

    class LessonRow
    {
        public bool IsChapter;
        public string No = "";
        public string Name = "";
        public Lesson Lesson;
        public string ChapterName = "";
    }

    class LessonList : ListBox
    {
        bool fixing;
        int hotIndex = -1;

        public event EventHandler LessonChanged;
        public event EventHandler LessonActivated;

        public LessonList()
        {
            DrawMode = DrawMode.OwnerDrawVariable;
            BorderStyle = BorderStyle.None;
            IntegralHeight = false;
            BackColor = Theme.Surface1;
            ForeColor = Theme.Ink;
            Font = Theme.Body;
            DoubleBuffered = true;
            HorizontalScrollbar = false;
            SetStyle(ControlStyles.OptimizedDoubleBuffer, true);
        }

        // 与 CourseList 相同：吃掉背景擦除消息
        protected override void WndProc(ref Message m)
        {
            if (m.Msg == 0x0007) // WM_ERASEBKGND
            {
                m.Result = (IntPtr)1;
                return;
            }
            base.WndProc(ref m);
        }

        // 与 CourseList 相同：悬停行直接画到屏幕，避免 Invalidate 引发整块重绘
        void RepaintRow(int index)
        {
            if (index < 0 || index >= Items.Count) return;
            Rectangle r = GetItemRectangle(index);
            if (r.Height <= 0) return;
            DrawItemState state = GetSelected(index) ? DrawItemState.Selected : DrawItemState.None;
            using (Graphics g = CreateGraphics())
            {
                g.SetClip(ClientRectangle);
                DrawItemEventArgs e = new DrawItemEventArgs(g, Font, r, index, state);
                OnDrawItem(e);
            }
        }

        public void SetRows(List<LessonRow> rows)
        {
            fixing = true;
            Items.Clear();
            hotIndex = -1;
            if (rows != null)
            {
                foreach (LessonRow r in rows) Items.Add(r);
            }
            if (Items.Count > 0) SelectedIndex = -1;
            fixing = false;
            Invalidate();
            RaiseLessonChanged();
        }

        public LessonRow SelectedRow
        {
            get
            {
                int i = SelectedIndex;
                if (i < 0 || i >= Items.Count) return null;
                return Items[i] as LessonRow;
            }
        }

        public Lesson SelectedLesson
        {
            get
            {
                LessonRow r = SelectedRow;
                if (r == null || r.IsChapter) return null;
                return r.Lesson;
            }
        }

        protected override void OnMeasureItem(MeasureItemEventArgs e)
        {
            if (e.Index < 0 || e.Index >= Items.Count)
            {
                e.ItemHeight = Theme.S(46);
                return;
            }
            LessonRow r = Items[e.Index] as LessonRow;
            e.ItemHeight = (r != null && r.IsChapter) ? Theme.S(36) : Theme.S(46);
        }

        protected override void OnDrawItem(DrawItemEventArgs e)
        {
            if (e.Index < 0 || e.Index >= Items.Count) return;

            LessonRow r = Items[e.Index] as LessonRow;
            if (r == null) return;

            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;

            using (SolidBrush bg = new SolidBrush(Theme.Surface1))
            {
                g.FillRectangle(bg, e.Bounds);
            }

            Rectangle b = e.Bounds;

            if (r.IsChapter)
            {
                string chapterTitle = r.Name.Length > 0 ? r.Name : ("第 " + r.No + " 章");
                TextRenderer.DrawText(g, chapterTitle, Theme.Section,
                    new Rectangle(b.X + Theme.S(16), b.Y, Math.Max(Theme.S(20), b.Width - Theme.S(32)), b.Height),
                    Theme.InkSubtle,
                    TextFormatFlags.Left | TextFormatFlags.VerticalCenter
                    | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix);

                Draw.HLine(g, b.X + Theme.S(16), b.Right - Theme.S(16), b.Bottom - 1, Theme.Hairline);
                return;
            }

            Rectangle row = new Rectangle(b.X + Theme.S(6), b.Y + Theme.S(2), b.Width - Theme.S(12), b.Height - Theme.S(4));
            if (row.Width <= 0 || row.Height <= 0) return;

            bool sel = (e.State & DrawItemState.Selected) == DrawItemState.Selected;
            bool hot = e.Index == hotIndex;

            if (sel)
            {
                Draw.FillRound(g, row, Theme.S(7), Theme.Surface2);
                Rectangle bar = new Rectangle(row.X + Theme.S(5), row.Y + Theme.S(10), Theme.S(3), row.Height - Theme.S(20));
                Draw.FillRound(g, bar, Theme.S(2), Theme.Primary);
            }
            else if (hot)
            {
                Draw.FillRound(g, row, Theme.S(7), Draw.Blend(Theme.Surface1, Theme.Surface2, 0.65));
            }

            int left = row.X + Theme.S(14);
            int markW = Theme.S(18);
            int noX = left + markW + Theme.S(8);
            int noW = Theme.S(52);
            int titleX = noX + noW + Theme.S(8);
            int durW = Theme.S(58);
            int titleW = row.Right - Theme.S(14) - durW - titleX;
            if (titleW < Theme.S(30)) titleW = Theme.S(30);

            Lesson l = r.Lesson;
            string mark;
            Color markColor;
            if (l == null || !l.Studied.HasValue)
            {
                mark = "?";
                markColor = Theme.Warning;
            }
            else if (l.Studied.Value)
            {
                mark = "\u2713";
                markColor = Theme.Success;
            }
            else
            {
                mark = "\u25cb";
                markColor = Theme.InkTertiary;
            }

            TextRenderer.DrawText(g, mark, Theme.Small,
                new Rectangle(left, row.Y, markW, row.Height), markColor,
                TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix);

            string no = r.No;
            TextRenderer.DrawText(g, no, Theme.MonoSmall,
                new Rectangle(noX, row.Y, noW, row.Height), Theme.InkTertiary,
                TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix);

            string lessonTitle = r.Name.Length > 0 ? r.Name : "（未命名课节）";
            TextRenderer.DrawText(g, lessonTitle, Theme.Body,
                new Rectangle(titleX, row.Y, titleW, row.Height),
                sel ? Theme.Ink : Theme.InkMuted,
                TextFormatFlags.Left | TextFormatFlags.VerticalCenter
                | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix);

            string dur = (l != null) ? l.Time : "";
            if (dur.Length > 0)
            {
                TextRenderer.DrawText(g, dur, Theme.MonoSmall,
                    new Rectangle(row.Right - Theme.S(14) - durW, row.Y, durW, row.Height),
                    Theme.InkTertiary,
                    TextFormatFlags.Right | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix);
            }
        }

        protected override void OnSelectedIndexChanged(EventArgs e)
        {
            base.OnSelectedIndexChanged(e);
            if (fixing)
            {
                Invalidate();
                return;
            }

            if (SelectedIndex >= 0 && SelectedIndex < Items.Count)
            {
                LessonRow r = Items[SelectedIndex] as LessonRow;
                if (r != null && r.IsChapter)
                {
                    int target = -1;
                    for (int i = SelectedIndex + 1; i < Items.Count; i++)
                    {
                        LessonRow n = Items[i] as LessonRow;
                        if (n != null && !n.IsChapter) { target = i; break; }
                    }
                    if (target < 0)
                    {
                        for (int i = SelectedIndex - 1; i >= 0; i--)
                        {
                            LessonRow n = Items[i] as LessonRow;
                            if (n != null && !n.IsChapter) { target = i; break; }
                        }
                    }

                    fixing = true;
                    SelectedIndex = target;
                    fixing = false;
                }
            }

            Invalidate();
            RaiseLessonChanged();
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            int idx = IndexFromPoint(e.Location);
            if (idx != hotIndex)
            {
                int old = hotIndex;
                hotIndex = idx;
                RepaintRow(old);
                RepaintRow(hotIndex);
            }
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            base.OnMouseLeave(e);
            if (hotIndex != -1)
            {
                int old = hotIndex;
                hotIndex = -1;
                RepaintRow(old);
            }
        }

        protected override void OnDoubleClick(EventArgs e)
        {
            base.OnDoubleClick(e);
            LessonRow r = SelectedRow;
            if (r == null || r.IsChapter) return;
            EventHandler h = LessonActivated;
            if (h != null) h(this, EventArgs.Empty);
        }

        void RaiseLessonChanged()
        {
            EventHandler h = LessonChanged;
            if (h != null) h(this, EventArgs.Empty);
        }
    }

    class EmptyState : Control
    {
        string title = "";
        string sub = "";

        public EmptyState()
        {
            BackColor = Theme.Surface1;
            SetStyle(ControlStyles.AllPaintingInWmPaint
                | ControlStyles.OptimizedDoubleBuffer
                | ControlStyles.UserPaint
                | ControlStyles.ResizeRedraw, true);
        }

        public void SetText(string t, string s)
        {
            title = t;
            sub = s;
            Invalidate();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.Clear(BackColor);
            g.SmoothingMode = SmoothingMode.AntiAlias;

            int cx = Width / 2;
            int cy = Height / 2;
            int d = Theme.S(44);

            Rectangle circle = new Rectangle(cx - d / 2, cy - d / 2 - Theme.S(34), d, d);
            using (Pen p = new Pen(Theme.HairlineStrong))
            {
                g.DrawEllipse(p, circle);
            }
            using (Pen p = new Pen(Theme.HairlineTertiary))
            {
                g.DrawLine(p, cx - Theme.S(7), circle.Y + d / 2, cx, circle.Y + d / 2 + Theme.S(7));
                g.DrawLine(p, cx, circle.Y + d / 2 + Theme.S(7), cx + Theme.S(7), circle.Y + d / 2 - Theme.S(7));
            }

            Rectangle tr = new Rectangle(Theme.S(16), cy + Theme.S(18), Math.Max(Theme.S(40), Width - Theme.S(32)), Theme.S(22));
            TextRenderer.DrawText(g, title, Theme.BodyStrong, tr, Theme.InkMuted,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.Top | TextFormatFlags.NoPrefix);

            Rectangle sr = new Rectangle(Theme.S(24), cy + Theme.S(44), Math.Max(Theme.S(40), Width - Theme.S(48)), Math.Max(Theme.S(20), Height - (cy + Theme.S(44)) - Theme.S(10)));
            TextRenderer.DrawText(g, sub, Theme.Small, sr, Theme.InkTertiary,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.Top
                | TextFormatFlags.WordBreak | TextFormatFlags.NoPrefix);
        }
    }

    class MainForm : Form
    {
        AppEnv env = new AppEnv();
        JobRunner job = new JobRunner();
        Catalog catalog;

        Card courseCard;
        Card lessonCard;
        Card logCard;

        BrandMark mark;
        Label lblTitle;
        Label lblSub;
        StatusPill pill;
        UiButton btnLogin;
        UiButton btnRefresh;

        Label lblCourses;
        CourseList courseList;
        EmptyState courseEmpty;

        Label lblLessonTitle;
        Label lblLessonMeta;
        LessonList lessonList;
        EmptyState lessonEmpty;
        Label lblPick;
        UiButton btnStart;
        UiButton btnStop;

        Label lblLog;
        UiButton btnClear;
        RichTextBox logBox;

        public MainForm()
        {
            env = AppEnv.Detect();

            Text = "智慧树课程助手";
            BackColor = Theme.Canvas;
            ForeColor = Theme.Ink;
            Font = Theme.Body;
            AutoScaleMode = AutoScaleMode.None;
            StartPosition = FormStartPosition.CenterScreen;
            DoubleBuffered = true;
            MaximizeBox = true;
            ShowIcon = false;

            int w = Theme.S(1080);
            int h = Theme.S(740);
            try
            {
                Rectangle wa = Screen.PrimaryScreen.WorkingArea;
                if (w > wa.Width - Theme.S(40)) w = wa.Width - Theme.S(40);
                if (h > wa.Height - Theme.S(40)) h = wa.Height - Theme.S(40);
            }
            catch { }

            ClientSize = new Size(w, h);
            MinimumSize = SizeFromClientSize(new Size(Math.Min(Theme.S(960), w), Math.Min(Theme.S(640), h)));

            BuildHeader();
            BuildCourseCard();
            BuildLessonCard();
            BuildLogCard();

            Controls.Add(courseCard);
            Controls.Add(lessonCard);
            Controls.Add(logCard);
            Controls.Add(mark);
            Controls.Add(lblTitle);
            Controls.Add(lblSub);
            Controls.Add(pill);
            Controls.Add(btnLogin);
            Controls.Add(btnRefresh);

            WireEvents();
            LayoutAll();
            UpdateActionBar();
        }

        void BuildHeader()
        {
            mark = new BrandMark();

            lblTitle = new Label();
            lblTitle.AutoSize = false;
            lblTitle.BackColor = Theme.Canvas;
            lblTitle.ForeColor = Theme.Ink;
            lblTitle.Font = Theme.Title;
            lblTitle.Text = "智慧树课程助手";
            lblTitle.TextAlign = ContentAlignment.MiddleLeft;

            lblSub = new Label();
            lblSub.AutoSize = false;
            lblSub.BackColor = Theme.Canvas;
            lblSub.ForeColor = Theme.InkSubtle;
            lblSub.Font = Theme.Subtitle;
            lblSub.Text = "扫描课程目录 · 识别完成状态 · 自动观看指定课节";
            lblSub.TextAlign = ContentAlignment.MiddleLeft;

            pill = new StatusPill();
            pill.SetState("就绪", Theme.InkTertiary);

            btnLogin = new UiButton("登录", ButtonKind.Secondary);
            btnRefresh = new UiButton("刷新目录", ButtonKind.Primary);
            btnLogin.FitWidth(Theme.S(76));
            btnRefresh.FitWidth(Theme.S(104));
        }

        void BuildCourseCard()
        {
            courseCard = new Card();

            lblCourses = new Label();
            lblCourses.AutoSize = false;
            lblCourses.BackColor = Theme.Surface1;
            lblCourses.ForeColor = Theme.InkTertiary;
            lblCourses.Font = Theme.Small;
            lblCourses.Text = "课程";
            lblCourses.TextAlign = ContentAlignment.MiddleLeft;

            courseList = new CourseList();
            courseList.SelectedIndexChanged += delegate { ShowCourse(); };

            courseEmpty = new EmptyState();
            courseEmpty.SetText("还没有课程目录", "点右上角「刷新目录」扫描一次");

            courseCard.Controls.Add(courseList);
            courseCard.Controls.Add(courseEmpty);
            courseCard.Controls.Add(lblCourses);
            courseEmpty.BringToFront();
        }

        void BuildLessonCard()
        {
            lessonCard = new Card();

            lblLessonTitle = new Label();
            lblLessonTitle.AutoSize = false;
            lblLessonTitle.BackColor = Theme.Surface1;
            lblLessonTitle.ForeColor = Theme.Ink;
            lblLessonTitle.Font = Theme.Section;
            lblLessonTitle.Text = "选择一门课程";
            lblLessonTitle.TextAlign = ContentAlignment.MiddleLeft;

            lblLessonMeta = new Label();
            lblLessonMeta.AutoSize = false;
            lblLessonMeta.BackColor = Theme.Surface1;
            lblLessonMeta.ForeColor = Theme.InkTertiary;
            lblLessonMeta.Font = Theme.Small;
            lblLessonMeta.Text = "";
            lblLessonMeta.TextAlign = ContentAlignment.MiddleLeft;

            lessonList = new LessonList();
            lessonList.LessonChanged += delegate { UpdateActionBar(); };
            lessonList.LessonActivated += delegate { StartWatch(); };

            lessonEmpty = new EmptyState();
            lessonEmpty.SetText("还没有选择课程", "在左侧点选一门课程查看目录");

            lblPick = new Label();
            lblPick.AutoSize = false;
            lblPick.BackColor = Theme.Surface1;
            lblPick.ForeColor = Theme.InkTertiary;
            lblPick.Font = Theme.Small;
            lblPick.Text = "先选一节课";
            lblPick.TextAlign = ContentAlignment.MiddleLeft;

            btnStart = new UiButton("开始完成这节", ButtonKind.Primary);
            btnStart.FitWidth(Theme.S(140));
            btnStop = new UiButton("停止", ButtonKind.Danger);
            btnStop.FitWidth(Theme.S(70));
            btnStop.Visible = false;

            lessonCard.Controls.Add(lessonList);
            lessonCard.Controls.Add(lessonEmpty);
            lessonCard.Controls.Add(lblLessonTitle);
            lessonCard.Controls.Add(lblLessonMeta);
            lessonCard.Controls.Add(lblPick);
            lessonCard.Controls.Add(btnStart);
            lessonCard.Controls.Add(btnStop);
            lessonEmpty.BringToFront();

            lessonCard.Paint += delegate(object s, PaintEventArgs e)
            {
                int y1 = Theme.S(56);
                int y2 = Math.Max(0, lessonCard.Height - Theme.S(66));
                Draw.HLine(e.Graphics, Theme.S(1), lessonCard.Width - Theme.S(1), y1, Theme.Hairline);
                Draw.HLine(e.Graphics, Theme.S(1), lessonCard.Width - Theme.S(1), y2, Theme.Hairline);
            };
        }

        void BuildLogCard()
        {
            logCard = new Card();

            lblLog = new Label();
            lblLog.AutoSize = false;
            lblLog.BackColor = Theme.Surface1;
            lblLog.ForeColor = Theme.InkSubtle;
            lblLog.Font = Theme.BodyStrong;
            lblLog.Text = "运行日志";
            lblLog.TextAlign = ContentAlignment.MiddleLeft;

            btnClear = new UiButton("清空", ButtonKind.Ghost);
            btnClear.FitWidth(Theme.S(56));

            logBox = new RichTextBox();
            logBox.BorderStyle = BorderStyle.None;
            logBox.BackColor = Theme.Surface1;
            logBox.ForeColor = Theme.InkMuted;
            logBox.Font = Theme.Mono;
            logBox.ReadOnly = true;
            logBox.WordWrap = true;
            logBox.ScrollBars = RichTextBoxScrollBars.Vertical;
            logBox.DetectUrls = false;
            logBox.HideSelection = false;
            logBox.Text = "";

            logCard.Controls.Add(logBox);
            logCard.Controls.Add(lblLog);
            logCard.Controls.Add(btnClear);

            logCard.Paint += delegate(object s, PaintEventArgs e)
            {
                Draw.HLine(e.Graphics, Theme.S(1), logCard.Width - Theme.S(1), Theme.S(39), Theme.Hairline);
            };
        }

        void WireEvents()
        {
            btnLogin.Click += delegate { StartJob("login", Quote(env.Script) + " login"); };
            btnRefresh.Click += delegate { StartJob("catalog", Quote(env.Script) + " catalog --no-pick"); };
            btnStart.Click += delegate { StartWatch(); };
            btnStop.Click += delegate
            {
                pill.SetState("正在停止", Theme.Warning);
                AppendLog("› 正在停止任务…", false);
                job.Stop();
            };
            btnClear.Click += delegate { logBox.Clear(); };

            job.Line += delegate(string line, bool isError)
            {
                if (IsDisposed) return;
                try
                {
                    BeginInvoke((MethodInvoker)delegate { AppendLog(line, isError); });
                }
                catch { }
            };

            job.Done += delegate(int code)
            {
                if (IsDisposed) return;
                try
                {
                    BeginInvoke((MethodInvoker)delegate { OnJobDone(code); });
                }
                catch { }
            };
        }

        protected override void OnResize(EventArgs e)
        {
            base.OnResize(e);
            if (courseCard != null) LayoutAll();
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);

            Native.DarkTitleBar(Handle);
            Native.DarkScroll(logBox);
            Native.DarkScroll(courseList);
            Native.DarkScroll(lessonList);

            AppendLog("智慧树课程助手 · 已启动", false);
            AppendLog("工作目录：" + env.WorkDir, false);

            if (env.NodeExe.Length == 0)
            {
                AppendLog("✗ 没有找到 node.exe，请先安装 Node.js 或使用打包版", true);
            }
            if (!File.Exists(env.Script))
            {
                AppendLog("✗ 没有找到 zhs.mjs：" + env.Script, true);
            }

            LoadCatalog(false);
        }

        void LayoutAll()
        {
            int pad = Theme.S(16);

            // 头部
            int headTop = Theme.S(18);
            mark.Location = new Point(pad, headTop);
            mark.Size = new Size(Theme.S(30), Theme.S(30));

            lblTitle.Location = new Point(pad + Theme.S(42), headTop - Theme.S(1));
            lblTitle.Size = new Size(Theme.S(360), Theme.S(22));

            lblSub.Location = new Point(pad + Theme.S(42), headTop + Theme.S(20));
            lblSub.Size = new Size(Theme.S(520), Theme.S(18));

            int ry = Theme.S(16);
            int rh = Theme.S(34);
            btnRefresh.Height = rh;
            btnLogin.Height = rh;
            btnRefresh.Location = new Point(Math.Max(pad, ClientSize.Width - pad - btnRefresh.Width), ry);
            btnLogin.Location = new Point(btnRefresh.Left - Theme.S(8) - btnLogin.Width, ry);
            pill.Location = new Point(Math.Max(pad, btnLogin.Left - Theme.S(12) - pill.Width), ry + Theme.S(3));

            // 主体
            int contentTop = Theme.S(76);
            int logH = Theme.S(186);
            int gap = Theme.S(16);
            int logTop = ClientSize.Height - pad - logH;
            int contentH = Math.Max(Theme.S(220), logTop - gap - contentTop);
            int leftW = Theme.S(300);
            int rightW = Math.Max(Theme.S(320), ClientSize.Width - pad * 2 - leftW - gap);

            courseCard.Bounds = new Rectangle(pad, contentTop, leftW, contentH);
            lessonCard.Bounds = new Rectangle(pad + leftW + gap, contentTop, rightW, contentH);
            logCard.Bounds = new Rectangle(pad, logTop, ClientSize.Width - pad * 2, logH);

            // 课程卡
            lblCourses.Location = new Point(Theme.S(16), Theme.S(13));
            lblCourses.Size = new Size(leftW - Theme.S(32), Theme.S(18));
            int listTop = Theme.S(38);
            int listH = Math.Max(Theme.S(60), contentH - listTop - Theme.S(6));
            courseList.Location = new Point(Theme.S(6), listTop);
            courseList.Size = new Size(leftW - Theme.S(12), listH);
            courseEmpty.Bounds = new Rectangle(Theme.S(1), listTop, leftW - Theme.S(2), listH);

            // 目录卡
            int lw = lessonCard.Width;
            int lh = lessonCard.Height;
            lblLessonTitle.Location = new Point(Theme.S(18), Theme.S(10));
            lblLessonTitle.Size = new Size(Math.Max(Theme.S(80), lw - Theme.S(36)), Theme.S(24));
            lblLessonMeta.Location = new Point(Theme.S(18), Theme.S(33));
            lblLessonMeta.Size = new Size(Math.Max(Theme.S(80), lw - Theme.S(36)), Theme.S(18));

            int llTop = Theme.S(57);
            int bottomBar = Theme.S(66);
            int llH = Math.Max(Theme.S(80), lh - llTop - bottomBar);
            lessonList.Location = new Point(Theme.S(6), llTop);
            lessonList.Size = new Size(lw - Theme.S(12), llH);
            lessonEmpty.Bounds = new Rectangle(Theme.S(1), llTop + 1, lw - Theme.S(2), llH - 1);

            int barY = lh - bottomBar;
            int btnY = barY + (bottomBar - Theme.S(34)) / 2;
            btnStart.Height = Theme.S(34);
            btnStop.Height = Theme.S(34);
            btnStart.Location = new Point(lw - Theme.S(16) - btnStart.Width, btnY);
            btnStop.Location = new Point(btnStart.Left - Theme.S(8) - btnStop.Width, btnY);

            int pickW = Math.Max(Theme.S(60), btnStop.Left - Theme.S(18) - Theme.S(10));
            lblPick.Location = new Point(Theme.S(18), btnY + Theme.S(4));
            lblPick.Size = new Size(pickW, Theme.S(26));

            // 日志卡
            int cw = logCard.Width;
            int chh = logCard.Height;
            lblLog.Location = new Point(Theme.S(16), Theme.S(9));
            lblLog.Size = new Size(Theme.S(200), Theme.S(21));
            btnClear.Location = new Point(Math.Max(Theme.S(16), cw - Theme.S(12) - btnClear.Width), Theme.S(3));
            logBox.Location = new Point(Theme.S(1), Theme.S(40));
            logBox.Size = new Size(cw - Theme.S(2), chh - Theme.S(41));
        }

        Course SelectedCourse()
        {
            int i = courseList.SelectedIndex;
            if (i < 0 || i >= courseList.Items.Count) return null;
            return courseList.Items[i] as Course;
        }

        void LoadCatalog(bool keepSelection)
        {
            string keepName = null;
            if (keepSelection)
            {
                Course prev = SelectedCourse();
                if (prev != null) keepName = prev.Name;
            }

            string error;
            catalog = CatalogStore.Load(env.CatalogPath, out error);

            courseList.Items.Clear();

            if (catalog == null || catalog.Courses.Count == 0)
            {
                courseEmpty.SetText("还没有课程目录", "点右上角「刷新目录」扫描一次");
                courseEmpty.Visible = true;
                courseEmpty.BringToFront();
                lblLessonTitle.Text = "选择一门课程";
                lblLessonMeta.Text = "";
                lessonList.SetRows(null);
                ShowLessonEmpty("还没有选择课程", "在左侧点选一门课程查看目录");
                UpdateActionBar();
                return;
            }

            courseEmpty.Visible = false;

            int pick = 0;
            for (int i = 0; i < catalog.Courses.Count; i++)
            {
                Course c = catalog.Courses[i];
                courseList.Items.Add(c);
                if (keepName != null && c.Name == keepName) pick = i;
            }

            if (courseList.Items.Count > 0)
            {
                courseList.SelectedIndex = pick;
            }
        }

        void ShowCourse()
        {
            Course c = SelectedCourse();
            if (c == null)
            {
                lblLessonTitle.Text = "选择一门课程";
                lblLessonMeta.Text = "";
                lessonList.SetRows(null);
                ShowLessonEmpty("还没有选择课程", "在左侧点选一门课程查看目录");
                UpdateActionBar();
                return;
            }

            lblLessonTitle.Text = c.Name;

            string meta = c.Chapters.Count.ToString() + " 章 · " + c.Lessons.ToString() + " 节";
            if (c.Known == 0)
            {
                meta += " · 完成状态未知";
            }
            else
            {
                meta += " · 已完成 " + c.Studied.ToString() + " / " + c.Lessons.ToString();
            }
            lblLessonMeta.Text = meta;

            if (c.Error.Length > 0)
            {
                lessonList.SetRows(null);
                ShowLessonEmpty("这门课没有扫描成功", c.Error + "　稍后点右上角「刷新目录」重试");
                UpdateActionBar();
                return;
            }

            List<LessonRow> rows = new List<LessonRow>();
            foreach (Chapter ch in c.Chapters)
            {
                LessonRow hr = new LessonRow();
                hr.IsChapter = true;
                hr.No = ch.No;
                hr.Name = ch.Name.Length > 0 ? ch.Name : ("第 " + ch.No + " 章");
                hr.ChapterName = hr.Name;
                rows.Add(hr);

                foreach (Lesson l in ch.Lessons)
                {
                    LessonRow lr = new LessonRow();
                    lr.IsChapter = false;
                    lr.No = l.No;
                    lr.Name = l.Title;
                    lr.Lesson = l;
                    lr.ChapterName = hr.Name;
                    rows.Add(lr);
                }
            }

            if (rows.Count == 0)
            {
                lessonList.SetRows(null);
                ShowLessonEmpty("这门课还没有目录", "这门课没有可用的章节课节数据");
                UpdateActionBar();
                return;
            }

            lessonEmpty.Visible = false;
            lessonList.Visible = true;
            lessonList.SetRows(rows);

            int pick = -1;
            for (int i = 0; i < rows.Count; i++)
            {
                if (!rows[i].IsChapter && rows[i].Lesson != null && rows[i].Lesson.Studied == false)
                {
                    pick = i;
                    break;
                }
            }
            if (pick < 0)
            {
                for (int i = 0; i < rows.Count; i++)
                {
                    if (!rows[i].IsChapter) { pick = i; break; }
                }
            }
            if (pick >= 0)
            {
                lessonList.SelectedIndex = pick;
                try { lessonList.TopIndex = Math.Max(0, pick - 2); }
                catch { }
            }

            UpdateActionBar();
        }

        void ShowLessonEmpty(string title, string sub)
        {
            lessonEmpty.SetText(title, sub);
            lessonEmpty.Visible = true;
            lessonEmpty.BringToFront();
            lessonList.Visible = false;
        }

        void UpdateActionBar()
        {
            Lesson l = lessonList.SelectedLesson;
            bool busy = job.Busy;

            if (l == null)
            {
                lblPick.Text = "先选一节课";
                btnStart.Text = "开始完成这节";
            }
            else if (l.Studied == true)
            {
                lblPick.Text = "已标记完成 · 需要时可以重新观看";
                btnStart.Text = "重新观看这节";
            }
            else if (!l.Studied.HasValue)
            {
                lblPick.Text = "完成状态未知 · 可直接观看";
                btnStart.Text = "开始完成这节";
            }
            else
            {
                lblPick.Text = "未完成" + (l.Time.Length > 0 ? (" · 时长 " + l.Time) : "");
                btnStart.Text = "开始完成这节";
            }

            btnStart.Enabled = (l != null) && !busy;
            btnStart.FitWidth(Theme.S(140));
            LayoutAll();
        }

        void SetBusy(bool busy)
        {
            btnLogin.Enabled = !busy;
            btnRefresh.Enabled = !busy;
            btnStop.Visible = busy;
            UpdateActionBar();
        }

        void StartJob(string kind, string args)
        {
            if (job.Busy) return;

            if (env.NodeExe.Length == 0)
            {
                MessageBox.Show(this, "没有找到 node.exe。\n请安装 Node.js，或使用打包版（自带 runtime）。",
                    "智慧树课程助手", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            if (!File.Exists(env.Script))
            {
                MessageBox.Show(this, "没有找到 zhs.mjs：\n" + env.Script,
                    "智慧树课程助手", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            job.Kind = kind;
            SetBusy(true);

            if (!job.Start(env.NodeExe, args, env.WorkDir))
            {
                job.Kind = "";
                SetBusy(false);
                pill.SetState("启动失败", Theme.Danger);
                AppendLog("✗ 无法启动 Node 进程", true);
                return;
            }

            pill.SetState("运行中", Theme.Primary);
            if (kind == "login") AppendLog("› 正在打开浏览器，请在窗口里完成登录…", false);
            else if (kind == "catalog") AppendLog("› 正在扫描课程目录…", false);
            else if (kind == "watch") AppendLog("› 正在自动观看所选课节…", false);
        }

        void StartWatch()
        {
            if (job.Busy) return;

            Course c = SelectedCourse();
            Lesson l = lessonList.SelectedLesson;
            if (c == null || l == null) return;

            if (l.Studied == true)
            {
                DialogResult r = MessageBox.Show(this,
                    "这节已标记完成，仍要重新观看吗？",
                    "智慧树课程助手", MessageBoxButtons.OKCancel, MessageBoxIcon.Question);
                if (r != DialogResult.OK) return;
            }

            string args = Quote(env.Script) + " watch --course " + Quote(c.Name) + " --lesson " + Quote(l.No);
            StartJob("watch", args);
        }

        void OnJobDone(int code)
        {
            string kind = job.Kind;
            job.Kind = "";
            SetBusy(false);

            if (kind == "login")
            {
                if (code == 0)
                {
                    pill.SetState("登录完成", Theme.Success);
                    AppendLog("✓ 登录流程结束。接着点「刷新目录」开始扫描。", false);
                }
                else
                {
                    pill.SetState("登录失败", Theme.Danger);
                    AppendLog("✗ 登录结束，退出码 " + code.ToString(), true);
                }
            }
            else if (kind == "catalog")
            {
                LoadCatalog(true);
                if (code == 0)
                {
                    pill.SetState("目录已更新", Theme.Success);
                    AppendLog("✓ 课程目录已更新", false);
                }
                else
                {
                    pill.SetState("扫描失败", Theme.Danger);
                    AppendLog("✗ 目录扫描结束，退出码 " + code.ToString(), true);
                }
            }
            else if (kind == "watch")
            {
                if (code == 0)
                {
                    pill.SetState("看课结束", Theme.Success);
                    AppendLog("✓ 这一节已处理完成。点右上角「刷新目录」可更新完成状态。", false);
                    lblPick.Text = "已完成 · 点「刷新目录」更新状态";
                }
                else
                {
                    pill.SetState("看课失败", Theme.Danger);
                    AppendLog("✗ 看课结束，退出码 " + code.ToString() + "。请查看日志排查原因。", true);
                    lblPick.Text = "看课未完成 · 详情见下方日志";
                }
            }
            else
            {
                pill.SetState("已停止", Theme.InkSubtle);
            }
        }

        void AppendLog(string line, bool isError)
        {
            if (line == null) return;
            if (logBox.TextLength > 400000) logBox.Clear();

            Color col = Theme.InkMuted;
            if (isError) col = Theme.Danger;
            else if (line.IndexOf('\u2717') >= 0 || line.Contains("错误") || line.Contains("失败")) col = Theme.Danger;
            else if (line.IndexOf('\u26a0') >= 0 || line.Contains("警告")) col = Theme.Warning;
            else if (line.IndexOf('\u2713') >= 0 || line.Contains("完成")) col = Theme.Success;
            else if (line.StartsWith("\u2550\u2550") || line.StartsWith("\u25b8") || line.StartsWith("\u2500\u2500") || line.StartsWith("\u203a")) col = Theme.InkSubtle;

            logBox.SelectionStart = logBox.TextLength;
            logBox.SelectionLength = 0;
            logBox.SelectionColor = col;
            logBox.AppendText(line + "\r\n");
            logBox.SelectionStart = logBox.TextLength;
            logBox.ScrollToCaret();
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (job.Busy)
            {
                DialogResult r = MessageBox.Show(this,
                    "任务还在运行，确定要退出吗？",
                    "智慧树课程助手", MessageBoxButtons.OKCancel, MessageBoxIcon.Warning);
                if (r != DialogResult.OK)
                {
                    e.Cancel = true;
                    return;
                }
                job.Stop();
            }
            base.OnFormClosing(e);
        }

        static string Quote(string s)
        {
            s = s == null ? "" : s;

            bool need = s.Length == 0;
            foreach (char c in s)
            {
                if (c == ' ' || c == '\t' || c == '"' || c == '\n' || c == '\v')
                {
                    need = true;
                    break;
                }
            }
            if (!need) return s;

            StringBuilder sb = new StringBuilder("\"");
            int backslashes = 0;
            foreach (char c in s)
            {
                if (c == '\\') { backslashes++; continue; }
                if (c == '"')
                {
                    sb.Append('\\', backslashes * 2 + 1);
                    sb.Append('"');
                    backslashes = 0;
                    continue;
                }
                sb.Append('\\', backslashes);
                backslashes = 0;
                sb.Append(c);
            }
            sb.Append('\\', backslashes * 2);
            sb.Append('"');
            return sb.ToString();
        }
    }
}
