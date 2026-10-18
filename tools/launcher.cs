// 一键开始.exe 的启动器：找到 Node → 运行 start.mjs → 结束时停住窗口。
// 编译：csc /nologo /codepage:65001 /target:exe /platform:anycpu /out:一键开始.exe tools\launcher.cs
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

static class Launcher
{
    // Windows 命令行参数转义：反斜杠只在引号前加倍，参数末尾的反斜杠在闭合引号前加倍
    static string Quote(string s)
    {
        s = s ?? "";
        bool need = s.Length == 0;
        foreach (char c in s)
        {
            if (c == ' ' || c == '\t' || c == '"' || c == '\n' || c == '\v') { need = true; break; }
        }
        if (!need) return s;

        var sb = new StringBuilder("\"");
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

    /* Job Object：启动器被关闭（含点 × 结束控制台）时，系统一并结束 node 子进程树 */
    const int JobObjectExtendedLimitInformation = 9;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll")]
    static extern bool SetInformationJobObject(IntPtr hJob, int infoClass, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);

    [DllImport("kernel32.dll")]
    static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr hObject);

    static IntPtr CreateKillOnCloseJob()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) return IntPtr.Zero;

        var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        int len = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr buf = Marshal.AllocHGlobal(len);
        try
        {
            Marshal.StructureToPtr(info, buf, false);
            SetInformationJobObject(job, JobObjectExtendedLimitInformation, buf, (uint)len);
        }
        finally { Marshal.FreeHGlobal(buf); }
        return job;
    }

    static string FindNode(string dir)
    {
        // 1) 安装版 / 便携版：runtime\node.exe（自带运行时，不依赖系统 Node）
        string runtime = Path.Combine(dir, "runtime", "node.exe");
        if (File.Exists(runtime)) return runtime;

        // 2) 开发版：node\node.exe
        string nodeDir = Path.Combine(dir, "node", "node.exe");
        if (File.Exists(nodeDir)) return nodeDir;

        // 3) exe 同目录放了便携版 node.exe 就直接用
        string local = Path.Combine(dir, "node.exe");
        if (File.Exists(local)) return local;

        // 4) 系统 PATH
        string pathVar = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (string raw in pathVar.Split(';'))
        {
            if (string.IsNullOrWhiteSpace(raw)) continue;
            try
            {
                string candidate = Path.Combine(raw.Trim().Trim('"'), "node.exe");
                if (File.Exists(candidate)) return candidate;
            }
            catch { }
        }

        // 3) DSH 运行时自带的 Node
        string dsh = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            @".dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe");
        if (File.Exists(dsh)) return dsh;

        // 4) 官方安装器默认位置
        string pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        string installed = Path.Combine(pf, @"nodejs\node.exe");
        if (File.Exists(installed)) return installed;

        return null;
    }

    static int Main(string[] args)
    {
        string dir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        try { Console.Title = "智慧树 · 一键全自动"; } catch { }

        // 安装版：exe 在根目录，程序本体在 app\；开发版：start.mjs 就在 exe 同目录
        string workDir = Path.Combine(dir, "app");
        string script = Path.Combine(workDir, "start.mjs");
        if (!File.Exists(script))
        {
            workDir = dir;
            script = Path.Combine(dir, "start.mjs");
        }
        if (!File.Exists(script))
        {
            Console.WriteLine("[错误] 找不到 start.mjs，安装目录不完整，请重新安装。");
            Pause();
            return 1;
        }
        Directory.SetCurrentDirectory(workDir);

        string node = FindNode(dir);
        if (node == null)
        {
            Console.WriteLine("[错误] 没有找到 Node.js（安装目录缺少 runtime\\node.exe）。");
            Console.WriteLine("请重新安装本程序，或安装 https://nodejs.org/ 后重试。");
            Pause();
            return 1;
        }

        // Playwright 的浏览器缓存固定放在项目目录，避免换电脑后路径失效
        if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("PLAYWRIGHT_BROWSERS_PATH")))
        {
            string browsers = Path.Combine(dir, "ms-playwright");
            if (Directory.Exists(browsers))
                Environment.SetEnvironmentVariable("PLAYWRIGHT_BROWSERS_PATH", browsers);
        }

        string arguments = Quote(script);
        if (args != null && args.Length > 0)
            arguments += " " + string.Join(" ", Array.ConvertAll(args, Quote));

        var psi = new ProcessStartInfo();
        psi.FileName = node;
        psi.Arguments = arguments;
        psi.WorkingDirectory = workDir;
        psi.UseShellExecute = false;

        int code;
        IntPtr job = IntPtr.Zero;
        try
        {
            job = CreateKillOnCloseJob();
            using (Process p = Process.Start(psi))
            {
                if (job != IntPtr.Zero) AssignProcessToJobObject(job, p.Handle);
                p.WaitForExit();
                code = p.ExitCode;
            }
        }
        catch (Exception e)
        {
            Console.WriteLine();
            Console.WriteLine("[错误] 启动失败：" + e.Message);
            Pause();
            return 1;
        }
        finally
        {
            if (job != IntPtr.Zero) CloseHandle(job);
        }

        Console.WriteLine();
        Console.WriteLine(code == 0
            ? "[完成] 全部结束，退出码 0。"
            : "[未完成] 退出码 " + code + "，请按上面的提示处理后重新双击。");
        Pause();
        return code;
    }

    static void Pause()
    {
        Console.WriteLine();
        Console.WriteLine("按任意键关闭窗口……");
        try { Console.ReadKey(true); } catch { }
    }
}
