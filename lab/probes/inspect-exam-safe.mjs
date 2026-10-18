// 安全侦察：只读「开始答题」按钮绑定的路由/参数，不进入试卷
import { writeFileSync, mkdirSync } from 'node:fs';
import { connect, readyPage, tidy } from '../../src/core/browser.mjs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');

const OUT = join(ROOT, 'recon', 'exam');
mkdirSync(OUT, { recursive: true });

const { browser, ctx } = await connect();
const page = ctx.pages().find((p) => p.url().includes('onlineexamh5new')) ?? (await ctx.newPage());

// 记录所有请求，但不主动触发进入试卷
const api = [];
page.on('request', (r) => {
  const u = r.url();
  if (!/studentexam-api|taurusexam-api/.test(u)) return;
  if (/\.(js|css|png|jpg|gif|woff2?|ico)(\?|$)/.test(u)) return;
  api.push({ method: r.method(), url: u.slice(0, 170), post: (r.postData() || '').slice(0, 500) });
});
page.on('response', async (r) => {
  const u = r.url();
  if (!/studentexam-api|taurusexam-api/.test(u)) return;
  const rec = api.find((c) => u.startsWith(c.url) && !c.status);
  if (!rec) return;
  rec.status = r.status();
  const ct = r.headers()['content-type'] || '';
  if (/json/.test(ct)) { try { rec.body = (await r.text()).slice(0, 1200); } catch {} }
});

await page.goto('https://onlineexamh5new.zhihuishu.com/stuExamWeb.html#/webExamList?recruitId=IbhuH%2F%2Bb5MbiAG29T6RoXA%3D%3D', { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
await page.waitForTimeout(9000);

// 1) 读取 Vue 实例里的作业数据与路由配置
const inspect = await page.evaluate(() => {
  const out = { vueFound: false, routes: [], homeworkData: null, startBtnAttrs: null };

  // 找 Vue 根实例
  const el = document.querySelector('#app') || document.body;
  const vm = el && el.__vue__;
  if (vm) {
    out.vueFound = true;
    try {
      // 路由表
      const router = vm.$router;
      if (router && router.options && router.options.routes) {
        out.routes = router.options.routes.map((r) => ({ path: r.path, name: r.name, component: String(r.component && (r.component.name || '')).slice(0, 40) }));
      }
      // 当前路由
      out.currentRoute = vm.$route ? { path: vm.$route.path, query: vm.$route.query, fullPath: vm.$route.fullPath } : null;
      // 作业列表数据
      const d = vm.$data || {};
      out.dataKeys = Object.keys(d).slice(0, 40);
      for (const k of Object.keys(d)) {
        const v = d[k];
        if (Array.isArray(v) && v.length && v[0] && (v[0].examName || v[0].examId)) {
          out.homeworkData = { key: k, count: v.length, sample: v.slice(0, 2) };
          break;
        }
      }
    } catch (e) { out.vueErr = String(e).slice(0, 200); }
  }

  // 开始答题按钮上的属性与最近的可点击祖先
  const btns = [...document.querySelectorAll('*')].filter((n) => (n.innerText || '').trim() === '开始答题' && n.children.length === 0);
  out.startBtnAttrs = btns.slice(0, 3).map((b) => {
    const chain = [];
    let p = b;
    for (let i = 0; i < 4 && p; i++) {
      chain.push({
        tag: p.tagName, cls: (p.className || '').toString().slice(0, 60),
        attrs: [...(p.attributes || [])].map((a) => `${a.name}=${String(a.value).slice(0, 60)}`).slice(0, 8),
      });
      p = p.parentElement;
    }
    return chain;
  });
  return out;
});

console.log('=== 页面内省 ===');
console.log(JSON.stringify(inspect, null, 1).slice(0, 4000));

// 2) 看列表数据里每项的作答次数/状态字段
console.log('\n=== 作业项的作答相关字段 ===');
const hw = await page.evaluate(() => {
  const el = document.querySelector('#app') || document.body;
  const vm = el && el.__vue__;
  if (!vm) return null;
  const d = vm.$data || {};
  for (const k of Object.keys(d)) {
    const v = d[k];
    if (Array.isArray(v) && v.length && v[0] && (v[0].examName || v[0].examId)) {
      return { key: k, items: v.map((x) => ({
        examName: x.examName, examId: x.examId, id: x.id, state: x.state,
        backNum: x.backNum, achieve: x.achieve, score: x.score,
        problemNum: x.problemNum, totalScore: x.totalScore, endDate: x.endDate,
        isCheckAnswer: x.isCheckAnswer, reviewType: x.reviewType,
      })) };
    }
  }
  return null;
});
if (hw) {
  console.log('数据键:', hw.key);
  for (const it of hw.items.slice(0, 4)) console.log('  ' + JSON.stringify(it));
} else console.log('  未取到');

writeFileSync(OUT + '\\exam-inspect.json', JSON.stringify({ inspect, hw, api }, null, 2));
console.log('\n已保存 recon/exam/exam-inspect.json');
console.log('\n（本次未点击「开始答题」，未消耗任何作答次数）');

try { await tidy(ctx); } catch {}
await browser.close().catch(() => {});
