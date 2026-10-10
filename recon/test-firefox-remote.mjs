// 认真测试系统 Firefox 的远程调试可否被接管
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

const FF = join(process.env.ProgramFiles || 'C:\\Program Files', 'Mozilla Firefox', 'firefox.exe');
const PROFILE = join(ROOT, 'browser-profile-firefox');
const PORT = 6100;
mkdirSync(PROFILE, { recursive: true });

// 先确保没有占用该 profile 的旧进程
try {
  execFileSync('powershell.exe', ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process -Filter "Name='firefox.exe'" | Where-Object { $_.CommandLine -like '*browser-profile-ff*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`],
    { encoding: 'utf8' });
} catch {}

console.log('启动 Firefox（profile 隔离 + 远程调试端口 ' + PORT + '）…');
const args = [
  '--remote-debugging-port', String(PORT),
  '--profile', PROFILE,
  '--no-first-run',
  'about:blank',
];
const child = spawn(FF, args, { detached: true, stdio: 'ignore' });
child.unref();

// 等待端口
let up = false;
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  try {
    await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(2000) });
    up = true; break;
  } catch {}
}
console.log('端口可用:', up);

// 探测端点
const paths = ['/json/version', '/json/list', '/json/protocol', '/session', '/', '/json'];
const probe = {};
for (const p of paths) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { signal: AbortSignal.timeout(4000) });
    const t = await r.text();
    probe[p] = { status: r.status, len: t.length, head: t.slice(0, 220) };
  } catch (e) { probe[p] = { error: String(e).slice(0, 80) }; }
}
console.log('\n=== 端点探测 ===');
console.log(JSON.stringify(probe, null, 1));

// 尝试 Playwright 接管
let cdpResult;
try {
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const ctx = b.contexts()[0];
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  const ua = await page.evaluate(() => navigator.userAgent).catch(() => null);
  cdpResult = { ok: true, contexts: b.contexts().length, ua };
  await b.close().catch(() => {});
} catch (e) {
  cdpResult = { ok: false, err: String(e).slice(0, 200) };
}
console.log('\n=== connectOverCDP 接管结果 ===');
console.log(JSON.stringify(cdpResult, null, 1));

writeFileSync(join(ROOT, 'recon', 'firefox-remote.json'), JSON.stringify({ up, probe, cdpResult, args }, null, 2));
console.log('\n已保存 recon/firefox-remote.json');
