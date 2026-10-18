// setup-ai.cs —— 「设置AI密钥」图形界面
//
// 编译：
//   csc /nologo /codepage:65001 /target:winexe /platform:anycpu /optimize+ ^
//       /r:System.dll /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll ^
//       /out:"设置AI密钥.exe" tools\setup-ai.cs
//
// 功能：读写 app\md-ai-answer\config.json 里的 DeepSeek 配置（密钥留空也能正常跑）。

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
        private readonly string _configPath;
        private readonly TextBox _baseUrl = new TextBox();
        private readonly TextBox _model = new TextBox();
        private readonly TextBox _apiKey = new TextBox();
        private readonly CheckBox _show = new CheckBox();

        public SetupForm()
        {
            _configPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory,
                "app", "md-ai-answer", "config.json");

            Text = "AI 密钥设置 - 智慧树一键全自动";
            Font = new Font("Microsoft YaHei UI", 9F);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(560, 322);
            AutoScaleMode = AutoScaleMode.Font;

            var title = new Label
            {
                Text = "DeepSeek API 密钥（可选）",
                Font = new Font("Microsoft YaHei UI", 13F, FontStyle.Bold),
                AutoSize = true,
                Location = new Point(20, 16),
            };
            Controls.Add(title);

            var desc = new Label
            {
                Text = "不填也能跑：题库没覆盖的题会随机作答。\n填了密钥后，遇到新题会交给 AI 作答，正确率更高。",
                ForeColor = Color.FromArgb(90, 90, 90),
                AutoSize = true,
                Location = new Point(22, 52),
            };
            Controls.Add(desc);

            AddRow("API 地址", _baseUrl, 92);
            AddRow("模型", _model, 132);
            AddRow("API 密钥", _apiKey, 172);

            _apiKey.UseSystemPasswordChar = true;
            _apiKey.Width = 410;

            _show.Text = "显示密钥";
            _show.AutoSize = true;
            _show.Location = new Point(120, 206);
            _show.CheckedChanged += delegate { _apiKey.UseSystemPasswordChar = !_show.Checked; };
            Controls.Add(_show);

            var hint = new Label
            {
                Text = "密钥只保存在本机：app\\md-ai-answer\\config.json",
                ForeColor = Color.FromArgb(120, 120, 120),
                AutoSize = true,
                Location = new Point(22, 236),
            };
            Controls.Add(hint);

            var link = new LinkLabel
            {
                Text = "没有密钥？点这里去 DeepSeek 申请",
                AutoSize = true,
                Location = new Point(22, 260),
            };
            link.LinkClicked += delegate
            {
                try { Process.Start("https://platform.deepseek.com/api_keys"); }
                catch { }
            };
            Controls.Add(link);

            var save = new Button
            {
                Text = "保存",
                Size = new Size(96, 32),
                Location = new Point(342, 278),
            };
            save.Click += delegate { Save(); };
            Controls.Add(save);

            var cancel = new Button
            {
                Text = "取消",
                Size = new Size(96, 32),
                Location = new Point(446, 278),
                DialogResult = DialogResult.Cancel,
            };
            Controls.Add(cancel);

            AcceptButton = save;
            CancelButton = cancel;

            LoadConfig();
        }

        private void AddRow(string caption, TextBox box, int top)
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
                _baseUrl.Text = Get(cfg, "reasonBaseUrl", "https://api.deepseek.com/v1");
                _model.Text = Get(cfg, "reasonModel", "deepseek-chat");
                _apiKey.Text = Get(cfg, "reasonApiKey", "");
            }
            catch (Exception ex)
            {
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
                cfg["reasonModel"] = model.Length > 0 ? model : "deepseek-chat";
                cfg["reasonApiKey"] = key;

                if (!cfg.ContainsKey("temperature")) cfg["temperature"] = 0.2;
                if (!cfg.ContainsKey("timeoutMs")) cfg["timeoutMs"] = 60000;
                if (!cfg.ContainsKey("maxRetries")) cfg["maxRetries"] = 3;

                var json = ToJson(cfg) + Environment.NewLine;
                Directory.CreateDirectory(Path.GetDirectoryName(_configPath));
                File.WriteAllText(_configPath, json, new UTF8Encoding(false));

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
