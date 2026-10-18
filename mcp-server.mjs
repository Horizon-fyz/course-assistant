#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
//  mcp-server.mjs —— 把本工具暴露成 MCP 工具，供 AI 客户端直接操控
//
//  传输：stdio（一行一条 JSON-RPC 2.0 消息）
//  客户端：Trae / Claude Desktop / Cursor / 任何支持 MCP 的 AI
//
//  设计要点：
//    - 零依赖，只用 Node 内置模块；
//    - stdout 只写协议消息，所有日志写 stderr（否则会破坏 MCP 握手）；
//    - 短命令同步返回；长命令（登录/抓题/答题/看课）转后台任务，
//      AI 用 zhs_job 轮询进度，避免客户端超时；
//    - answer / watch / auto 会真实写平台数据，必须带 confirm=true。
//
//  手动启动（一般由 AI 客户端拉起）：
//    node mcp-server.mjs
// ═══════════════════════════════════════════════════════════════════
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const ROOT = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;
const ENTRY = join(ROOT, 'zhs.mjs');
const WORKSPACE = (p) => join(ROOT, p);

const SERVER_INFO = { name: 'zhihuishu-automation', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const INSTRUCTIONS = [
  '智慧树自动化工具。推荐顺序：zhs_status → zhs_doctor → zhs_import → zhs_login →',
  'zhs_fetch → zhs_docs → zhs_verify → zhs_solve → zhs_patrol（巡检）→ zhs_deadline（截止看板）→ zhs_answer / zhs_watch。',
  '长命令返回 jobId，用 zhs_job（action=wait/status/logs）跟进；',
  '登录可能需要在弹出的浏览器里人工完成验证码，请提示用户。',
  'zhs_answer / zhs_watch / zhs_auto 会真实写平台数据，调用前必须征得用户同意并带 confirm=true。',
  'zhs_answer 可带 crossCheck=true 交叉验证 AI 答案；存疑题只作答不提交，复核清单见 recon/apply/uncertain-review.md。',
].join('\n');

// ─────────────────────────── 基础工具 ───────────────────────────

const log = (...a) => process.stderr.write('[mcp] ' + a.join(' ') + '\n');

function packEnv(extra = {}) {
  return {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || WORKSPACE('ms-playwright'),
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    ...extra,
  };
}

function clip(text, max = 30000) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  const half = Math.floor(max / 2);
  return s.slice(0, half) + `\n…（中间省略 ${s.length - max} 字符）…\n` + s.slice(-half);
}

function tailLines(text, n) {
  const lines = String(text ?? '').replace(/\s+$/, '').split(/\r?\n/);
  return lines.slice(-Math.max(1, n)).join('\n');
}

function exitText(code, stdout, stderr, timedOut) {
  const parts = [`退出码: ${timedOut ? '超时终止' : code}`];
  if (stdout && stdout.trim()) parts.push('--- stdout ---\n' + stdout.trim());
  if (stderr && stderr.trim()) parts.push('--- stderr ---\n' + stderr.trim());
  if (!stdout?.trim() && !stderr?.trim()) parts.push('（无输出）');
  return parts.join('\n\n');
}

function killTree(child) {
  if (!child || child.killed) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      child.kill('SIGTERM');
    }
  } catch (e) {
    log('kill 失败:', e.message);
  }
}

// ─────────────────────────── 同步命令 ───────────────────────────

function runSync(command, args, { timeoutMs = 120000, stdinData } = {}) {
  return new Promise((resolve) => {
    const child = spawn(NODE, [ENTRY, command, ...args], {
      cwd: ROOT,
      env: packEnv(),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });

    if (stdinData !== undefined) child.stdin.end(stdinData);
    else child.stdin.end();

    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout: out, stderr: err + '\n无法启动 node: ' + e.message, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout: out, stderr: err, timedOut });
    });
  });
}

// ─────────────────────────── 后台任务 ───────────────────────────

const jobs = new Map();
let jobSeq = 0;

function pruneJobs() {
  const done = [...jobs.values()].filter((j) => j.status !== 'running');
  if (done.length <= 20) return;
  done.sort((a, b) => a.startedAt - b.startedAt);
  for (const j of done.slice(0, done.length - 20)) jobs.delete(j.id);
}

function startJob(command, args) {
  const id = 'job-' + (++jobSeq);
  const child = spawn(NODE, [ENTRY, command, ...args], {
    cwd: ROOT,
    env: packEnv(),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const job = {
    id,
    command,
    args,
    child,
    stdout: '',
    stderr: '',
    status: 'running',
    code: null,
    startedAt: Date.now(),
    endedAt: null,
  };
  const keep = (prev, chunk) => (prev + chunk).slice(-200000);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => { job.stdout = keep(job.stdout, d); });
  child.stderr.on('data', (d) => { job.stderr = keep(job.stderr, d); });
  child.on('error', (e) => {
    job.stderr = keep(job.stderr, '\n无法启动 node: ' + e.message);
    job.status = 'failed';
    job.code = 1;
    job.endedAt = Date.now();
  });
  child.on('close', (code) => {
    if (job.status === 'running') job.status = (code ?? 1) === 0 ? 'completed' : 'failed';
    job.code = code ?? 1;
    job.endedAt = Date.now();
    log(`任务 ${id}（${command}）结束，退出码 ${job.code}`);
  });
  jobs.set(id, job);
  pruneJobs();
  return job;
}

function jobHeader(job) {
  const sec = Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 1000);
  const state = job.status === 'running'
    ? '运行中'
    : `${job.status === 'completed' ? '已完成' : job.status === 'canceled' ? '已取消' : '失败'}（退出码 ${job.code}）`;
  return `任务 ${job.id}  command=${job.command}\n状态: ${state}  耗时: ${sec}s`;
}

function jobOutput(job, n = 40) {
  const merged = [job.stdout, job.stderr].filter((s) => s && s.trim()).join('\n');
  return merged ? tailLines(merged, n) : '（暂无输出）';
}

function jobReport(job, n = 40) {
  return jobHeader(job) + '\n\n最新输出：\n' + jobOutput(job, n);
}

function jobStatusBrief(job) {
  const sec = Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 1000);
  return `- ${job.id}  ${job.command}  ${job.status}  ${sec}s`;
}

function waitForJob(job, ms) {
  if (job.status !== 'running') return Promise.resolve(job);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      job.child.removeListener('close', onClose);
      resolve(job);
    }, ms);
    const onClose = () => {
      clearTimeout(timer);
      resolve(job);
    };
    job.child.once('close', onClose);
  });
}

function findJob(id) {
  const job = jobs.get(String(id || ''));
  if (!job) throw new Error(`找不到任务：${id || '(未指定 id)'}。先调用 zhs_job(action=list) 查看。`);
  return job;
}

// ─────────────────────────── 参数 → 命令行 ───────────────────────────

function pushFlag(args, name, value) {
  if (value === undefined || value === null || value === false) return;
  if (value === true) { args.push('--' + name); return; }
  const s = String(value);
  if (s.trim()) args.push('--' + name, s);
}

function browserFlags(a) {
  const out = [];
  pushFlag(out, 'browser', a.browser);
  pushFlag(out, 'browser-exe', a.browserExe);
  pushFlag(out, 'firefox-profile', a.firefoxProfile);
  return out;
}

const BROWSER_PROPS = {
  browser: { type: 'string', enum: ['chromium', 'firefox'], description: '浏览器类型，默认 chromium（Edge / Chrome 等 Chromium 系）。' },
  browserExe: { type: 'string', description: '直接指定浏览器可执行文件路径；文件名含 firefox 时自动走 BiDi。' },
  firefoxProfile: { type: 'string', description: 'Firefox profile 目录（需先完全退出 Firefox）。' },
};

function baseSchema(properties = {}, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

// ─────────────────────────── 工具定义 ───────────────────────────

const TOOLS = [
  {
    name: 'zhs_status',
    description: '查看当前状态：账号、题库规模（课程/作业/题目数）、各产物的大小与更新时间。只读，不访问网络。',
    inputSchema: baseSchema(),
    handler: async () => {
      const r = await runSync('status', [], { timeoutMs: 60000 });
      return { text: exitText(r.code, r.stdout, r.stderr, r.timedOut), isError: r.code !== 0 };
    },
  },
  {
    name: 'zhs_doctor',
    description: '环境自检：Node、Python 文档库、Playwright、浏览器运行时、凭据、登录资料、题库数据。任何自动化开始前先调用。',
    inputSchema: baseSchema(),
    handler: async () => {
      const r = await runSync('doctor', [], { timeoutMs: 120000 });
      return { text: exitText(r.code, r.stdout, r.stderr, r.timedOut), isError: r.code !== 0 };
    },
  },
  {
    name: 'zhs_verify',
    description: '校验产物完整性：papers.json 结构、文档逐题回查、产物清单。只读。退出码 3 表示校验不通过。',
    inputSchema: baseSchema(),
    handler: async () => {
      const r = await runSync('verify', [], { timeoutMs: 120000 });
      return { text: exitText(r.code, r.stdout, r.stderr, r.timedOut), isError: r.code !== 0 };
    },
  },
  {
    name: 'zhs_whoami',
    description: '查看当前生效的凭据及其来源，并查询平台真实姓名。需要浏览器会话，可能较慢。',
    inputSchema: baseSchema(BROWSER_PROPS),
    handler: async (a) => {
      const r = await runSync('whoami', browserFlags(a), { timeoutMs: 90000 });
      return { text: exitText(r.code, r.stdout, r.stderr, r.timedOut), isError: r.code !== 0 };
    },
  },
  {
    name: 'zhs_import',
    description: '导入登录凭据（学校 / 学号 / 密码 / 姓名）。可直接传字段，也可传 from 指定 JSON 文件；字段名会自动识别别名。凭据写入本机 config/credentials.json。',
    inputSchema: baseSchema({
      school: { type: 'string', description: '学校名，必须与登录页下拉框一致。' },
      studentId: { type: 'string', description: '学号。' },
      password: { type: 'string', description: '密码（只用于本机凭据文件，不会写到日志）。' },
      realName: { type: 'string', description: '姓名，可留空。' },
      from: { type: 'string', description: '从指定 JSON 文件导入（字段名自动识别别名）；传了它就不需要再传字段。' },
      saveTo: { type: 'string', description: '写入目标，默认 config/credentials.json。' },
    }),
    handler: async (a) => {
      const extra = [];
      pushFlag(extra, 'save-to', a.saveTo);
      pushFlag(extra, 'school', a.school);
      pushFlag(extra, 'student-id', a.studentId);
      pushFlag(extra, 'real-name', a.realName);
      pushFlag(extra, 'password', a.password);

      let r;
      if (a.from) {
        r = await runSync('import', [a.from, ...extra], { timeoutMs: 60000 });
      } else {
        if (!a.school || !a.studentId || !a.password) {
          return {
            text: '未执行：需要 school、studentId、password 三个字段，或者传 from 指向 JSON 文件。',
            isError: true,
          };
        }
        r = await runSync('import', ['--prompt', ...extra], {
          timeoutMs: 60000,
          stdinData: `${a.school}\n${a.studentId}\n${a.realName || ''}\n${a.password}\n`,
        });
      }
      return { text: exitText(r.code, r.stdout, r.stderr, r.timedOut), isError: r.code !== 0 };
    },
  },
  {
    name: 'zhs_login',
    description: '登录智慧树并固化会话（浏览器重启后仍在线）。后台任务。若出现验证码，会弹出浏览器等待用户人工完成（最多 8 分钟），请提示用户。',
    inputSchema: baseSchema({
      restartCheck: { type: 'boolean', description: '登录后重启浏览器，验证会话是否存活。' },
      school: { type: 'string', description: '临时覆盖学校名（一般先用 zhs_import 导入）。' },
      studentId: { type: 'string', description: '临时覆盖学号。' },
      password: { type: 'string', description: '临时覆盖密码。' },
      realName: { type: 'string', description: '临时覆盖姓名。' },
      account: { type: 'string', description: '从指定 JSON 读取凭据。' },
      ...BROWSER_PROPS,
    }),
    handler: async (a) => {
      const args = [];
      pushFlag(args, 'restart-check', a.restartCheck);
      for (const [flagName, key] of [['school', 'school'], ['student-id', 'studentId'], ['real-name', 'realName'], ['password', 'password'], ['account', 'account']]) {
        pushFlag(args, flagName, a[key]);
      }
      args.push(...browserFlags(a));
      return startJobResult('login', args, '登录已转到后台。若浏览器弹出验证码，请让用户完成；随后用 zhs_job 跟进。');
    },
  },
  {
    name: 'zhs_fetch',
    description: '抓取题库：会话校验 → 发现课程 → 解析考试入口 → 批量抓题 → 提交状态复查。只读取试卷，绝不提交作业。后台任务。',
    inputSchema: baseSchema({
      course: { type: 'string', description: '只处理名称包含该值的课程，例如「国家安全教育」。' },
      dryRun: { type: 'boolean', description: '只发现课程，不抓题（用于确认新课程能否识别）。' },
      ...BROWSER_PROPS,
    }),
    handler: async (a) => {
      const args = [];
      pushFlag(args, 'dry-run', a.dryRun);
      pushFlag(args, 'course', a.course);
      args.push(...browserFlags(a));
      return startJobResult('fetch', args, '抓题已转到后台，可用 zhs_job 跟进；结束后跑 zhs_docs 生成文档。');
    },
  },
  {
    name: 'zhs_docs',
    description: '按现有 export/papers.json 生成文档（Markdown / Word / PDF / Excel），不抓题。后台任务。',
    inputSchema: baseSchema({
      formats: { type: 'string', description: '逗号分隔，可选 md,md-bare,docx,pdf,xlsx；默认全部。' },
      out: { type: 'string', description: '产物输出目录，默认 export/。' },
    }),
    handler: async (a) => {
      const args = [];
      pushFlag(args, 'formats', a.formats);
      pushFlag(args, 'out', a.out);
      return startJobResult('docs', args, '文档生成已转到后台，可用 zhs_job 跟进；随后建议跑 zhs_verify。');
    },
  },
  {
    name: 'zhs_solve',
    description: 'AI 作答：解析题库 Markdown → 调用已配置的 OpenAI 兼容接口 → 输出答案汇总与回填版。会产生接口费用。后台任务。',
    inputSchema: baseSchema({
      mock: { type: 'boolean', description: '离线试跑，不调用任何 AI 接口、不产生费用。' },
      noFill: { type: 'boolean', description: '不产出「已回填答案」副本。' },
      input: { type: 'string', description: '题库 Markdown 路径，默认 export/智慧树作业题库_打印版.md。' },
      limit: { type: 'number', description: '只作答前 N 题（试跑用）。' },
      answerOut: { type: 'string', description: '答案汇总文件路径。' },
      config: { type: 'string', description: 'AI 配置文件路径，默认 md-ai-answer/config.json。' },
      model: { type: 'string', description: '临时覆盖模型名。' },
      baseUrl: { type: 'string', description: '临时覆盖接口根地址（OpenAI 兼容，如 https://api.deepseek.com/v1）。' },
      apiKey: { type: 'string', description: '临时覆盖密钥（仅本次进程使用，不落盘）。' },
      concurrency: { type: 'number', description: '并发请求数。' },
      batchSize: { type: 'number', description: '每批题目数。' },
    }),
    handler: async (a) => {
      const args = [];
      pushFlag(args, 'mock', a.mock);
      pushFlag(args, 'no-fill', a.noFill);
      pushFlag(args, 'input', a.input);
      pushFlag(args, 'limit', a.limit);
      pushFlag(args, 'answer-out', a.answerOut);
      pushFlag(args, 'config', a.config);
      pushFlag(args, 'model', a.model);
      pushFlag(args, 'base-url', a.baseUrl);
      pushFlag(args, 'api-key', a.apiKey);
      pushFlag(args, 'concurrency', a.concurrency);
      pushFlag(args, 'batch-size', a.batchSize);
      return startJobResult('solve', args, 'AI 作答已转到后台，可用 zhs_job 跟进。');
    },
  },
  {
    name: 'zhs_answer',
    description: '【会写平台数据】全自动作业答题：逐份打开未提交作业 → 题库/AI 作答 → 暂存 → 提交（默认真提交）。必须征得用户同意并传 confirm=true。后台任务。',
    inputSchema: baseSchema({
      confirm: { type: 'boolean', description: '必须为 true，表示用户已确认可能真实提交作业。' },
      dry: { type: 'boolean', description: '演练：只列出目标作业，不操作页面。' },
      course: { type: 'string', description: '只处理名称包含该值的课程。' },
      exam: { type: 'string', description: '只处理指定作业/试卷。' },
      limit: { type: 'number', description: '最多处理 N 份作业（0 = 全部）。' },
      noSubmit: { type: 'boolean', description: '只作答并暂存，不点提交。' },
      delay: { type: 'number', description: '每题操作间隔毫秒（下限 120）。' },
      force: { type: 'boolean', description: '存在跳过项时仍继续处理。' },
      noAi: { type: 'boolean', description: '题库未命中时不调用 AI 兜底。' },
      noRethink: { type: 'boolean', description: '关闭交卷后的错题复盘。' },
      noRedo: { type: 'boolean', description: '不自动重做错题。' },
      attempts: { type: 'number', description: '错题重做最多轮数。' },
      redoWait: { type: 'number', description: '重做前等待秒数。' },
      crossCheck: { type: 'boolean', description: 'AI 答案问两次交叉验证；不一致或低置信度的题标记存疑。' },
      minConfidence: { type: 'number', description: '交叉验证的置信度门槛（0~1，默认 0.7）。' },
      allowUncertain: { type: 'boolean', description: '存在交叉验证存疑题时仍然提交（默认不提交）。' },
      ...BROWSER_PROPS,
    }),
    handler: async (a) => {
      const guard = requireConfirm('zhs_answer', a, '它默认会真实提交作业');
      if (guard) return guard;
      const args = [];
      pushFlag(args, 'dry', a.dry);
      pushFlag(args, 'course', a.course);
      pushFlag(args, 'exam', a.exam);
      pushFlag(args, 'limit', a.limit);
      pushFlag(args, 'no-submit', a.noSubmit);
      pushFlag(args, 'delay', a.delay);
      pushFlag(args, 'force', a.force);
      pushFlag(args, 'no-ai', a.noAi);
      pushFlag(args, 'no-rethink', a.noRethink);
      pushFlag(args, 'no-redo', a.noRedo);
      pushFlag(args, 'attempts', a.attempts);
      pushFlag(args, 'redo-wait', a.redoWait);
      pushFlag(args, 'cross-check', a.crossCheck);
      pushFlag(args, 'min-confidence', a.minConfidence);
      pushFlag(args, 'allow-uncertain', a.allowUncertain);
      args.push(...browserFlags(a));
      return startJobResult('answer', args, '答题已转到后台。建议先用 dry=true 确认目标，再用 limit=1 且 noSubmit=true 小范围验证。');
    },
  },
  {
    name: 'zhs_patrol',
    description: '作业巡检：拉取最新作业列表，识别新作业 / 状态变化 / 临近截止，弹 Windows 通知并可推送 Webhook。只读，不提交任何作业。后台任务。',
    inputSchema: baseSchema({
      course: { type: 'string', description: '只巡检名称包含该值的课程。' },
      within: { type: 'number', description: '多少小时内截止的作业重点提醒，默认 48。' },
      offline: { type: 'boolean', description: '不打开浏览器，只用本地 papers.json 出报告。' },
      noNotify: { type: 'boolean', description: '不弹 Windows 通知。' },
      webhook: { type: 'string', description: '额外推送到飞书 / 企微 / 钉钉机器人地址。' },
      dry: { type: 'boolean', description: '只打印结果，不写报告与快照。' },
      ...BROWSER_PROPS,
    }),
    handler: async (a) => {
      const args = [];
      pushFlag(args, 'course', a.course);
      pushFlag(args, 'within', a.within);
      pushFlag(args, 'offline', a.offline);
      pushFlag(args, 'no-notify', a.noNotify);
      pushFlag(args, 'webhook', a.webhook);
      pushFlag(args, 'dry', a.dry);
      args.push(...browserFlags(a));
      return startJobResult('patrol', args, '巡检已转到后台，可用 zhs_job 跟进；结果也会写到 export/patrol-report.json。');
    },
  },
  {
    name: 'zhs_deadline',
    description: '截止看板：把本地 papers.json 渲染成可离线打开的单文件 HTML，按已过期 / 24 小时内 / 1-3 天 / 3-7 天 / 7 天以上分组展示未提交作业。只读本地数据，不打开浏览器、不提交作业。同步返回。',
    inputSchema: baseSchema({
      course: { type: 'string', description: '只看名称包含该值的课程。' },
      out: { type: 'string', description: '产物输出目录，默认 export/；文件名固定为 deadline-board.html。' },
      open: { type: 'boolean', description: '生成后用默认浏览器打开。' },
    }),
    handler: async (a) => {
      const args = [];
      pushFlag(args, 'course', a.course);
      pushFlag(args, 'out', a.out);
      pushFlag(args, 'open', a.open);
      const r = await runSync('deadline', args, { timeoutMs: 30000 });
      return { text: exitText(r.code, r.stdout, r.stderr, r.timedOut), isError: r.code !== 0 };
    },
  },
  {
    name: 'zhs_schedule',
    description: '定时巡检：用 Windows 计划任务每天自动跑 patrol。action=show 查看、install 安装（默认 08:00）、remove 删除。不会提交作业。',
    inputSchema: baseSchema({
      action: { type: 'string', enum: ['show', 'install', 'remove'], description: '要执行的动作，默认 show。' },
      name: { type: 'string', description: '计划任务名，默认 ZHS-Patrol。' },
      time: { type: 'string', description: 'install 时的每日执行时间，HH:MM，默认 08:00。' },
      webhook: { type: 'string', description: 'install 时把 Webhook 地址一并写进巡检命令。' },
    }),
    handler: async (a) => {
      const args = [];
      const action = ['show', 'install', 'remove'].includes(a.action) ? a.action : 'show';
      args.push(action);
      pushFlag(args, 'name', a.name);
      pushFlag(args, 'time', a.time);
      pushFlag(args, 'webhook', a.webhook);
      const r = await runSync('schedule', args, { timeoutMs: 60000 });
      return { text: exitText(r.code, r.stdout, r.stderr, r.timedOut), isError: r.code !== 0 };
    },
  },
  {
    name: 'zhs_watch',
    description: '【会写平台数据】全自动看课：真实播放 + 倍速 + 自动处理弹题，可能需人工完成人脸识别。必须征得用户同意并传 confirm=true。后台任务。',
    inputSchema: baseSchema({
      confirm: { type: 'boolean', description: '必须为 true，表示用户已确认开始真实播放课程。' },
      dry: { type: 'boolean', description: '演练：只列出课程与课节，不播放。' },
      course: { type: 'string', description: '只处理名称包含该值的课程。' },
      lesson: { type: 'string', description: '只处理「序号 + 标题」包含该值的课节。' },
      from: { type: 'string', description: '从匹配的课节开始（含该节）。' },
      max: { type: 'number', description: '每门课最多播放 N 节（0 = 全部）。' },
      minutes: { type: 'number', description: '总时长上限（分钟，0 = 不限）。' },
      rate: { type: 'number', description: '播放倍速，自动夹到 1.0~1.5。' },
      faceWait: { type: 'number', description: '等待人工完成人脸识别的分钟数。' },
      noAi: { type: 'boolean', description: '弹题未命中题库时不调用 AI 兜底。' },
      noTidy: { type: 'boolean', description: '结束后不整理/关闭多余标签页。' },
      ...BROWSER_PROPS,
    }),
    handler: async (a) => {
      const guard = requireConfirm('zhs_watch', a, '它会真实播放课程视频');
      if (guard) return guard;
      const args = [];
      pushFlag(args, 'dry', a.dry);
      pushFlag(args, 'course', a.course);
      pushFlag(args, 'lesson', a.lesson);
      pushFlag(args, 'from', a.from);
      pushFlag(args, 'max', a.max);
      pushFlag(args, 'minutes', a.minutes);
      pushFlag(args, 'rate', a.rate);
      pushFlag(args, 'face-wait', a.faceWait);
      pushFlag(args, 'no-ai', a.noAi);
      pushFlag(args, 'no-tidy', a.noTidy);
      args.push(...browserFlags(a));
      return startJobResult('watch', args, '看课已转到后台。若出现人脸识别，请让用户在浏览器里完成。');
    },
  },
  {
    name: 'zhs_auto',
    description: '【会写平台数据】先答题再全程看课；答题失败不中断看课。必须征得用户同意并传 confirm=true。后台任务。',
    inputSchema: baseSchema({
      confirm: { type: 'boolean', description: '必须为 true，表示用户已确认自动答题与看课。' },
      dry: { type: 'boolean', description: '演练：只列出目标，不操作页面。' },
      course: { type: 'string', description: '只处理名称包含该值的课程。' },
      limit: { type: 'number', description: '答题阶段最多处理 N 份作业。' },
      noSubmit: { type: 'boolean', description: '答题阶段只暂存、不提交。' },
      noAi: { type: 'boolean', description: '未命中题库时不调用 AI 兜底。' },
      noRethink: { type: 'boolean', description: '关闭错题复盘。' },
      noRedo: { type: 'boolean', description: '不自动重做错题。' },
      crossCheck: { type: 'boolean', description: '答题阶段交叉验证 AI 答案，存疑题不提交。' },
      minConfidence: { type: 'number', description: '交叉验证的置信度门槛（0~1，默认 0.7）。' },
      allowUncertain: { type: 'boolean', description: '存在存疑题时仍然提交。' },
      max: { type: 'number', description: '看课阶段每门课最多播放 N 节。' },
      minutes: { type: 'number', description: '看课阶段总时长上限（分钟）。' },
      rate: { type: 'number', description: '播放倍速，自动夹到 1.0~1.5。' },
      faceWait: { type: 'number', description: '等待人脸识别的分钟数。' },
      ...BROWSER_PROPS,
    }),
    handler: async (a) => {
      const guard = requireConfirm('zhs_auto', a, '它会真实提交作业并播放课程');
      if (guard) return guard;
      const args = [];
      for (const [flagName, key] of [
        ['dry', 'dry'], ['course', 'course'], ['limit', 'limit'], ['no-submit', 'noSubmit'],
        ['no-ai', 'noAi'], ['no-rethink', 'noRethink'], ['no-redo', 'noRedo'],
        ['cross-check', 'crossCheck'], ['min-confidence', 'minConfidence'], ['allow-uncertain', 'allowUncertain'],
        ['max', 'max'], ['minutes', 'minutes'], ['rate', 'rate'], ['face-wait', 'faceWait'],
      ]) pushFlag(args, flagName, a[key]);
      args.push(...browserFlags(a));
      return startJobResult('auto', args, '自动答题 + 看课已转到后台，可用 zhs_job 跟进。');
    },
  },
  {
    name: 'zhs_all',
    description: '全流程：抓题 → 生成文档 → 校验 → AI 作答（未配置 AI 时自动跳过）。后台任务。',
    inputSchema: baseSchema({
      course: { type: 'string', description: '只处理名称包含该值的课程。' },
      formats: { type: 'string', description: '透传给 docs 的格式列表。' },
      out: { type: 'string', description: '透传给 docs 的输出目录。' },
      mock: { type: 'boolean', description: '让末端 AI 作答走离线模式。' },
    }),
    handler: async (a) => {
      const args = [];
      pushFlag(args, 'course', a.course);
      pushFlag(args, 'formats', a.formats);
      pushFlag(args, 'out', a.out);
      pushFlag(args, 'mock', a.mock);
      return startJobResult('all', args, '全流程已转到后台，可用 zhs_job 跟进（可能耗时较长）。');
    },
  },
  {
    name: 'zhs_job',
    description: '跟进后台任务：status 查看进度、logs 看输出、wait 等待完成、list 列出任务、cancel 取消任务。',
    inputSchema: baseSchema({
      action: { type: 'string', enum: ['status', 'logs', 'wait', 'list', 'cancel'], description: '要执行的动作。' },
      id: { type: 'string', description: '任务 id（list 之外的 action 必填）。' },
      tailLines: { type: 'number', description: '返回最后多少行输出，默认 status=40 / logs=120。' },
      waitSeconds: { type: 'number', description: 'wait 动作最多等待秒数，默认 20，上限 50。' },
    }, ['action']),
    handler: async (a) => {
      if (a.action === 'list') {
        if (!jobs.size) return { text: '当前没有后台任务。', isError: false };
        const list = [...jobs.values()].sort((x, y) => y.startedAt - x.startedAt);
        return { text: '后台任务：\n' + list.map(jobStatusBrief).join('\n'), isError: false };
      }

      const job = findJob(a.id);
      if (a.action === 'status') {
        return { text: jobReport(job, a.tailLines ?? 40), isError: job.status === 'failed' };
      }
      if (a.action === 'logs') {
        return { text: jobReport(job, a.tailLines ?? 120), isError: job.status === 'failed' };
      }
      if (a.action === 'cancel') {
        if (job.status === 'running') {
          job.status = 'canceled';
          job.endedAt = Date.now();
          killTree(job.child);
        }
        return { text: jobReport(job, 20), isError: false };
      }
      // wait
      const sec = Math.min(50, Math.max(1, Number(a.waitSeconds) || 20));
      await waitForJob(job, sec * 1000);
      const hint = job.status === 'running'
        ? `\n\n仍在运行，可再次调用 zhs_job(action=wait) 或稍后查看 logs。`
        : '';
      return { text: jobReport(job, 60) + hint, isError: job.status === 'failed' };
    },
  },
];

function requireConfirm(name, args, why) {
  if (args.confirm === true) return null;
  return {
    text: `未执行：${name} ${why}。\n请先向用户说明将要发生的事并取得明确同意，然后带 confirm=true 再次调用。\n` +
      '建议先用 dry=true 查看目标，再用 limit=1 + noSubmit=true 做小范围验证。',
    isError: true,
  };
}

function startJobResult(command, args, message) {
  const job = startJob(command, args);
  return {
    text: [
      message,
      `jobId: ${job.id}`,
      `命令: node zhs.mjs ${command}${args.length ? ' ' + args.join(' ') : ''}`,
      '',
      '下一步：zhs_job(action=wait, id=' + job.id + ') 等待，或 zhs_job(action=logs, id=' + job.id + ') 查看输出。',
    ].join('\n'),
    isError: false,
  };
}

// ─────────────────────────── MCP 协议 ───────────────────────────

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function fail(id, code, message, data) {
  send({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } });
}

async function handle(msg) {
  const { id, method, params } = msg;

  // 通知（无 id）不回复
  if (id === undefined || id === null) {
    if (method === 'notifications/initialized') log('客户端初始化完成');
    return;
  }

  try {
    switch (method) {
      case 'initialize': {
        const asked = params?.protocolVersion;
        const version = SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0];
        reply(id, {
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        });
        return;
      }
      case 'ping':
        reply(id, {});
        return;
      case 'tools/list':
        reply(id, {
          tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        });
        return;
      case 'tools/call': {
        const name = params?.name;
        const tool = TOOLS.find((t) => t.name === name);
        if (!tool) {
          fail(id, -32602, `未知工具：${name}`);
          return;
        }
        const args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};
        const started = Date.now();
        log(`调用 ${name} ${JSON.stringify({ ...args, password: args.password ? '***' : undefined, apiKey: args.apiKey ? '***' : undefined })}`);
        const result = await tool.handler(args);
        log(`完成 ${name}，${Date.now() - started}ms`);
        reply(id, {
          content: [{ type: 'text', text: clip(result.text) }],
          isError: !!result.isError,
        });
        return;
      }
      case 'resources/list':
        reply(id, { resources: [] });
        return;
      case 'prompts/list':
        reply(id, { prompts: [] });
        return;
      default:
        fail(id, -32601, `不支持的方法：${method}`);
    }
  } catch (e) {
    log('处理失败:', e?.stack || e?.message || String(e));
    fail(id, -32603, e?.message || '内部错误');
  }
}

rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch (e) {
    log('收到非 JSON 消息，已忽略');
    return;
  }
  handle(msg).catch((e) => log('未捕获异常:', e?.message || String(e)));
});

function shutdown() {
  for (const job of jobs.values()) {
    if (job.status === 'running') {
      job.status = 'canceled';
      killTree(job.child);
    }
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
rl.on('close', shutdown);

log(`已启动，工作区 ${ROOT}`);
