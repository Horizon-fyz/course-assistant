// 逐域验证真实业务路径（带完整会话 Cookie，Node 直连）
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

const BASE = ROOT;
const OUT = BASE + '\\recon\\hosts';
mkdirSync(OUT, { recursive: true });
const H = JSON.parse(readFileSync(BASE + '\\session\\cookie-headers.json', 'utf8'));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0';

async function hit(host, path, { method = 'GET', referer, ctype, body } = {}) {
  const url = `https://${host}${path}`;
  try {
    const headers = { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' };
    if (H[host]) headers.Cookie = H[host];
    if (referer) headers.Referer = referer;
    if (ctype) headers['Content-Type'] = ctype;
    const res = await fetch(url, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(20000) });
    let text = '';
    try { text = await res.text(); } catch {}
    return {
      ok: true, status: res.status, url,
      ct: (res.headers.get('content-type') || '').split(';')[0],
      len: text.length,
      location: res.headers.get('location') || '',
      body: text.slice(0, 600),
    };
  } catch (e) {
    return { ok: false, url, error: (e.cause?.code || e.name) + '' };
  }
}

const TESTS = [
  // —— 成绩 / 资料（服务端渲染 + JSON 接口）——
  ['stuonline.zhihuishu.com', '/stuonline/folder/stuIndexV2?recruitId=435122&courseId=1000101708', {}],
  ['stuonline.zhihuishu.com', '/stuonline/json/folder/findRolePrivilege', { referer: 'https://stuonline.zhihuishu.com/stuonline/folder/stuIndexV2?recruitId=435122&courseId=1000101708' }],
  ['stuonline.zhihuishu.com', '/stuonline/json/folder/findCourseFolder', { method: 'POST', ctype: 'application/x-www-form-urlencoded', body: 'recruitId=435122&courseId=1000101708&pageNo=1&pageSize=50', referer: 'https://stuonline.zhihuishu.com/stuonline/folder/stuIndexV2?recruitId=435122&courseId=1000101708' }],
  ['stuonline.zhihuishu.com', '/stuonline/stuLearnReportNew/index?recruitId=435122&courseId=1000101708', {}],
  ['stuonline.zhihuishu.com', '/stuonline/teachMeeting/stuListV2?recruitId=435122', {}],
  // —— 作业考试 ——
  ['onlineexamh5new.zhihuishu.com', '/stuExamWeb.html', {}],
  ['studentexam-api.zhihuishu.com', '/studentExam/gateway/t/v1/app/queryIsLimitFlow', {}],
  // —— 问答 ——
  ['qah5.zhihuishu.com', '/qa.html', {}],
  ['creditqa-api.zhihuishu.com', '/creditqa/gateway/f/v1/web/login/getLoginUserInfo', {}],
  // —— 视频 ——
  ['studyvideoh5.zhihuishu.com', '/stuStudy?recruitAndCourseId=4e5b5c59475b4859454a585858445e4350', {}],
  ['studyservice-api.zhihuishu.com', '/gateway/t/v1/login/getLoginUserInfo', {}],
  // —— 我的学堂 / 在线学堂 ——
  ['onlinemuster.zhihuishu.com', '/shareTeachIndex', {}],
  ['onlineweb.zhihuishu.com', '/onlinestuh5', {}],
  ['onlinestuh5.zhihuishu.com', '/', {}],
  // —— 用户 / 身份 ——
  ['user.zhihuishu.com', '/zhsuser/login/isLogin', {}],
  ['appcomm-user.zhihuishu.com', '/app-commserv-user/userInfo/getUserInfoAndAuthInfo?uuid=demo-uuid', {}],
  ['hike.zhihuishu.com', '/aidedteaching/schoolHelp/getSchoolHelpDataByUserId?uuid=demo-uuid', {}],
  ['hikeservice.zhihuishu.com', '/school/home/vip/getSchoolMemberAuthority?schoolId=5371&uuid=demo-uuid', {}],
  ['hike-examstu.zhihuishu.com', '/zhsathome/homework/findImportantReminderList?uuid=demo-uuid', {}],
  ['school-platform.zhihuishu.com', '/school/isHasSchoolPlatform?schoolId=5371&uuid=demo-uuid', {}],
  ['b2cpush.zhihuishu.com', '/b2cpush/courseDetail/query2CCourseList', { method: 'POST', ctype: 'application/json', body: '{}' }],
  // —— 其他内容站 ——
  ['smartcourse.zhihuishu.com', '/', {}],
  ['wisdomh5.zhihuishu.com', '/', {}],
  ['studyplush5.zhihuishu.com', '/', {}],
  ['studyvocation.zhihuishu.com', '/', {}],
  ['oral.zhihuishu.com', '/', {}],
  ['fteaching.zhihuishu.com', '/', {}],
  ['coursehome.zhihuishu.com', '/courseHome/', {}],
  ['courseh5.zhihuishu.com', '/cc.html', {}],
  ['coursehomeh5.zhihuishu.com', '/', {}],
  ['majorhome.zhihuishu.com', '/common/181', {}],
  ['lc.zhihuishu.com', '/', {}],
  ['aiteachingtoolsh5.zhihuishu.com', '/', {}],
  ['newbase.zhihuishu.com', '/video/getClientIp2', {}],
  ['report-server.zhihuishu.com', '/report/json/getReportUrlByRid', {}],
  ['onlinescoremanage.zhihuishu.com', '/onlineScoreManage/index2?recruitId=435122', {}],
  ['tchexamh5.zhihuishu.com', '/courseData.html', {}],
  ['newexam.zhihuishu.com', '/teacherExam/examNew/noConsultList?recruitId=435122', {}],
  ['online.zhihuishu.com', '/onlineSchool/notice/listLearnProgress4?paramId=1', {}],
  ['onlineh5.zhihuishu.com', '/onlineWeb.html', {}],
  ['message.zhihuishu.com', '/', {}],
  ['taurusexam-api.zhihuishu.com', '/', {}],
  ['image.zhihuishu.com', '/', {}],
  ['alivideo.zhihuishu.com', '/', {}],
  ['doc.livecourse.com', '/', {}],
  ['polymas.com', '/', {}],
  ['cloudapi.polymas.com', '/oauth/login/checkLogin', {}],
  ['resources.polymas.com', '/', {}],
  ['coursehub.polymas.com', '/', {}],
  ['aic-assessment.polymas.com', '/', {}],
  ['hike-teaching-center.polymas.com', '/', {}],
  ['assets.zhihuishu.com', '/', {}],
  ['base1.zhihuishu.com', '/', {}],
  ['base2.zhihuishu.com', '/', {}],
  ['file.zhihuishu.com', '/', {}],
  ['exam.zhihuishu.com', '/', {}],
  ['aidedteachingdata.zhihuishu.com', '/', {}],
  ['ai-course-assistant-api.zhihuishu.com', '/', {}],
  ['kgshare-api.zhihuishu.com', '/', {}],
  ['newcourse-api.zhihuishu.com', '/newcourse/gateway/f/v1/login/getLoginUserInfo', {}],
  ['newexam-api.zhihuishu.com', '/teacherExam/gateway/f/v1/ulogin/getLoginUserInfo', {}],
  ['zhihuishu-ai-live-api.zhihuishu.com', '/live/gateway/t/v1/stuApi/studentCourse/getLivingList', {}],
];

const out = [];
for (const [host, path, opts] of TESTS) {
  const r = await hit(host, path, opts);
  out.push({ host, path, method: opts.method || 'GET', ...r });
  const mark = r.ok ? String(r.status) : 'ERR';
  const flag = r.ok && r.status === 200 ? '✓' : (r.ok ? ' ' : '✗');
  console.log(`${flag} ${mark.padStart(4)} ${host.padEnd(36)} ${path.slice(0, 52).padEnd(54)} ${r.ok ? `len=${r.len} ${r.ct}` : r.error}`);
  if (r.ok && r.status >= 300 && r.status < 400) console.log(`        → ${r.location.slice(0, 100)}`);
}

writeFileSync(OUT + '\\business-paths.json', JSON.stringify(out, null, 2));
const ok200 = out.filter((r) => r.ok && r.status === 200);
console.log(`\n===== 真实业务路径验证: 200 成功 ${ok200.length} / 共 ${out.length} =====`);
