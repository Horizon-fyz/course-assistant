// 汇总所有已知智慧树域名，作为全量巡检的输入
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

const BASE = ROOT;
const hosts = new Set();

// 1) 从侦察产物里的 URL 提取主机名
const RECON = join(BASE, 'recon');
function walk(dir, depth = 0) {
  if (depth > 3) return;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) { if (f !== 'js' && f !== 'ffcookie') walk(p, depth + 1); continue; }
    if (!/\.(json|txt|html|md)$/.test(f)) continue;
    if (st.size > 8 * 1024 * 1024) continue;
    let txt;
    try { txt = readFileSync(p, 'utf8'); } catch { continue; }
    for (const m of txt.matchAll(/https?:\/\/([a-z0-9][a-z0-9.-]*\.(?:zhihuishu|polymas|livecourse)\.com)/gi)) {
      hosts.add(m[1].toLowerCase());
    }
  }
}
walk(RECON);

// 2) 从会话 cookie 的域
try {
  const cookies = JSON.parse(readFileSync(join(BASE, 'session', 'cookies.json'), 'utf8'));
  for (const c of cookies) {
    const d = c.domain.replace(/^\./, '').toLowerCase();
    if (/zhihuishu|polymas/.test(d)) hosts.add(d);
  }
} catch {}

// 3) 补充已知子域（来自前端 bundle 的 host 清单）
const EXTRA = [
  'aiteachingtoolsh5.zhihuishu.com', 'aidedteachingdata.zhihuishu.com',
  'ai-course-assistant-api.zhihuishu.com', 'appcomm-user.zhihuishu.com',
  'assignmenth5.zhihuishu.com', 'b2cpush.zhihuishu.com', 'base1.zhihuishu.com',
  'base2.zhihuishu.com', 'buried-point.zhihuishu.com', 'coursehome.zhihuishu.com',
  'coursehome-server.zhihuishu.com', 'courseh5.zhihuishu.com', 'creditqa-api.zhihuishu.com',
  'doc.livecourse.com', 'exam.zhihuishu.com', 'fteaching.zhihuishu.com',
  'hike.zhihuishu.com', 'hike-examstu.zhihuishu.com', 'hike-teaching.zhihuishu.com',
  'hike-teaching-api.zhihuishu.com', 'hikeservice.zhihuishu.com',
  'image.zhihuishu.com', 'kgshare-api.zhihuishu.com', 'lc.zhihuishu.com',
  'login.zhihuishu.com', 'majorhome.zhihuishu.com', 'newexam.zhihuishu.com',
  'newexam-api.zhihuishu.com', 'newbase.zhihuishu.com', 'newcourse-api.zhihuishu.com',
  'online.zhihuishu.com', 'onlineexamh5new.zhihuishu.com', 'onlineh5.zhihuishu.com',
  'onlinemuster.zhihuishu.com', 'onlinescoremanage.zhihuishu.com',
  'onlineservice-api.zhihuishu.com', 'onlinestuh5.zhihuishu.com',
  'onlineweb.zhihuishu.com', 'oral.zhihuishu.com', 'passport.zhihuishu.com',
  'qah5.zhihuishu.com', 'report-server.zhihuishu.com', 'school-platform.zhihuishu.com',
  'smartcourse.zhihuishu.com', 'studentexam-api.zhihuishu.com',
  'studyservice-api.zhihuishu.com', 'studyvideoh5.zhihuishu.com',
  'stuonline.zhihuishu.com', 'studyplush5.zhihuishu.com', 'studyvocation.zhihuishu.com',
  'tchexamh5.zhihuishu.com', 'user.zhihuishu.com', 'wisdomh5.zhihuishu.com',
  'www.zhihuishu.com', 'zhihuishu-ai-live-api.zhihuishu.com',
  'cloudapi.polymas.com', 'coursehub.polymas.com', 'resources.polymas.com',
  'hike-teaching-center.polymas.com', 'aic-assessment.polymas.com',
];
for (const h of EXTRA) hosts.add(h);

const sorted = [...hosts].sort();
writeFileSync(join(BASE, 'recon', 'all-hosts.json'), JSON.stringify(sorted, null, 2));
console.log('域名总数:', sorted.length);
for (const h of sorted) console.log('  ' + h);
