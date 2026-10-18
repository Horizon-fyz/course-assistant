// 检查全部课程的「资料可下载权限」与资料列表
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');

const BASE = ROOT;
const OUT = BASE + '\\export';
mkdirSync(OUT, { recursive: true });
const H = JSON.parse(readFileSync(BASE + '\\session\\cookie-headers.json', 'utf8'));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0';
const host = 'stuonline.zhihuishu.com';

const raw = JSON.parse(readFileSync(OUT + '\\raw.json', 'utf8'));
const courses = raw.courses;

async function post(path, form, referer) {
  const res = await fetch(`https://${host}${path}`, {
    method: 'POST',
    headers: {
      'User-Agent': UA, Cookie: H[host] || '',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: referer,
    },
    body: form, redirect: 'manual', signal: AbortSignal.timeout(25000),
  });
  const t = await res.text().catch(() => '');
  return { status: res.status, ct: (res.headers.get('content-type') || '').split(';')[0], text: t };
}

const report = [];
for (const c of courses) {
  const ref = `https://${host}/stuonline/folder/stuIndexV2?recruitId=${c.recruitId}&courseId=${c.courseId}`;
  console.log(`\n===== ${c.courseName} (courseId=${c.courseId}) =====`);

  // 1) 下载权限
  const priv = await post('/stuonline/json/folder/findRolePrivilege', `courseId=${c.courseId}`, ref);
  let privData = null;
  try { privData = JSON.parse(priv.text); } catch {}
  const canDownload = privData?.canDownload;
  const rolePrivilege = privData?.rolePrivilege;
  console.log(`  权限接口: ${priv.status}  canDownload=${canDownload}  rolePrivilege=${rolePrivilege}`);

  // 2) 资料列表
  const list = await post(
    '/stuonline/folder/findCourseFolderListV2',
    `folderDataDto.courseId=${c.courseId}&page.pageSize=100&roleId=2&courseId=${c.courseId}`,
    ref,
  );
  const folderId = (list.text.match(/\$\('#folderId'\)\.val\('(\d+)'\)/) || [, null])[1];
  const count = (list.text.match(/\$\('#course-resouce-count'\)\.val\('(\d+)'\)/) || [, null])[1];
  const fileRows = [...list.text.matchAll(/<tr[^>]*class="[^"]*tm-file[^"]*"[^>]*>/gi)].length;
  console.log(`  资料列表: ${list.status}  folderId=${folderId}  资料数=${count}  文件行=${fileRows}  (返回 ${list.text.length}B)`);

  report.push({
    courseName: c.courseName, courseId: c.courseId, recruitId: c.recruitId,
    canDownload, rolePrivilege, folderId, materialCount: count, fileRows,
    privRaw: priv.text.slice(0, 400),
  });
}

writeFileSync(OUT + '\\download-capability.json', JSON.stringify(report, null, 2));

console.log('\n\n========= 汇总：资料下载能力 =========');
for (const r of report) {
  const able = r.canDownload === 0 ? '可下载' : (r.canDownload === 1 ? '不可下载' : '未知');
  console.log(`${r.courseName.padEnd(14)} canDownload=${String(r.canDownload).padEnd(5)} → ${able}   资料数=${r.materialCount}`);
}
console.log('\n说明: canDownload 0=允许下载(学生), 1=不允许下载(学生)');
