// setup-ai.cs —— 「设置AI密钥」图形界面
//
// 编译：
//   csc /nologo /codepage:65001 /target:winexe /platform:anycpu /optimize+ ^
//       /r:System.dll /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll ^
//       /out:"设置AI密钥.exe" tools\setup-ai.cs
//
// 功能：读写 app\md-ai-answer\config.json 里的思考模型配置（OpenAI 兼容接口，密钥留空也能正常跑）。

using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace ZhiHuiShuSetup
{
    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            try
            {
                Application.Run(new SetupForm());
            }
            catch (Exception ex)
            {
                MessageBox.Show("设置工具启动失败：\n" + ex.Message, "AI 密钥设置",
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }
    }

    internal sealed class SetupForm : Form
    {
        private sealed class ProviderPreset
        {
            public readonly string Name;
            public readonly string BaseUrl;
            public readonly string Model;

            public ProviderPreset(string name, string baseUrl, string model)
            {
                Name = name;
                BaseUrl = baseUrl;
                Model = model;
            }

            public override string ToString() { return Name; }
        }

        /** 常用 OpenAI 兼容厂商（仅文本/推理模型）；空 BaseUrl 表示自定义 */
        private static readonly ProviderPreset[] Presets = new ProviderPreset[]
        {
            new ProviderPreset("DeepSeek", "https://api.deepseek.com/v1", "deepseek-reasoner"),
            new ProviderPreset("阿里云百炼（通义千问）", "https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen3-max"),
            new ProviderPreset("智谱 AI（GLM）", "https://open.bigmodel.cn/api/paas/v4", "glm-4.6"),
            new ProviderPreset("月之暗面（Kimi）", "https://api.moonshot.cn/v1", "kimi-k2-0905-preview"),
            new ProviderPreset("硅基流动 SiliconFlow", "https://api.siliconflow.cn/v1", "deepseek-ai/DeepSeek-V3"),
            new ProviderPreset("火山方舟（豆包）", "https://ark.cn-beijing.volces.com/api/v3", "doubao-seed-1-6-250615"),
            new ProviderPreset("腾讯混元", "https://api.hunyuan.cloud.tencent.com/v1", "hunyuan-t1-latest"),
            new ProviderPreset("百度千帆（文心一言）", "https://qianfan.baidubce.com/v2", "ernie-4.5-turbo-128k"),
            new ProviderPreset("MiniMax", "https://api.minimaxi.com/v1", "MiniMax-M1"),
            new ProviderPreset("阶跃星辰 StepFun", "https://api.stepfun.com/v1", "step-2-16k"),
            new ProviderPreset("零一万物（Yi）", "https://api.lingyiwanwu.com/v1", "yi-lightning"),
            new ProviderPreset("讯飞星火", "https://spark-api-open.xf-yun.com/v1", "4.0Ultra"),
            new ProviderPreset("OpenAI", "https://api.openai.com/v1", "gpt-4.1-mini"),
            new ProviderPreset("OpenRouter", "https://openrouter.ai/api/v1", "openai/gpt-4.1"),
            new ProviderPreset("Groq", "https://api.groq.com/openai/v1", "llama-3.3-70b-versatile"),
            new ProviderPreset("Ollama（本地）", "http://127.0.0.1:11434/v1", "qwen3:8b"),
            new ProviderPreset("LM Studio（本地）", "http://127.0.0.1:1234/v1", ""),
            new ProviderPreset("vLLM / 其它本地服务", "http://127.0.0.1:8000/v1", ""),
            new ProviderPreset("自定义（其它 OpenAI 兼容接口）", "", ""),
        };

        private readonly string _configPath;
        private readonly ComboBox _provider = new ComboBox();
        private readonly TextBox _baseUrl = new TextBox();
        private readonly TextBox _model = new TextBox();
        private readonly TextBox _apiKey = new TextBox();
        private readonly CheckBox _show = new CheckBox();
        private readonly LinkLabel _link = new LinkLabel();
        private bool _loading;

        public SetupForm()
        {
            // 两种分发形态：自动答题包写在 app\md-ai-answer\config.json；
            // 桌面助手包写在根目录 config.json（与外壳 ZHS_CONFIG 一致）。优先沿用已存在的那个。
            string baseDir = AppDomain.CurrentDomain.BaseDirectory;
            string legacy = Path.Combine(baseDir, "app", "md-ai-answer", "config.json");
            string rootCfg = Path.Combine(baseDir, "config.json");
            _configPath = File.Exists(legacy) ? legacy : (File.Exists(rootCfg) ? rootCfg : legacy);

            Text = "AI 密钥设置 - 智慧树一键全自动";
            Font = new Font("Microsoft YaHei UI", 9F);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(560, 370);
            AutoScaleMode = AutoScaleMode.Font;

            var title = new Label
            {
                Text = "AI 接口设置（OpenAI 兼容）",
                Font = new Font("Microsoft YaHei UI", 13F, FontStyle.Bold),
                AutoSize = true,
                Location = new Point(20, 16),
            };
            Controls.Add(title);

            var desc = new Label
            {
                Text = "选厂商自动填地址与模型，也可选「自定义」手填任意兼容接口。\n不填密钥也能跑：题库没覆盖的题会随机作答。",
                ForeColor = Color.FromArgb(90, 90, 90),
                AutoSize = true,
                Location = new Point(22, 52),
            };
            Controls.Add(desc);

            _provider.DropDownStyle = ComboBoxStyle.DropDownList;
            _provider.Items.AddRange(Presets);
            _provider.SelectedIndexChanged += delegate { OnProviderChanged(); };
            AddRow("厂商预设", _provider, 96);
            AddRow("API 地址", _baseUrl, 136);
            AddRow("模型", _model, 176);
            AddRow("API 密钥", _apiKey, 216);

            _apiKey.UseSystemPasswordChar = true;

            _show.Text = "显示密钥";
            _show.AutoSize = true;
            _show.Location = new Point(120, 250);
            _show.CheckedChanged += delegate { _apiKey.UseSystemPasswordChar = !_show.Checked; };
            Controls.Add(_show);

            var hint = new Label
            {
                Text = "地址填到 /v1 这一级即可（粘贴完整 /chat/completions 也会自动识别）。密钥只保存在本机："
                    + _configPath,
                ForeColor = Color.FromArgb(120, 120, 120),
                AutoSize = false,
                Size = new Size(516, 20),
                Location = new Point(22, 278),
            };
            Controls.Add(hint);

            _link.Text = "没有密钥？点这里去 DeepSeek 申请";
            _link.AutoSize = true;
            _link.Location = new Point(22, 302);
            _link.LinkClicked += delegate
            {
                try { Process.Start("https://platform.deepseek.com/api_keys"); }
                catch { }
            };
            Controls.Add(_link);

            var save = new Button
            {
                Text = "保存",
                Size = new Size(96, 32),
                Location = new Point(342, 322),
            };
            save.Click += delegate { Save(); };
            Controls.Add(save);

            var cancel = new Button
            {
                Text = "取消",
                Size = new Size(96, 32),
                Location = new Point(446, 322),
                DialogResult = DialogResult.Cancel,
            };
            Controls.Add(cancel);

            // 手动改地址后，自动反查对应厂商（找不到就归为自定义）
            _baseUrl.Leave += delegate
            {
                if (_loading) return;
                SelectPresetByBaseUrl(_baseUrl.Text);
                UpdateLink();
            };

            AcceptButton = save;
            CancelButton = cancel;

            LoadConfig();
        }

        private void AddRow(string caption, Control box, int top)
        {
            var label = new Label
            {
                Text = caption,
                AutoSize = false,
                Size = new Size(92, 24),
                TextAlign = ContentAlignment.MiddleLeft,
                Location = new Point(22, top),
            };
            Controls.Add(label);

            box.Location = new Point(118, top);
            box.Size = new Size(412, 26);
            Controls.Add(box);
        }

        /** 统一地址格式：去空白、去尾斜杠、去掉误粘贴的 /chat/completions */
        private static string NormalizeBaseUrl(string url)
        {
            var s = (url ?? "").Trim().TrimEnd('/');
            const string suffix = "/chat/completions";
            if (s.Length >= suffix.Length &&
                s.Substring(s.Length - suffix.Length).Equals(suffix, StringComparison.OrdinalIgnoreCase))
            {
                s = s.Substring(0, s.Length - suffix.Length).TrimEnd('/');
            }
            return s;
        }

        /** 按地址反查厂商；未命中则选中「自定义」 */
        private void SelectPresetByBaseUrl(string url)
        {
            int customIndex = Presets.Length - 1;
            string target = NormalizeBaseUrl(url);

            if (target.Length > 0)
            {
                for (int i = 0; i < Presets.Length; i++)
                {
                    string presetUrl = NormalizeBaseUrl(Presets[i].BaseUrl);
                    if (presetUrl.Length > 0 &&
                        presetUrl.Equals(target, StringComparison.OrdinalIgnoreCase))
                    {
                        _provider.SelectedIndex = i;
                        return;
                    }
                }
            }
            _provider.SelectedIndex = customIndex;
        }

        /** 选中预设时填地址与模型；「自定义」保留用户已填内容 */
        private void ApplyPreset(ProviderPreset preset)
        {
            if (preset == null || preset.BaseUrl.Length == 0) return;
            _baseUrl.Text = preset.BaseUrl;
            _model.Text = preset.Model;
        }

        private void OnProviderChanged()
        {
            if (_loading) return;
            ApplyPreset(_provider.SelectedItem as ProviderPreset);
            UpdateLink();
        }

        /** 仅 DeepSeek 显示申请链接 */
        private void UpdateLink()
        {
            var preset = _provider.SelectedItem as ProviderPreset;
            _link.Visible = preset != null && preset.Name == "DeepSeek";
        }

        private void LoadConfig()
        {
            if (!File.Exists(_configPath))
            {
                MessageBox.Show(
                    "找不到配置文件：\n" + _configPath +
                    "\n\n请先把本程序放在「智慧树一键全自动」目录下（和 一键开始.exe 同一个位置）。",
                    "AI 密钥设置", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                Close();
                return;
            }

            try
            {
                var cfg = ReadJson(_configPath);
                _loading = true;
                _baseUrl.Text = Get(cfg, "reasonBaseUrl", "https://api.deepseek.com/v1");
                _model.Text = Get(cfg, "reasonModel", "deepseek-reasoner");
                _apiKey.Text = Get(cfg, "reasonApiKey", "");
                SelectPresetByBaseUrl(_baseUrl.Text);
                _loading = false;
                UpdateLink();
            }
            catch (Exception ex)
            {
                _loading = false;
                MessageBox.Show("读取配置失败：\n" + ex.Message, "AI 密钥设置",
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
                Close();
            }
        }

        private void Save()
        {
            try
            {
                var cfg = File.Exists(_configPath) ? ReadJson(_configPath) : new Dictionary<string, object>();

                var baseUrl = _baseUrl.Text.Trim();
                var model = _model.Text.Trim();
                var key = _apiKey.Text.Trim();

                cfg["reasonBaseUrl"] = baseUrl.Length > 0 ? baseUrl : "https://api.deepseek.com/v1";
                cfg["reasonModel"] = model.Length > 0 ? model : "deepseek-reasoner";
                cfg["reasonApiKey"] = key;

                if (!cfg.ContainsKey("temperature")) cfg["temperature"] = 0.2;
                if (!cfg.ContainsKey("timeoutMs")) cfg["timeoutMs"] = 60000;
                if (!cfg.ContainsKey("maxRetries")) cfg["maxRetries"] = 3;

                var json = ToJson(cfg) + Environment.NewLine;
                Directory.CreateDirectory(Path.GetDirectoryName(_configPath));
                WriteTextAtomic(_configPath, json);

                MessageBox.Show(
                    key.Length > 0
                        ? "已保存。下次运行「一键开始.exe」会自动使用这个密钥。"
                        : "已保存（密钥为空）。题库没覆盖的题会随机作答。",
                    "AI 密钥设置", MessageBoxButtons.OK, MessageBoxIcon.Information);
                Close();
            }
            catch (Exception ex)
            {
                MessageBox.Show("保存失败：\n" + ex.Message, "AI 密钥设置",
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        /** 原子写：先写临时文件再替换，避免写一半崩溃导致配置文件损坏 */
        private static void WriteTextAtomic(string path, string text)
        {
            string tmp = path + ".tmp";
            try
            {
                File.WriteAllText(tmp, text, new UTF8Encoding(false));
                if (File.Exists(path))
                {
                    try { File.Replace(tmp, path, null); }
                    catch
                    {
                        File.Copy(tmp, path, true);
                        File.Delete(tmp);
                    }
                }
                else
                {
                    File.Move(tmp, path);
                }
            }
            catch
            {
                try { if (File.Exists(tmp)) File.Delete(tmp); } catch { }
                throw;
            }
        }

        private static Dictionary<string, object> ReadJson(string path)
        {
            var text = File.ReadAllText(path, Encoding.UTF8).Trim();
            if (text.Length == 0) return new Dictionary<string, object>();
            var ser = new JavaScriptSerializer();
            return ser.Deserialize<Dictionary<string, object>>(text) ?? new Dictionary<string, object>();
        }

        private static string Get(Dictionary<string, object> cfg, string name, string fallback)
        {
            object v;
            if (cfg.TryGetValue(name, out v) && v != null)
            {
                var s = v as string;
                if (s != null) return s;
                return Convert.ToString(v);
            }
            return fallback;
        }

        private static string ToJson(object value)
        {
            var sb = new StringBuilder();
            WriteJson(sb, value, 0);
            return sb.ToString();
        }

        private static void WriteJson(StringBuilder sb, object value, int indent)
        {
            var pad = new string(' ', indent);
            var pad2 = new string(' ', indent + 2);

            var dict = value as IDictionary<string, object>;
            if (dict != null)
            {
                sb.Append("{\n");
                var i = 0;
                foreach (var kv in dict)
                {
                    sb.Append(pad2).Append(Quote(kv.Key)).Append(": ");
                    WriteJson(sb, kv.Value, indent + 2);
                    if (++i < dict.Count) sb.Append(',');
                    sb.Append('\n');
                }
                sb.Append(pad).Append('}');
                return;
            }

            var arr = value as IEnumerable;
            if (arr != null && !(value is string))
            {
                sb.Append("[\n");
                var i = 0;
                var list = new List<object>();
                foreach (var item in arr) list.Add(item);
                foreach (var item in list)
                {
                    sb.Append(pad2);
                    WriteJson(sb, item, indent + 2);
                    if (++i < list.Count) sb.Append(',');
                    sb.Append('\n');
                }
                sb.Append(pad).Append(']');
                return;
            }

            if (value == null) { sb.Append("null"); return; }
            if (value is bool) { sb.Append(((bool)value) ? "true" : "false"); return; }
            if (value is string) { sb.Append(Quote((string)value)); return; }
            sb.Append(Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture));
        }

        private static string Quote(string s)
        {
            return new JavaScriptSerializer().Serialize(s ?? "");
        }
    }
}
