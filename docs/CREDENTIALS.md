# 个人信息（凭据）配置

工具**不要求**你把账号密码写死在某个文件里。可以用下面任意一种方式提供，优先级高的覆盖低的。

## 五种输入方式

### 1. 命令行参数（优先级最高，适合临时/一次性）

```powershell
node zhs.mjs login --school 示例大学 --student-id 00000000000 --password "你的密码"
node zhs.mjs whoami --real-name 张三
```

| 参数 | 对应字段 |
|---|---|
| `--school` | 学校 |
| `--student-id` / `--student` / `--sid` | 学号 |
| `--password` / `--pass` | 密码 |
| `--real-name` / `--name` | 姓名（可选） |

> 密码会出现在命令历史里，公用机器上建议改用方式 2 或 4。

### 2. 环境变量（适合 CI / 定时任务，不落盘）

```powershell
$env:ZHS_SCHOOL       = '示例大学'
$env:ZHS_STUDENT_ID   = '00000000000'
$env:ZHS_PASSWORD     = '你的密码'
$env:ZHS_REAL_NAME    = '示例用户'      # 可选

node zhs.mjs login
```

### 3. 导入任意来源的 JSON（可导入性）

不要求字段名统一——**导入时会自动识别别名**：

```powershell
node zhs.mjs import D:\someone-else-export.json
```

下面这些文件都能直接导入，不用手工改格式：

```jsonc
// 中文命名
{ "学校名称": "示例大学", "学号": "00000000000", "密码": "***", "姓名": "示例用户" }

// 英文命名
{ "university": "...", "userId": "...", "pwd": "***", "nickName": "..." }

// 混合 / 带无关字段（未识别字段会被忽略并提示）
{ "college": "...", "account": "...", "pass": "***", "_comment": "导出说明" }
```

识别别名一览：

| 标准字段 | 可识别的字段名 |
|---|---|
| `school` | `school` `schoolName` `university` `college` `school_name` `学校` `院校` `学校名称` |
| `studentId` | `studentId` `student_id` `studentNo` `studentNumber` `sid` `unid` `userId` `userid` `userName` `username` `account` `loginName` `学号` `账号` `用户名` |
| `realName` | `realName` `real_name` `name` `displayName` `nickName` `nickname` `姓名` `真实姓名` |
| `password` | `password` `passwd` `pwd` `pass` `secret` `密码` |

导入时可指定输出位置与字段覆盖：

```powershell
node zhs.mjs import X.json --save-to D:\my-cred.json
node zhs.mjs import X.json --school 示例大学        # 用参数补/覆盖某个字段
```

支持带 BOM 的 JSON（PowerShell 的 `Out-File` 默认就带 BOM）。

### 4. 交互式录入（不想让密码进命令历史）

```powershell
node zhs.mjs import --prompt
```

```
交互录入（密码不回显；姓名可留空）
  学校名（例如 示例大学）: 示例大学
  学号: 00000000000
  姓名（可留空）: 示例用户
  密码: ********
✓ 已写入 ...\config\credentials.json（权限已收紧）
```

### 5. 凭据库文件（默认落点）

`config/credentials.json` —— 上面方式 3/4 写入的位置，也是后续命令的默认凭据来源。

```powershell
Copy-Item config\account.template.json config\credentials.json
# 然后编辑填写
```

---

## 优先级

```
--school / --student-id / --password      ← 命令行（最高）
        ↓ 未提供则
ZHS_SCHOOL / ZHS_STUDENT_ID / ZHS_PASSWORD ← 环境变量
        ↓ 未提供则
--account <文件> 指定的凭据文件
        ↓ 未提供则
config/credentials.json                    ← 凭据库
        ↓ 不存在则
config/account-live.json → account.json    ← 兼容旧文件
```

**逐字段决定**，不是整体二选一。所以可以"环境变量给密码 + 凭据库给学校/学号"这样混用。

查看当前实际生效的来源：

```powershell
node zhs.mjs whoami
```

```
凭据来源：credentials.json + password:env
  学校   示例大学        ← credentials.json
  学号   00000000000     ← credentials.json
  姓名   示例用户          ← credentials.json
  密码   L*********      ← env
```

---

## 安全约定

| 措施 | 说明 |
|---|---|
| `.gitignore` | `config/` 整体忽略，只放行 `account.template.json`；`*account*.json`、`*.credentials.json` 也单独忽略 |
| 权限收紧 | 写入凭据时自动执行 `icacls <file> /inheritance:r /grant:r <当前用户>:F`，只留当前用户可读写；失败不报错（会提示未收紧） |
| 不回显 | `whoami` 只显示掩码（`L*********`）；日志里也只打掩码 |
| 密码不进文档 | 生成的 Markdown / Word / Excel 只含 `realName（school）`，绝不含密码 |

> `config/account.json` 若因权限问题读不了（历史上被收紧为仅 Administrator），工具会自动跳过它，不影响使用。

---

## 姓名与学校：以平台真值为准

文档封面显示的账号不是手写死的，而是：

1. 登录成功后，`whoami` 会调 `getLoginUserInfo` 拿到**平台返回的真实姓名**；
2. 登录时脚本会回读学校下拉框的**实际选中文本**（防止选到 `示例大学医学院` 之类同名前缀项）；
3. 把真值写回 `config/credentials.json`。

```powershell
node zhs.mjs whoami
# → 已把真实姓名写回凭据库：realName = 示例用户
# → 文档封面将显示：示例用户（示例大学）
```

---

## 换人 / 换学校的完整流程

```powershell
# 方式一：交互录入
node zhs.mjs import --prompt
node zhs.mjs login

# 方式二：一条命令带过去
node zhs.mjs login --school 新学校全名 --student-id 新学号 --password "新密码"

# 验证并让文档用上新信息
node zhs.mjs whoami
node zhs.mjs docs
```

> 换学校时 `school` 必须与登录页下拉框文本**完全一致**，否则会选错院校。不确定时先跑 `login`，把日志里「下拉候选」那行抄下来。
