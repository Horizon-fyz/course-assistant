# 智慧树全域巡检报告

> 巡检时间：2026-10-10
> 身份：示例用户（uuid `demo-uuid`，示例大学 schoolId `5371`）
> 巡检范围：**68 个域名**（含子域 / 二级域 / 关联域）

---

## 0. 一句话结论

**68 个域名全部有 HTTP 响应，0 个网络不可达**；其中 26 个根路径直接 200，44 条真实业务路径验证为 200。
**会话 Cookie 已能覆盖全部 68 个域**（关键修正：必须带上父域 `.zhihuishu.com` 的 CAS 票据）。

---

## 1. 巡检方法（含一次纠错）

| 方法 | 问题 | 改进 |
|---|---|---|
| `page.goto()` 探测 | **403/404 是有效响应，却被 Playwright 当成异常**；且并发脚本会互相打断导航 | 改用 **Node 原生 fetch + `redirect:'manual'`**，状态码/响应头/正文都能干净拿到 |
| Cookie 拼装 | 只做了**精确域匹配**，漏掉父域 `.zhihuishu.com` 的 `CASTGC`/`jt-cas`，导致只有 21 个域有票据 | 按 RFC 6265 规则匹配（host 等于 domain 或以 `.domain` 结尾），**68 个域全部拿到票据** |

---

## 2. 状态码分布（68 个域名根路径）

| 状态 | 数量 | 说明 |
|---|---|---|
| 200 | 26 | 可直接访问的站点 / 应用 |
| 301/302 | 3 | `zhihuishu.com`、`passport`、`doc.livecourse.com` |
| 403 | 9 | WAF 拦截根路径，**带 Referer 访问具体路径正常** |
| 404 | 30 | **多为 API 服务**：根路径无路由属正常，需访问具体路径 |
| 网络不可达 | **0** | — |

### 不可达域名的澄清
首轮用浏览器 `fetch(mode:'no-cors')` 探测时，`doc.livecourse.com` 与裸域 `zhihuishu.com` 报 `Failed to fetch`；
改用 Node 直连后二者实际**都有响应**（`doc.livecourse.com` → 302 跳登录，`zhihuishu.com` → 301 跳转）。
即 **68 个域全部可达**。

---

## 3. 域功能分类与验证结果

### 3.1 身份与登录（4）
| 域 | 状态 | 职责 |
|---|---|---|
| `login.zhihuishu.com` | 200 登录中心 | 账号/学号/工号/扫码登录 |
| `passport.zhihuishu.com` | 302 → CAS | CAS 单点登录发 `ST-` 票据 |
| `user.zhihuishu.com` | `isLogin` 200 | 用户/注册/改密/实名 |
| `appcomm-user.zhihuishu.com` | 200（需 `callback` 参数） | 统一用户信息 `getUserInfoAndAuthInfo` |

### 3.2 学生主应用（5）
| 域 | 状态 | 职责 |
|---|---|---|
| `onlineweb.zhihuishu.com` | 200 | 在线学堂学生首页（入口） |
| `onlinestuh5.zhihuishu.com` | 200 | 学生端 SPA 产物 |
| `onlinemuster.zhihuishu.com` | 200 | 我的学堂 |
| `studyvideoh5.zhihuishu.com` | 200 | 视频学习页 |
| `stuonline.zhihuishu.com` | **200（Node 直连即可）** | 成绩分析 / 课程资料 / 见面课 |

### 3.3 业务 API 网关（API 类，根路径 404 属正常）
| 域 | 验证路径 | 结果 |
|---|---|---|
| `onlineservice-api.zhihuishu.com` | `/gateway/t/v1/...` | 200 |
| `studyservice-api.zhihuishu.com` | `/gateway/t/v1/login/getLoginUserInfo` | 200 |
| `hike-teaching-api.zhihuishu.com` | `/gateway/t/...` | 200 |
| `studentexam-api.zhihuishu.com` | `/studentExam/gateway/t/v1/...` | 200 |
| `newcourse-api.zhihuishu.com` | `/newcourse/gateway/f/v1/...` | 200 |
| `newexam-api.zhihuishu.com` | `/teacherExam/gateway/f/v1/...` | 200 |
| `creditqa-api.zhihuishu.com` | `/creditqa/gateway/f/v1/...` | 200 |
| `zhihuishu-ai-live-api.zhihuishu.com` | `/live/gateway/t/v1/...` | 200 |
| `hike.zhihuishu.com` | `/aidedteaching/schoolHelp/...` | 200 |
| `hikeservice.zhihuishu.com` | `/school/home/vip/...` | 200 |
| `hike-examstu.zhihuishu.com` | `/zhsathome/homework/...` | 200 |
| `school-platform.zhihuishu.com` | `/school/isHasSchoolPlatform` | 200 |
| `b2cpush.zhihuishu.com` | `/b2cpush/courseDetail/query2CCourseList` | 400（需特定 JSON） |

### 3.4 考试（4）
`onlineexamh5new` (200)、`tchexamh5` (200)、`newexam.zhihuishu.com` (200)、`taurusexam-api` (404 根路径)

### 3.5 成绩与资料（2）
`stuonline.zhihuishu.com`（成绩分析 200、见面课 200、课程资料 200）、`onlinescoremanage.zhihuishu.com`（302 → passport，需登录跳转）

### 3.6 内容 / 资源站（200）
`www`（官网）、`coursehome`、`courseh5`（创建课程）、`coursehomeh5`、`lc`（直播）、`majorhome`（职业资源库）、
`smartcourse`（知识图谱）、`wisdomh5`、`studyplush5`、`studyvocation`、`oral`、`fteaching`（小组教学）、
`aiteachingtoolsh5`、`onlineh5`、`online.zhihuishu.com`、`newbase`、`assets`、`ai-course-assistant-api`

### 3.7 静态 / 媒体（403 属正常，带 Referer 可访问）
`base1`、`base2`、`file`、`image`、`alivideo`、`assignmenth5`、`qah5`、`onlineexamh5new`

### 3.8 polymas 系（伙伴域）
| 域 | 状态 | 职责 |
|---|---|---|
| `polymas.com` | 200 | AI 能力中心 |
| `cloudapi.polymas.com` | `checkLogin` 200 | OAuth SSO 换票 |
| `coursehub.polymas.com` | 200 | 智能体课程广场 |
| `resources.polymas.com` | 200 | 静态资源 CDN |
| `aic-assessment.polymas.com` | 200 | 课程主页 |
| `hike-teaching-center.polymas.com` | 200 | 教学中心 |
| `doc.livecourse.com` | 302 → 登录页 | **ownCloud 网盘**（cookie `oc_sessionPassphrase`） |

---

## 4. 会话凭据覆盖（重要修正）

修正父域匹配后，**68 个域全部具备可用 Cookie**。关键票据种类：

| 票据 | 覆盖 |
|---|---|
| `CASTGC` / `jt-cas` | 66 个域（CAS 全局单点登录） |
| `o_session_id` / `c_session_id` | 66 个域 |
| `SESSION` | `onlineservice-api`、`hikeservice`、`creditqa-api`、`newcourse-api` |
| `JSESSIONID` | `stuonline`、`user`、`hike*`、`message`、`studentexam-api` 等 |
| `polymas-token` / `zhs-jt-cas` | polymas 系 6 个域 |
| `oc_sessionPassphrase` | `doc.livecourse.com` |

已重新生成：`session\cookie-headers.json`

---

## 5. 可操作性矩阵

| 能力 | 可行性 | 依据 |
|---|---|---|
| 只读数据抓取（课程/进度/成绩/通知） | ✅ 已验证 | Node 直连 + Cookie + `secretStr`，实测 200 |
| 服务端渲染页面抓取 | ✅ 已验证 | `stuonline` 页面 Node 直连渲染成功（74KB） |
| **课程资料下载** | ✅ **链路已打通** | 见第 6 节；但当前 3 门课**资料数为 0** |
| 驱动浏览器做交互 | ✅ 可用 | CDP 接管，`navigator.webdriver=false` |
| 视频站操作 | ⚠️ 受限 | `videolist` 可用；`queryStuyInfo` 等需参数入签名的接口返回 421 |

---

## 6. 课程资料下载机制（已完整还原）

### 6.1 页面配置
```
jsonPath = //stuonline.zhihuishu.com/stuonline/json
basePath = //stuonline.zhihuishu.com/stuonline
role     = 2（学生）
```

### 6.2 接口链
| 用途 | 接口 |
|---|---|
| 下载权限 | `POST /stuonline/json/folder/findRolePrivilege` （参数 `courseId`）→ 返回 `canDownload`、`rolePrivilege` |
| 资料列表 | `POST /stuonline/folder/findCourseFolderListV2` （参数 `folderDataDto.courseId`、`page.pageSize`、`roleId=2`、`courseId`）→ 返回 HTML 片段 |
| **文件下载** | `POST /stuonline/json/data/downloadMaterial` （参数 `dataDto.dataId`）→ 返回下载地址 |
| 数据文件下载 | `POST /stuonline/json/upload/downDataFile` （参数 `id`） |
| 压缩包下载 | `POST /stuonline/json/upload/downFile` （参数 `id`） |

### 6.3 权限语义（源码原文）
```js
// course_folder_new.js
var canDownload = $(obj).attr("canDownload"); // 0 可下载  1 不可下载（针对学生）
if (roleName == "学生" && canDownload == 1) {
   alert("抱歉，您所选择的内容并没有开放下载权限");
}
```

### 6.4 实际结果：**三门课资料均为 0 条**

| 课程 | courseId | folderId | 资料数 | 权限 |
|---|---|---|---|---|
| 大学生心理健康教育 | 1000101708 | 484910 | **0** | `rolePrivilege=0` |
| 国家安全教育 | 1000120382 | 488910 | **0** | `rolePrivilege=0` |
| 思想道德与法治 | 1000070264 | 418676 | **0** | `rolePrivilege=0` |

与页面文案「**暂无课程资料**」完全一致。
**结论：下载通道没问题，是这几门共享课本身没有上传资料。**

---

## 7. 复现命令

```bash
node lab\probes\refresh-cookie-headers.mjs   # 重建全域 Cookie 头（含父域）
node lab\probes\probe-hosts-v2.mjs           # 68 域全量巡检
node lab\probes\probe-business-paths.mjs     # 真实业务路径验证
node lab\probes\probe-folder-live.mjs        # 课程资料页实况抓取
node lab\probes\check-download-capability.mjs # 各课程下载权限与资料数
```

产物目录：`recon\hosts\`（`probe-v2.json`、`business-paths.json`、`summary.json`、`folder-live.json`）

---

## 8. 未解决 / 需注意

1. `b2cpush`、`coursehome/courseHome/`、`report-server` 根路径或简单请求返回 400/500，需按其前端实际参数调用。
2. `appcomm-user` 的 `getUserInfoAndAuthInfo` 是 **JSONP**，必须带 `callback` 参数。
3. `AssignmentH5`、`qah5`、`onlineh5`、`tchexamh5` 等 403 是 WAF 对无 Referer 请求的拦截，浏览器内正常。
4. **课程资料为 0 是账号真实状态**，不是抓取失败。

---

## 9. 补充巡检：考试/作业相关域名（第 2 轮补测）

第 1 轮漏掉了考试链路中的几个域名，补测结果：

| 域 | 用途 | 验证 |
|---|---|---|
| `studentexam-api.zhihuishu.com` | 作业信息、作答、申诉、考试环境检测 | ✅ 200 |
| `taurusexam-api.zhihuishu.com` | 期末考试、进度规则 | ✅ 200 |
| `onlineexamh5new.zhihuishu.com` | 作业考试前端页 | ✅ 200 |
| `wsvideo.zhihuishu.com` | **视频源站**（`video.src`） | 第 1 轮漏测 |
| `collector.zhihuishu.com` | 考试行为采集埋点 | 第 1 轮漏测 |
| `ai-course-platform.zhihuishu.com` | 考试页配置 `get-base-config` | 第 1 轮漏测 |
| `school.zhihuishu.com` | 学校门户（`getLoginSchoolInfo` 返回 `//school.zhihuishu.com/sgu`） | 第 1 轮漏测 |

**发现方式**：不是在 bundle 里搜出来的，而是**实地操作考试页时从真实网络请求里捕获**的。
说明纯静态分析的域名清单**必然不完整**，需靠运行时抓包补齐。

---
