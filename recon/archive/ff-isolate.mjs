// 隔离测试 Playwright Firefox 的 -juggler-pipe 崩溃原因
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const fs = await import('node:fs');

const FF = join(ROOT, 'ms-playwright', 'firefox-1555', 'firefox', 'firefox.exe');
const DIR = join(ROOT, 'ff-test');

function run(label, profileDir, extraArgs = [], prefs = null) {
  console.log(`\n=== ${label} ===`);
  rmSync(profileDir, { recursive: true, force: true });
  mkdirSync(profileDir, { recursive: true });
  if (prefs) writeFileSync(profileDir + '\\prefs.js', prefs, 'utf8');

  const outF = DIR + '\\out.txt';
  const errF = DIR + '\\err.txt';
  const fdOut = fs.openSync(outF, 'w');
  const fdErr = fs.openSync(errF, 'w');

  // 用 taskkill 在超时后清理；这里用 spawnSync + timeout
  const r = spawnSync(FF, ['-no-remote', '-profile', profileDir, ...extraArgs], {
    stdio: ['ignore', fdOut, fdErr],
    timeout: 15000,          // 15 秒后强制结束
    windowsHide: true,
  });
  fs.closeSync(fdOut); fs.closeSync(fdErr);

  const err = fs.readFileSync(errF, 'utf8');
  const killed = r.error && r.error.code === 'ETIMEDOUT';
  console.log(`  status=${r.status} signal=${r.signal} ${killed ? '(15 秒超时被结束 → 说明它稳定运行)' : ''}`);
  if (r.error) console.log('  error:', r.error.code || r.error.message);
  const lines = err.split('\n').filter((l) => /error|Error|WARNING: Performing|Startup|Remote agent|InstallerPrefs/.test(l));
  if (lines.length) { console.log('  日志关键行:'); for (const l of lines.slice(0, 12)) console.log('    ' + l.trim().slice(0, 160)); }
  return { status: r.status, killed };
}

rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });

const A = run('A. 裸启动（无 juggler）', DIR + '\\pa');
const B = run('B. -juggler-pipe', DIR + '\\pb', ['-juggler-pipe', 'about:blank']);
const C = run('C. -juggler-pipe + 禁用遥测/默认浏览器检查', DIR + '\\pc', ['-juggler-pipe', 'about:blank'],
  `user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.defaultbrowser.notificationbar", false);
user_pref("browser.shell.shortcutFavicons", false);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("datareporting.healthreport.uploadEnabled", false);
user_pref("toolkit.telemetry.enabled", false);
user_pref("toolkit.telemetry.unified", false);
user_pref("browser.newtabpage.activity-stream.feeds.telemetry", false);
user_pref("browser.ping-centre.telemetry", false);
user_pref("extensions.installDistroAddons", false);
user_pref("browser.discovery.enabled", false);
user_pref("app.update.enabled", false);
user_pref("browser.tabs.warnOnClose", false);
`);

console.log('\n\n================ 判定 ================');
console.log(`  裸启动           : ${A.killed ? '✅ 正常运行' : '❌ status=' + A.status}`);
console.log(`  juggler-pipe     : ${B.killed ? '✅ 正常运行' : '❌ status=' + B.status}`);
console.log(`  juggler+预置prefs: ${C.killed ? '✅ 正常运行' : '❌ status=' + C.status}`);
