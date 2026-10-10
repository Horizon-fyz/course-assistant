// 探测各域的数据/下载类接口能力
import { writeFileSync, mkdirSync } from 'node:fs';
import { connect, readyPage, tidy, HOME } from './browser.mjs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

const OUT = join(ROOT, 'recon', 'hosts');
mkdirSync(OUT, { recursive: true });

const { browser, ctx } = await connect();

// 在各域自己的页面里调用，规避跨域
const tasks = [
  {
    host: 'stuonline.zhihuishu.com',
    page: 'https://stuonline.zhihuishu.com/stuonline/folder/stuIndexV2?recruitId=435122&courseId=1000101708',
    calls: [
      ['课程资料-权限', 'GET', '/stuonline/json/folder/findRolePrivilege'],
      ['课程资料-列表', 'GET', '/stuonline/json/folder/findCourseFolder?recruitId=435122&courseId=1000101708&pageNo=1&pageSize=50'],
      ['成绩报告', 'GET', '/stuonline/json/report/findStuLearnReport?recruitId=435122&courseId=1000101708'],
    ],
  },
  {
    host: 'studyvideoh5.zhihuishu.com',
    page: 'https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=4e5b5c59475b4859454a585858445e4350',
    calls: [],
  },
  {
    host: 'onlineservice-api.zhihuishu.com',
    page: HOME,
    calls: [
      ['待提交考试', 'GET', '/gateway/t/v1/student/getStudentNoCommitExam'],
      ['重要通知', 'GET', '/gateway/t/v1/student/message/message/getImportantNoticeList'],
      ['系统消息', 'GET', '/gateway/t/v1/teacher/message/message/listStudentSystemMessage'],
      ['身份', 'GET', '/gateway/t/v1/teacher/index2/queryIdentity'],
      ['学校背景', 'GET', '/gateway/t/v1/student/home/index/background?secretStr=' + encodeURIComponent('AatOAojihIoMt3Lca3/nnsiNosg1vqAQCdptOEXIV/M=') + '&date=' + Date.now()],
    ],
  },
  {
    host: 'hike-examstu.zhihuishu.com',
    page: HOME,
    calls: [
      ['作业提醒', 'GET', '/zhsathome/homework/findImportantReminderList?uuid=demo-uuid'],
    ],
  },
  {
    host: 'school-platform.zhihuishu.com',
    page: HOME,
    calls: [
      ['校级平台', 'GET', '/school/isHasSchoolPlatform?schoolId=5371&uuid=demo-uuid'],
    ],
  },
];

const report = [];
for (const t of tasks) {
  const page = await readyPage(ctx, t.page);
  const rows = [];
  for (const [name, method, path] of t.calls) {
    const url = `https://${t.host}${path}`;
    const r = await page.evaluate(async ([u, m]) => {
      try {
        const res = await fetch(u, { method: m, credentials: 'include' });
        const txt = await res.text();
        return { status: res.status, len: txt.length, body: txt.slice(0, 700) };
      } catch (e) { return { error: String(e).slice(0, 150) }; }
    }, [url, method]);
    rows.push({ name, url, ...r });
    console.log(`\n[${t.host}] ${name}  status=${r.status ?? 'ERR'} len=${r.len ?? 0}`);
    if (r.error) console.log('   ERR', r.error);
    else console.log('   ' + (r.body || '').replace(/\s+/g, ' ').slice(0, 320));
  }
  report.push({ host: t.host, rows });
}

writeFileSync(OUT + '\\data-apis.json', JSON.stringify(report, null, 2));
console.log('\n已保存 recon/hosts/data-apis.json');

await tidy(ctx);
await browser.close().catch(() => {});
