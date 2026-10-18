// 从 Firefox 的 cookie 库读取智慧树会话（不启动浏览器，仅读文件）
// 适用：你手动在 Firefox 里登录后，把会话交给自动化使用
import { existsSync, readdirSync, writeFileSync, mkdirSync, copyFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PY as PYTHON } from '../core/python.mjs';

const ROOT = join(import.meta.dirname, '..', '..');

const BASE = ROOT;
const OUT = BASE + '\\session';
mkdirSync(OUT, { recursive: true });

// Firefox profile 根目录：跟随当前用户的 APPDATA，不写死用户名
const FF_ROOT = join(
  process.env.APPDATA || join(process.env.USERPROFILE || '', 'AppData', 'Roaming'),
  'Mozilla', 'Firefox', 'Profiles',
);

// 1) 找所有含智慧树 cookie 的 profile（把库复制出来读，避免锁库）
function findProfiles() {
  const out = [];
  if (!existsSync(FF_ROOT)) return out;
  for (const name of readdirSync(FF_ROOT)) {
    const dir = join(FF_ROOT, name);
    const db = join(dir, 'cookies.sqlite');
    if (existsSync(db)) out.push({ name, dir, db, mtime: statSync(db).mtime });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

const PY = PYTHON;

function readCookies(profile, tag) {
  // 复制 cookie 库（含 WAL）到临时目录，只读方式查询
  const tmpDir = join(BASE, 'recon', 'ffcookie-' + tag);
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  for (const f of ['cookies.sqlite', 'cookies.sqlite-wal', 'cookies.sqlite-shm']) {
    const src = join(profile.dir, f);
    if (existsSync(src)) {
      try { copyFileSync(src, join(tmpDir, f)); } catch {}
    }
  }
  const db = join(tmpDir, 'cookies.sqlite').replace(/\\/g, '/');
  const py = `
import sqlite3, json, sys
con = sqlite3.connect("file:${db}?mode=ro", uri=True)
con.row_factory = sqlite3.Row
rows = [dict(r) for r in con.execute(
    "SELECT host,name,value,path,expiry,isSecure,isHttpOnly FROM moz_cookies WHERE host LIKE '%zhihuishu%' OR host LIKE '%polymas%'"
).fetchall()]
print(json.dumps(rows, ensure_ascii=False))
`;
  const r = spawnSync(PY, ['-c', py], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (r.error) return { err: String(r.error).slice(0, 150) };
  if (r.status !== 0) return { err: (r.stderr || '').slice(0, 200) };
  try { return { cookies: JSON.parse(r.stdout) }; } catch (e) { return { err: '解析失败: ' + String(e).slice(0, 100) }; }
}

const KEY = /SESSION|JSESSIONID|CASTGC|jt-cas|token/i;

const profiles = findProfiles();
console.log(`发现 ${profiles.length} 个 Firefox profile\n`);

const report = [];
for (const [i, p] of profiles.entries()) {
  const tag = `p${i}`;
  const res = readCookies(p, tag);
  if (res.err) { console.log(`[${p.name}] 读取失败: ${res.err}`); continue; }

  const ck = res.cookies || [];
  const keys = ck.filter((c) => KEY.test(c.name));
  console.log(`[${p.name}]`);
  console.log(`  智慧树 cookie: ${ck.length} 条，关键票据 ${keys.length} 条`);
  if (keys.length) {
    for (const c of keys.slice(0, 12)) console.log(`    ${String(c.host).padEnd(40)} ${c.name}  len=${(c.value || '').length}`);
  }

  // 生成各域 Cookie 头
  const hosts = [...new Set(ck.map((c) => String(c.host).replace(/^\./, '')))];
  const headers = {};
  for (const h of hosts) {
    const parts = ck.filter((c) => {
      const d = String(c.host);
      if (d.startsWith('.')) return h === d.slice(1) || h.endsWith(d);
      return h === d;
    }).map((c) => `${c.name}=${c.value}`);
    if (parts.length) headers[h] = parts.join('; ');
  }

  report.push({ profile: p.name, cookieCount: ck.length, keyCount: keys.length, headers });
}

// 选关键票据最多的 profile 作为「Firefox 会话」
const best = report.sort((a, b) => b.keyCount - a.keyCount)[0];
console.log('\n================ 结论 ================');
if (best && best.keyCount > 0) {
  console.log(`  可用 Firefox 会话来自 profile: ${best.profile}`);
  console.log(`  智慧树 cookie ${best.cookieCount} 条，关键票据 ${best.keyCount} 条`);
  writeFileSync(OUT + '\\firefox-cookie-headers.json', JSON.stringify(best.headers, null, 2), 'utf8');
  console.log('  已保存 session/firefox-cookie-headers.json');
  console.log('\n  域覆盖:');
  for (const h of Object.keys(best.headers).sort()) console.log('    ' + h);
} else {
  console.log('  ⚠️ 所有 Firefox profile 都没有智慧树会话票据。');
  console.log('     请先在 Firefox 里登录智慧树，再重跑本脚本。');
}

writeFileSync(OUT + '\\firefox-profiles.json', JSON.stringify(report, null, 2), 'utf8');
console.log('\n已保存 session/firefox-profiles.json');
