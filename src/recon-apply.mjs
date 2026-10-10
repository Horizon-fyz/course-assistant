// P0 侦察：为「答案回填」和「视频弹题」摸清页面结构（只读，绝不点击保存/提交）
//
// 用法：
//   node src\recon-apply.mjs                 # 作业页 + 视频页静态结构
//   node src\recon-apply.mjs --exam          # 只侦察作业页
//   node src\recon-apply.mjs --video         # 只侦察视频页
//   node src\recon-apply.mjs --video --play 90   # 视频页额外播放 90 秒，采集弹题
//   node src\recon-apply.mjs --url <dohomework链接>   # 指定作业页
//
// 产出：recon\apply\exam-dom.json / video-dom.json + 截图
// 安全：本脚本不点击「保存」「下一题」「提交作业」，作业状态不会被改变。
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect, readyPage, tidy, HOME } from './browser.mjs';

const ROOT = join(import.meta.dirname, '..');
const EXPORT = join(ROOT, 'export');
const OUT = join(ROOT, 'recon', 'apply');
mkdirSync(OUT, { recursive: true });

const argv = process.argv.slice(2);
const getArg = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const wantExam = argv.includes('--exam') || (!argv.includes('--video') && !argv.includes('--exam'));
const wantVideo = argv.includes('--video') || !argv.includes('--exam');
const playSec = argv.includes('--play') ? Number(getArg('--play', '60')) || 60 : 0;
const urlOverride = getArg('--url');

const log = (m) => process.stdout.write(m + '\n');

// ---------- 读取本地数据，挑一个「题量最小」的作业做样本 ----------
function pickTarget() {
  const papers = join(EXPORT, 'papers.json');
  if (existsSync(papers)) {
    try {
      const data = JSON.parse(readFileSync(papers, 'utf8'));
      // recruitId 不在作业项里，需从 courses-resolved.json 按课程名补齐
      const resolved = existsSync(join(EXPORT, 'courses-resolved.json'))
        ? JSON.parse(readFileSync(join(EXPORT, 'courses-resolved.json'), 'utf8')) : {};
      const cands = [];
      for (const [course, items] of Object.entries(data)) {
        for (const it of items) {
          cands.push({ course, recruitId: resolved[course]?.recruitId, ...it });
        }
      }
      // 优先挑「有 recruitId 且题量最小」的，便于快速侦察
      cands.sort((a, b) => (Number(!a.recruitId) - Number(!b.recruitId)) || ((a.problemNum || 999) - (b.problemNum || 999)));
      const t = cands[0];
      if (t && t.recruitId) return { from: 'papers.json', ...t };
    } catch { /* 数据损坏则用兜底样本 */ }
  }
  // 兜底：实测过的最小样本（思想道德与法治 / 绪论单元测试，仅 1 题）
  return {
    from: 'fallback', course: '思想道德与法治', examName: '绪论单元测试',
    recruitId: 453708, courseId: 1000070264, schoolId: 5371,
    id: 'eglo6LgO', examId: 'wKEgOnL5', meetCourseType: 0,
  };
}

function examUrl(t) {
  return `https://onlineexamh5new.zhihuishu.com/stuExamWeb.html#/webExamList/dohomework/`
    + `${t.recruitId}/${t.id}/${t.examId}/${t.courseId}/${t.schoolId ?? 5371}/${t.meetCourseType ?? 0}`;
}

/** 读取 course secret（视频页用） */
function pickSecret() {
  const f = join(EXPORT, 'courses-resolved.json');
  if (existsSync(f)) {
    try {
      const c = JSON.parse(readFileSync(f, 'utf8'));
      for (const v of Object.values(c)) if (v.secret) return v.secret;
    } catch { /* 忽略 */ }
  }
  return '4e5b5c59475b4859454a585858445e4350'; // 大学生心理健康教育
}

// ---------- 页面内工具：给元素生成一个稳定选择器 ----------
const PAGE_HELPERS = `
  window.__css = function (el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.id) return '#' + el.id;
    const parts = [];
    let cur = el, depth = 0;
    while (cur && cur.nodeType === 1 && depth < 4) {
      let seg = cur.tagName.toLowerCase();
      const cls = (cur.className || '').toString().trim().split(/\\s+/).filter(Boolean).slice(0, 2);
      if (cls.length) seg += '.' + cls.join('.');
      const parent = cur.parentElement;
      if (parent) {
        const sibs = [...parent.children].filter((c) => c.tagName === cur.tagName);
        if (sibs.length > 1) seg += ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')';
      }
      parts.unshift(seg);
      cur = cur.parentElement;
      depth++;
    }
    return parts.join(' > ');
  };
  window.__clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
`;

// ================= 作业页侦察 =================
async function reconExam(ctx) {
  const t = pickTarget();
  const url = urlOverride || examUrl(t);
  log(`\n[作业页] 目标: ${t.course} / ${t.examName}（来源 ${t.from}）`);
  log(`         URL: ${url}`);

  // 用全新标签页打开，避免复用旧页面导致整页刷新、时序混乱
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});

  // 题干是异步渲染的：先等题号锚点出现（说明 Vue 已挂载），再等题干正文
  const t0 = Date.now();
  for (let i = 0; i < 40; i++) {
    const ready = await page.evaluate(() =>
      document.querySelectorAll('.subject_num span[id^=anchor_]').length > 0).catch(() => false);
    if (ready) break;
    await page.waitForTimeout(1500);
  }
  for (let i = 0; i < 60; i++) {
    const len = await page.evaluate(() => {
      const ds = [...document.querySelectorAll('.subject_describe')];
      return ds.reduce((a, d) => a + (d.innerText || '').trim().length, 0);
    }).catch(() => 0);
    if (len > 2) break;
    await page.waitForTimeout(1500);
  }
  log(`        等待题干渲染: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // 调试：打印第一道题题干区域的所有子元素 + innerText/textContent 对比
  const stemDebug = await page.evaluate(() => {
    const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const desc = document.querySelector('.subject_describe');
    if (!desc) return null;
    return {
      describeInner: clean(desc.innerText).slice(0, 200),
      describeText: clean(desc.textContent).slice(0, 200),
      children: [...desc.querySelectorAll('*')].slice(0, 15).map((c) => ({
        tag: c.tagName, cls: (c.className || '').toString(),
        inner: clean(c.innerText).slice(0, 100),
        text: clean(c.textContent).slice(0, 100),
        display: getComputedStyle(c).display,
      })),
    };
  }).catch(() => null);
  log(`        题干调试: ${JSON.stringify(stemDebug, null, 1).slice(0, 1200)}`);

  await page.addScriptTag({ content: PAGE_HELPERS }).catch(() => {});

  const dom = await page.evaluate(() => {
    const clean = window.__clean || ((s) => String(s || '').replace(/\s+/g, ' ').trim());
    const css = window.__css || (() => null);

    // 1) 找题目容器：以「含 radio/checkbox 且文本较长」的区块为准
    const inputs = [...document.querySelectorAll('input[type=radio], input[type=checkbox]')];
    const containers = new Set();
    for (const inp of inputs) {
      let p = inp, depth = 0;
      // 向上找到含 ≥2 个 input 或含较长文本的祖先
      while (p && depth < 6) {
        p = p.parentElement;
        if (!p) break;
        const n = p.querySelectorAll('input[type=radio], input[type=checkbox]').length;
        const txt = clean(p.innerText || '');
        if (n >= 2 || txt.length > 40) { containers.add(p); break; }
        depth++;
      }
    }

    const questions = [...containers].slice(0, 3).map((c) => {
      const rows = [];
      for (const inp of c.querySelectorAll('input[type=radio], input[type=checkbox]')) {
        // 选项文本：优先 label，其次最近的文本祖先
        let textEl = inp.closest('label');
        if (!textEl) {
          let p = inp.parentElement, d = 0;
          while (p && d < 4 && clean(p.innerText).length < 2) { p = p.parentElement; d++; }
          textEl = p;
        }
        rows.push({
          inputType: inp.type,
          inputName: inp.name || null,
          inputValue: inp.value || null,
          checked: inp.checked,
          disabled: inp.disabled,
          inputSelector: css(inp),
          dataAttrs: [...inp.attributes].filter((a) => a.name.startsWith('data-')).map((a) => `${a.name}=${a.value}`),
          optionText: clean(textEl ? textEl.innerText : ''),
          optionSelector: css(textEl),
        });
      }
      return {
        containerSelector: css(c),
        containerClass: (c.className || '').toString(),
        questionText: clean(c.innerText).slice(0, 400),
        outerHtmlHead: c.outerHTML.replace(/\s+/g, ' ').slice(0, 1400),
        rows,
      };
    });

    // 2) 类名频率：找出与题目/选项/保存/提交相关的 class
    const freq = {};
    const kw = /quest|topic|subject|stem|answer|option|choice|radio|check|save|next|prev|submit|btn|paper|exam|dialog|modal|confirm/i;
    for (const el of document.querySelectorAll('*')) {
      for (const c of (el.className || '').toString().split(/\s+/)) {
        if (c && kw.test(c)) freq[c] = (freq[c] || 0) + 1;
      }
    }

    // 3) 按钮：保存 / 下一题 / 上一题 / 提交 / 暂存
    const buttonRe = /保存|下一题|上一题|提交|暂存|确定|确认/;
    const buttons = [...document.querySelectorAll('button, a, [class*=btn], [class*=Btn], div[role=button]')]
      .map((b) => ({
        text: clean(b.innerText).slice(0, 20),
        tag: b.tagName,
        cls: (b.className || '').toString().slice(0, 80),
        selector: css(b),
        disabled: b.disabled === true || /disabled/i.test((b.className || '').toString()),
      }))
      .filter((b) => b.text && buttonRe.test(b.text))
      .slice(0, 20);

    return {
      title: document.title,
      url: location.href,
      bodyText: clean(document.body.innerText).slice(0, 1200),
      inputCount: inputs.length,
      questionCount: containers.size,
      questions,
      buttonCandidates: buttons,
      classFrequency: Object.fromEntries(Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 40)),
      // 深探：第一道题的完整层级结构 + 题干定位
      deep: (() => {
        const q = document.querySelector('div.subject_node');
        if (!q) return null;
        const wrap = document.querySelector('.examPaper_subject');
        const imgs = wrap ? [...wrap.querySelectorAll('img')].map((im) => ({ cls: (im.className || '').toString(), src: (im.src || '').slice(0, 160), w: Math.round(im.getBoundingClientRect().width), h: Math.round(im.getBoundingClientRect().height), display: getComputedStyle(im).display })) : [];
        const kids = [...q.children].map((c) => ({
          tag: c.tagName, cls: (c.className || '').toString(),
          selector: css(c), text: clean(c.innerText).slice(0, 160),
        }));
        // 题干：在 subject_node 内找含「题型标记 / 题号 / 长文本但不含选项字母」的节点
        const stemCand = [...q.querySelectorAll('*')]
          .map((el) => ({ el, t: clean(el.innerText) }))
          .filter((x) => x.t && /【|（\s*）|\(\)|°|单选题|多选题|判断题|填空题/.test(x.t) && x.t.length > 6)
          .slice(0, 6)
          .map((x) => ({ selector: css(x.el), cls: (x.el.className || '').toString(), text: x.t.slice(0, 200) }));
        // 选项行：nodeLab 结构
        const optionRows = [...q.querySelectorAll('.nodeLab')].map((lab) => {
          const inp = lab.querySelector('input');
          const detail = lab.querySelector('.node_detail, .examquestions-answer');
          const letter = lab.querySelector('span');
          return {
            nodeLabSelector: css(lab),
            letter: clean(letter ? letter.innerText : ''),
            optionId: inp ? inp.value : null,
            inputType: inp ? inp.type : null,
            inputHidden: inp ? getComputedStyle(inp).display === 'none' : null,
            text: clean(detail ? detail.innerText : lab.innerText),
            clickableSelector: css(lab.querySelector('.label') || lab),
          };
        });
        return {
          subjectNodeSelector: css(q),
          children: kids,
          stemCandidates: stemCand,
          optionRows,
          imgs,
          // 题号 span 的 id 形如 anchor_<eid 去掉非字母数字>，可反推题目 eid
          anchorIds: [...document.querySelectorAll('.subject_num span[id^=anchor_]')].slice(0, 5).map((s) => s.id),
          // 头部题型/题号区（通常是 subject_node 的第一个子块）
          headText: clean((q.children[0]?.innerText) || '').slice(0, 200),
          // 题干锚点：靠类名 subject_stem 找，再回溯祖先链确认层级
          stemAnchor: (() => {
            const stem = document.querySelector('.subject_stem');
            if (!stem) return null;
            const chain = [];
            let p = stem.parentElement, d = 0;
            while (p && d < 4) {
              chain.push({
                tag: p.tagName, cls: (p.className || '').toString(), selector: css(p),
                kids: [...p.children].map((c) => `${c.tagName}.${(c.className || '').toString().split(/\s+/)[0] || ''}`),
              });
              p = p.parentElement; d++;
            }
            // 题干正文元素（可能是 .subject_describe，也可能为空/隐藏）
            const desc = document.querySelector('.subject_describe');
            return {
              selector: css(stem), text: clean(stem.innerText).slice(0, 200), ancestors: chain,
              describe: desc ? {
                selector: css(desc), inner: clean(desc.innerText).slice(0, 200),
                textContent: clean(desc.textContent).slice(0, 200),
                display: getComputedStyle(desc).display, size: `${Math.round(desc.getBoundingClientRect().width)}x${Math.round(desc.getBoundingClientRect().height)}`,
              } : null,
              stemHtml: stem.outerHTML.replace(/\s+/g, ' ').slice(0, 800),
            };
          })(),
        };
      })(),
    };
  }).catch((e) => ({ error: String(e).slice(0, 300) }));

  log(`        题干预选: ${dom.questionCount ?? '?'} 题, 输入框 ${dom.inputCount ?? '?'} 个`);
  if (dom.questions?.[0]) {
    log(`        首题题干: ${String(dom.questions[0].questionText).slice(0, 80)}`);
    log(`        首题选项数: ${dom.questions[0].rows.length}`);
    for (const r of dom.questions[0].rows.slice(0, 4)) {
      log(`          · [${r.inputType}] "${String(r.optionText).slice(0, 40)}"  sel=${r.inputSelector}`);
    }
  }
  log(`        候选按钮: ${JSON.stringify((dom.buttonCandidates || []).map((b) => b.text))}`);
  if (dom.deep) {
    log(`        subject_node: ${dom.deep.subjectNodeSelector}`);
    log(`        头部: ${dom.deep.headText}`);
    log(`        题干候选: ${JSON.stringify((dom.deep.stemCandidates || []).map((x) => ({ s: x.selector, t: x.text.slice(0, 60) })))}`);
    log(`        题号锚点 id: ${JSON.stringify(dom.deep.anchorIds || [])}`);
    log(`        题内图片: ${JSON.stringify((dom.deep.imgs || []).slice(0, 5))}`);
    if (dom.deep.stemAnchor) {
      log(`        .subject_stem: "${dom.deep.stemAnchor.text.slice(0, 60)}" sel=${dom.deep.stemAnchor.selector}`);
      if (dom.deep.stemAnchor.describe) {
        const d = dom.deep.stemAnchor.describe;
        log(`        .subject_describe: inner="${d.inner.slice(0, 60)}" textContent="${d.textContent.slice(0, 60)}" display=${d.display} size=${d.size}`);
      } else {
        log('        .subject_describe: (不存在)');
      }
      log(`        subject_stem HTML: ${dom.deep.stemAnchor.stemHtml.slice(0, 400)}`);
      for (const a of dom.deep.stemAnchor.ancestors) log(`           ^ ${a.tag}.${a.cls.split(/\s+/)[0]}  kids=[${a.kids.join(', ')}]`);
    }
    for (const r of (dom.deep.optionRows || []).slice(0, 4)) {
      log(`          · ${r.letter} id=${r.optionId} type=${r.inputType} hidden=${r.inputHidden} "${String(r.text).slice(0, 30)}"`);
    }
  }

  // 可选：在页面里搜一段文本，定位它所在的元素（用于确认题干藏在哪、是否被隐藏）
  const findText = getArg('--find');
  if (findText) {
    const hits = await page.evaluate((needle) => {
      const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
      const css = window.__css || (() => null);
      const out = [];
      for (const el of document.querySelectorAll('*')) {
        const tc = el.textContent || '';
        if (!tc.includes(needle)) continue;
        // 只保留最深的命中：子元素里若已包含该文本则跳过
        if ([...el.children].some((c) => (c.textContent || '').includes(needle))) continue;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        out.push({
          tag: el.tagName, cls: (el.className || '').toString().slice(0, 90), selector: css(el),
          display: cs.display, visibility: cs.visibility, w: Math.round(r.width), h: Math.round(r.height),
          inner: clean(el.innerText).slice(0, 120), text: clean(tc).slice(0, 120),
        });
      }
      return out.slice(0, 20);
    }, findText).catch(() => []);
    log(`        [--find "${findText}"] 命中 ${hits.length} 个最深元素：`);
    for (const h of hits) log(`          · ${h.tag}.${h.cls.split(/\s+/)[0]} display=${h.display} size=${h.w}x${h.h} inner="${h.inner}" text="${h.text}"`);
  }

  await page.screenshot({ path: join(OUT, 'exam-page.png'), fullPage: false }).catch(() => {});
  writeFileSync(join(OUT, 'exam-dom.json'), JSON.stringify({ target: t, url, dom }, null, 2), 'utf8');
  log(`        已保存 recon\\apply\\exam-dom.json`);
  return page;
}

// ================= 视频页侦察 =================
async function reconVideo(ctx) {
  const secret = pickSecret();
  const url = `https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=${secret}`;
  log(`\n[视频页] URL: ${url}`);

  const page = await readyPage(ctx, url);

  // 记录网络请求，便于反推弹题接口（必须在导航前挂上，否则漏掉首屏请求）
  const api = [];
  page.on('request', (r) => {
    const u = r.url();
    if (!/studyservice-api|studyvideoh5|zhihuishu\.com/.test(u)) return;
    if (/\.(js|css|png|jpe?g|gif|woff2?|ico|svg|mp4|m3u8|ts)(\?|$)/i.test(u)) return;
    api.push({ method: r.method(), url: u.slice(0, 200), post: (r.postData() || '').slice(0, 400) });
  });
  page.on('response', async (r) => {
    const u = r.url();
    if (!/studyservice-api|taurus|studentexam-api/.test(u)) return;
    const rec = api.find((c) => u.startsWith(c.url) && !c.status);
    if (!rec) return;
    rec.status = r.status();
    if (/json/.test(r.headers()['content-type'] || '')) {
      try { rec.body = (await r.text()).slice(0, 1500); } catch { /* 忽略 */ }
    }
  });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(9000);

  // 关「学前必读」（可能不出现）
  try {
    await page.locator('.dialog-read .iconguanbi').first().click({ timeout: 6000 });
    await page.waitForTimeout(2500);
  } catch { /* 无弹窗 */ }

  // 安装 DOM 变更记录（为弹题发现做准备）
  await page.evaluate(() => {
    window.__added = [];
    const seen = (n) => ({
      tag: n.tagName, cls: (n.className || '').toString(), text: (n.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300),
    });
    const ob = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n.nodeType === 1) {
            const r = n.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) window.__added.push(seen(n));
          }
        }
      }
      if (window.__added.length > 400) window.__added.splice(0, window.__added.length - 400);
    });
    ob.observe(document.body, { childList: true, subtree: true });
  }).catch(() => {});

  const staticDom = await page.evaluate(() => {
    const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const css = (el) => {
      const parts = []; let cur = el, d = 0;
      while (cur && cur.nodeType === 1 && d < 4) {
        let seg = cur.tagName.toLowerCase();
        const cls = (cur.className || '').toString().trim().split(/\s+/).filter(Boolean).slice(0, 2);
        if (cls.length) seg += '.' + cls.join('.');
        parts.unshift(seg); cur = cur.parentElement; d++;
      }
      return parts.join(' > ');
    };

    // 小节/视频列表
    const lessons = [...document.querySelectorAll('[class*=lesson], [class*=video], [class*=chapter], li, [class*=item]')]
      .map((el) => ({ cls: (el.className || '').toString().slice(0, 80), text: clean(el.innerText).slice(0, 60), selector: css(el) }))
      .filter((x) => x.text && /第|章|节|讲|视频|分钟|未完成|已完成|学习中/.test(x.text))
      .slice(0, 30);

    const videos = [...document.querySelectorAll('video')].map((v) => ({
      selector: css(v), src: (v.currentSrc || v.src || '').slice(0, 160),
      duration: v.duration, currentTime: v.currentTime, paused: v.paused, playbackRate: v.playbackRate,
    }));

    // 弹题候选：类名含 question/topic/quiz/pop/dialog 的可见元素
    const kw = /quest|topic|quiz|pop|dialog|modal|answer|test|exam|tip/i;
    const popup = [];
    for (const el of document.querySelectorAll('*')) {
      const cls = (el.className || '').toString();
      if (!cls || !kw.test(cls)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 40 || r.height < 20) continue;
      popup.push({ cls: cls.slice(0, 100), selector: css(el), text: clean(el.innerText).slice(0, 200) });
      if (popup.length >= 25) break;
    }

    return {
      title: document.title, url: location.href,
      bodyText: clean(document.body.innerText).slice(0, 1500),
      lessonCandidates: lessons, videos, popupCandidates: popup,
      hasVideoTag: videos.length,
    };
  }).catch((e) => ({ error: String(e).slice(0, 300) }));

  log(`        title: ${staticDom.title}`);
  log(`        <video> 标签数: ${staticDom.hasVideoTag}`);
  log(`        课程/小节候选: ${staticDom.lessonCandidates?.length ?? 0}`);
  log(`        弹题候选元素: ${staticDom.popupCandidates?.length ?? 0}`);

  // 可选：播放一段时间，采集弹题
  let played = null;
  let topicSnapshot = null;
  if (playSec > 0) {
    log(`        播放 ${playSec}s，采集动态弹题…`);
    // 从列表里挑一节没看完的课（优先靠后章节，避免选到已看完的）
    try {
      const lessons = page.locator('li.video');
      const n = await lessons.count();
      let picked = null;
      for (let i = n - 1; i >= 0; i--) {
        const it = lessons.nth(i);
        const txt = (await it.innerText().catch(() => '')) || '';
        // 已完成的通常带「已完成」标记；优先挑没有该标记的
        if (!/已完成/.test(txt)) { picked = it; break; }
      }
      if (!picked && n) picked = lessons.nth(Math.max(0, n - 1));
      if (picked) {
        log(`        选中课节: ${(await picked.innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 60)}`);
        await picked.click({ timeout: 8000 });
        await page.waitForTimeout(5000);
      }
    } catch (e) { log('        选课节失败: ' + String(e).slice(0, 80)); }

    const before = await page.evaluate(() => (window.__added || []).length).catch(() => 0);

    // 弹题时间点标记：.video-topic li 的 left 百分比就是弹题位置
    const markers = await page.evaluate(() => {
      const v = document.querySelector('video');
      return [...document.querySelectorAll('.video-topic li')].map((li) => ({
        left: parseFloat(li.style.left) || null,
        top: li.style.top || null,
        dur: v ? v.duration : null,
      }));
    }).catch(() => []);
    if (markers.length) {
      log(`        弹题时间点标记 ${markers.length} 个: ${markers.map((m) => m.left + '%').join(', ')}`);
      // 跳到第一个标记前 6 秒，让弹题自然触发
      const first = markers.map((m) => m.left).filter((x) => x).sort((a, b) => a - b)[0];
      if (first) {
        await page.evaluate((pct) => {
          const v = document.querySelector('video');
          if (v && v.duration) { v.currentTime = Math.max(0, v.duration * pct / 100 - 6); v.muted = true; v.play().catch(() => {}); }
        }, first).catch(() => {});
        log(`        已跳到 ${first}% 位置前 6s 并播放`);
      }
    } else {
      await page.evaluate(() => {
        const v = document.querySelector('video');
        if (v) { v.muted = true; v.play().catch(() => {}); }
      }).catch(() => {});
    }
    await page.waitForTimeout(playSec * 1000);

    played = await page.evaluate((n0) => {
      const added = (window.__added || []).slice(n0);
      const kw = /quest|topic|quiz|pop|dialog|modal|answer|test|tip|随堂|弹题/i;
      const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
      const tp = document.querySelector('.video-topic');
      // 当前可见的弹题候选（类名含关键词、尺寸够大）
      const popupNow = [];
      for (const el of document.querySelectorAll('*')) {
        const cls = (el.className || '').toString();
        if (!cls || !kw.test(cls)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 120 || r.height < 60) continue;
        const t = clean(el.innerText);
        if (!t) continue;
        popupNow.push({
          cls: cls.slice(0, 100),
          text: t.slice(0, 600),
          html: el.outerHTML.replace(/\s+/g, ' ').slice(0, 3000),
          radios: el.querySelectorAll('input[type=radio], input[type=checkbox]').length,
        });
        if (popupNow.length >= 6) break;
      }
      return {
        addedTotal: added.length,
        popupAdded: added.filter((a) => kw.test(a.cls || '')).slice(0, 40),
        popupNow,
        videoTopic: tp ? { html: tp.outerHTML.replace(/\s+/g, ' ').slice(0, 2500), text: clean(tp.innerText).slice(0, 600), visible: tp.getBoundingClientRect().height > 0 } : null,
        videoState: (() => { const v = document.querySelector('video'); return v ? { currentTime: v.currentTime, paused: v.paused, duration: v.duration } : null; })(),
      };
    }, before).catch(() => null);
    if (played) {
      log(`        动态新增弹题候选: ${played.popupAdded?.length ?? 0} / 新增节点 ${played.addedTotal}`);
      log(`        当前可见弹题候选: ${played.popupNow?.length ?? 0}`);
      for (const p of (played.popupNow || []).slice(0, 3)) {
        log(`          · .${p.cls.split(/\s+/)[0]} radios=${p.radios} "${p.text.slice(0, 100)}"`);
      }
      if (played.videoTopic) log(`        .video-topic 文本: ${String(played.videoTopic.text).slice(0, 120) || '(空)'}`);
      topicSnapshot = played.videoTopic;
    }
  }

  await page.screenshot({ path: join(OUT, 'video-page.png'), fullPage: false }).catch(() => {});
  writeFileSync(join(OUT, 'video-dom.json'), JSON.stringify({ url, staticDom, played, topicSnapshot, api }, null, 2), 'utf8');
  log(`        已保存 recon\\apply\\video-dom.json`);
  return page;
}

// ================= 主流程 =================
log('══════════ 作答/视频侦察（只读） ══════════');
log(`范围: ${[wantExam && '作业页', wantVideo && '视频页'].filter(Boolean).join(' + ')}${playSec ? `（视频播放 ${playSec}s）` : ''}`);

const { ctx, describe, close } = await connect({
  prefer: getArg('--browser', 'chromium') === 'firefox' ? 'firefox' : 'chromium',
  exe: getArg('--browser-exe'),
  firefoxProfile: getArg('--firefox-profile'),
});

log('浏览器: ' + describe);
try {
  if (wantExam) await reconExam(ctx);
  if (wantVideo) await reconVideo(ctx);
} catch (e) {
  log('侦察出错: ' + String(e).slice(0, 300));
}
await tidy(ctx).catch(() => {});
await close();
log('\n完成。产物在 recon\\apply\\');
