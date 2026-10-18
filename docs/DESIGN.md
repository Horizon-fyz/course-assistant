---
version: 1.0
name: 智慧树助手-UI-规范
base: linear.app
description: "智慧树助手（WebView2 桌面工具）的 UI 规范。设计语言取自 Linear：以表面阶梯（surface ladder）+ 发丝边框（hairline）承载层级，唯一彩色强调为薰衣草蓝 #5e6ad2，仅用于品牌标记、主按钮与焦点环；深色画布 #010102，浅色画布 #ffffff。卡片 12px 圆角、按钮/输入 8px 圆角、状态药丸 9999px。全站无渐变、无彩色插画堆叠，靠留白与层级而非阴影。字重克制（标题 500–600、正文 400），显示级字号使用负字距。"

colors:
  # 品牌强调（唯一彩色）
  primary: "#5e6ad2"
  primary-hover: "#828fff"
  primary-focus: "#5e69d1"
  on-primary: "#ffffff"

  # 语义（克制使用）
  success: "#27a644"
  warning: "#d97706"
  danger: "#e5484d"

  # 浅色主题（light，默认）
  light:
    canvas: "#ffffff"
    surface-1: "#f7f8fa"
    surface-2: "#eff1f4"
    surface-3: "#e6e8ec"
    hairline: "#e3e5e9"
    hairline-strong: "#cdd0d6"
    ink: "#282a30"
    ink-muted: "#3c4149"
    ink-subtle: "#6f6e77"
    ink-tertiary: "#8a8f98"

  # 深色主题（dark）
  dark:
    canvas: "#010102"
    surface-1: "#0f1011"
    surface-2: "#141516"
    surface-3: "#18191a"
    surface-4: "#191a1b"
    hairline: "#23252a"
    hairline-strong: "#34343a"
    ink: "#f7f8f8"
    ink-muted: "#d0d6e0"
    ink-subtle: "#8a8f98"
    ink-tertiary: "#62666d"

typography:
  display-lg: { fontFamily: Inter, fontSize: 28px, fontWeight: 600, lineHeight: 1.20, letterSpacing: -0.6px }
  headline:   { fontFamily: Inter, fontSize: 22px, fontWeight: 500, lineHeight: 1.25, letterSpacing: -0.4px }
  card-title: { fontFamily: Inter, fontSize: 15px, fontWeight: 600, lineHeight: 1.30, letterSpacing: -0.2px }
  body:       { fontFamily: Inter, fontSize: 14px, fontWeight: 400, lineHeight: 1.50, letterSpacing: 0 }
  body-lg:    { fontFamily: Inter, fontSize: 16px, fontWeight: 400, lineHeight: 1.50, letterSpacing: -0.05px }
  caption:    { fontFamily: Inter, fontSize: 13px, fontWeight: 400, lineHeight: 1.40, letterSpacing: 0 }
  button:     { fontFamily: Inter, fontSize: 14px, fontWeight: 500, lineHeight: 1.20, letterSpacing: 0 }
  eyebrow:    { fontFamily: Inter, fontSize: 13px, fontWeight: 500, lineHeight: 1.30, letterSpacing: 0.4px }
  mono:       { fontFamily: "JetBrains Mono", fontSize: 12px, fontWeight: 400, lineHeight: 1.60, letterSpacing: 0 }

rounded:
  xs: 4px
  sm: 6px
  md: 8px
  lg: 12px
  xl: 16px
  pill: 9999px

spacing:
  xxs: 4px
  xs: 8px
  sm: 12px
  md: 16px
  lg: 24px
  xl: 32px

components:
  button-primary:  { backgroundColor: "{colors.primary}", textColor: "{colors.on-primary}", typography: "{typography.button}", rounded: "{rounded.md}", padding: "8px 14px" }
  button-primary-hover: { backgroundColor: "{colors.primary-hover}", textColor: "{colors.on-primary}", rounded: "{rounded.md}" }
  button-primary-pressed: { backgroundColor: "{colors.primary-focus}", textColor: "{colors.on-primary}", rounded: "{rounded.md}" }
  button-secondary: { backgroundColor: "{colors.light.surface-1}", textColor: "{colors.light.ink}", typography: "{typography.button}", rounded: "{rounded.md}", padding: "8px 14px" }
  button-danger:   { backgroundColor: "{colors.light.canvas}", textColor: "{colors.danger}", border: "1px {colors.light.hairline}", typography: "{typography.button}", rounded: "{rounded.md}", padding: "8px 14px" }
  card:            { backgroundColor: "{colors.light.canvas}", textColor: "{colors.light.ink}", rounded: "{rounded.lg}", padding: "24px" }
  text-input:      { backgroundColor: "{colors.light.canvas}", textColor: "{colors.light.ink}", typography: "{typography.body}", rounded: "{rounded.md}", padding: "8px 12px" }
  status-badge:    { backgroundColor: "{colors.light.surface-2}", textColor: "{colors.light.ink-muted}", typography: "{typography.caption}", rounded: "{rounded.pill}", padding: "2px 8px" }
  tab-item:        { backgroundColor: "transparent", textColor: "{colors.light.ink-subtle}", typography: "{typography.button}", rounded: "{rounded.md}", padding: "8px 14px" }
  tab-item-active: { backgroundColor: "{colors.light.surface-2}", textColor: "{colors.light.ink}", typography: "{typography.button}", rounded: "{rounded.md}" }
---

## 概览（Visual Theme & Atmosphere）

智慧树助手是一款运行在 WebView2 里的**桌面工具型应用**：主窗口负责配置与离线批量作答，独立悬浮窗负责「截屏识题 → 展示答案」。因此设计语言必须**克制、精确、信息密度高**，让答案本身成为主角，而不是装饰。

我们采用 **Linear** 的设计语言作为基准（`awesome-design-md` 中 `linear.app`）：

- **层级靠表面阶梯 + 发丝边框**，而不是阴影。深色画布 `#010102`，向上依次抬升 `#0f1011 → #141516 → #18191a`；浅色画布 `#ffffff`，向上 `#f7f8fa → #eff1f4`。
- **唯一彩色强调 = 薰衣草蓝 `#5e6ad2`**，只出现在品牌标记、主按钮、焦点环、链接强调四处，绝不作为卡片底色或大面积背景。
- **无渐变、无彩色插画、无花哨阴影。** 页面节奏靠留白与表面抬升。
- **字重克制**：标题 500–600、正文 400，显示级字号使用负字距（越大约负）。

### 关键特征

- 深色是「锚定表面」——悬浮窗默认深色最贴合工具气质；主窗口默认浅色，可一键切深色。
- 表面阶梯（canvas → surface-1 → surface-2 → surface-3）承载所有层级，不靠阴影。
- 卡片 `12px` 圆角 + 1px 发丝边框；按钮 / 输入 `8px` 圆角；状态药丸全圆。
- 强调色稀缺：品牌标记、主按钮、焦点环、链接。
- 正文默认 `Inter` / `PingFang SC`，代码与序号用等宽。

## 色彩（Color Palette & Roles）

### 品牌与强调
- **Primary 薰衣草蓝** `#5e6ad2` — 主按钮、品牌标记、链接强调、焦点环。
- **Primary Hover** `#828fff` — 主按钮悬停（更亮的薰衣草）。
- **Primary Focus** `#5e69d1` — 主按钮按下、输入焦点描边。

### 表面（明 / 暗）
| 角色 | 浅色 | 深色 | 用途 |
|---|---|---|---|
| canvas | `#ffffff` | `#010102` | 页面 / 悬浮窗最底层背景 |
| surface-1 | `#f7f8fa` | `#0f1011` | 卡片、面板、次级区块 |
| surface-2 | `#eff1f4` | `#141516` | 抬升卡片、悬停态、激活标签 |
| surface-3 | `#e6e8ec` | `#18191a` | 下拉、子导航、深层抬升 |
| hairline | `#e3e5e9` | `#23252a` | 1px 边框、分隔线 |
| hairline-strong | `#cdd0d6` | `#34343a` | 输入聚焦、强调边框 |

### 文字
| 角色 | 浅色 | 深色 | 用途 |
|---|---|---|---|
| ink | `#282a30` | `#f7f8f8` | 标题、强调正文 |
| ink-muted | `#3c4149` | `#d0d6e0` | 次级正文、选项 |
| ink-subtle | `#6f6e77` | `#8a8f98` | 说明、未激活标签、脚注 |
| ink-tertiary | `#8a8f98` | `#62666d` | 占位符、禁用 |

### 语义（克制）
- **success** `#27a644` — 题库命中、成功提示（仅用于状态，不用于答案文字）。
- **warning** `#d97706` — 待处理、AI 来源提示。
- **danger** `#e5484d` — 危险按钮（清空题库）、错误提示。

## 字体（Typography Rules）

- **无衬线主字体**：`Inter, "PingFang SC", "Microsoft YaHei", -apple-system, system-ui, sans-serif`。
- **等宽**：`"JetBrains Mono", "SF Mono", Consolas, ui-monospace, monospace`（用于序号、题库计数、日志、文本框）。

| 令牌 | 字号 | 字重 | 行高 | 字距 | 用途 |
|---|---|---|---|---|---|
| display-lg | 28px | 600 | 1.20 | -0.6px | 大标题（顶栏字样） |
| headline | 22px | 500 | 1.25 | -0.4px | 卡片大标题（悬浮窗题干） |
| card-title | 15px | 600 | 1.30 | -0.2px | 卡片标题、答案 |
| body | 14px | 400 | 1.50 | 0 | 默认正文 |
| body-lg | 16px | 400 | 1.50 | -0.05px | 引导段落 |
| caption | 13px | 400 | 1.40 | 0 | 说明、元信息 |
| button | 14px | 500 | 1.20 | 0 | 按钮文字 |
| eyebrow | 13px | 500 | 1.30 | +0.4px | 分区小标签 |
| mono | 12px | 400 | 1.60 | 0 | 序号、日志、文本框 |

**原则**：显示级负字距、正文中性字距；标题最多 600 字重；等宽只用于代码/数字语境。

## 组件规范（Component Stylings）

### 按钮
- **主按钮 button-primary**：背景 `primary`，文字 `on-primary`，8px 圆角，内边距 `8px 14px`；悬停 `primary-hover`，按下 `primary-focus`。
- **次按钮 button-secondary**：背景 `surface-1`（浅色）/ `surface-2`（深色），文字 `ink`，1px `hairline` 边框。
- **危险按钮 button-danger（柔和）**：透明底（`canvas`）+ `danger` 文字 + 1px `hairline` 边框；悬停时背景 `danger-bg`、边框 `danger`。用于行内的「清空题库」这类次级破坏性操作。**实心 `danger` 白字**只用于最高优先级的破坏性操作（悬浮窗的「停止」按钮）。
- **幽灵/图标按钮**：透明背景，`ink-subtle` 文字，悬停时背景 `surface-1`。

### 卡片与容器
- **card**：背景 `canvas`，1px `hairline` 边框，**12px 圆角**，内边距 `24px`；浅色下极淡阴影（`0 1px 2px rgba(0,0,0,.04)`），深色下无阴影。
- **悬浮窗面板 wrap**：背景 `canvas`/`surface-1`，1px `hairline`，**12px 圆角**（`--r-lg`，与宿主窗口 `Region` 裁切半径一致），深色下靠表面阶梯，浅色下用 `0 16px 40px rgba(0,0,0,.16)` 营造浮起感；顶边可有一道 1px 白色高光（深色）。

### 输入与表单
- **text-input / textarea**：背景 `canvas`，1px `hairline`，8px 圆角，内边距 `8px 12px`，文字 `ink`。
- **聚焦态**：边框 `primary-focus`，外环 `0 0 0 3px` 主色 12–18% 透明。
- 表单字段标签用 `caption` 字重 500，`ink-muted`。

### 标签与徽标
- **status-badge**：全圆药丸，背景 `surface-2`，文字 `ink-muted`，`2px 8px`；成功态用 `success` 前景 + 8% 背景。
- **tab（分段）**：默认透明 + `ink-subtle`；激活态背景 `surface-2` + 文字 `ink`；悬停背景 `surface-1`。
- **tag（题目类型 / 来源）**：全圆，`eyebrow` 字号；题库来源用 `success` 系，AI 来源用 `warning` 系。

### 进度与结果
- **progress**：高 6px，全圆轨道 `surface-2`，填充 `primary`。
- **结果项 q**：`surface-1`（浅色）/ `surface-1`（深色）背景，1px `hairline`，12px 圆角，内边距 `16px`；答案用 `primary`（薰衣草）强调。
- **日志 pre.log**：等宽、`surface-1` 背景、12px 圆角。

## 布局（Layout Principles）

- **基础单位** 4px。间距令牌：`4 / 8 / 12 / 16 / 24 / 32`。
- 卡片内部 `24px` 内边距；卡片之间 `16–24px` 间距；区块之间 `32px`。
- 主窗口内容**最大宽度 860px 居中**，两侧留白；顶栏与标签栏通栏。
- 悬浮窗：宽约 380px、高约 520px，三段式（拖拽标题栏 / 滚动内容 / 底部操作）。
- 留白即层级：深色画布本身就是留白，靠抬升到 surface-1 面板来分区，而不是加更多边框。

## 层级与深度（Depth & Elevation）

| 级别 | 处理 | 用途 |
|---|---|---|
| 0 平坦 | 无阴影无边框 | 正文、标题 |
| 1 表面抬升 | `surface-1` 背景 + 1px `hairline` | 默认卡片 |
| 2 抬升 | `surface-2` 背景 + 1px `hairline-strong` | 悬停卡片、激活标签 |
| 3 深层 | `surface-3` 背景 | 下拉、子导航 |
| 4 焦点环 | `0 0 0 3px` `primary` 12–18% | 聚焦输入 / 按钮 |

深色**几乎不用投影**，靠表面阶梯 + 发丝边框；浅色仅用极淡投影补足浮起感（悬浮窗可用较强投影）。

## 该做与不该做（Do's and Don'ts）

**Do**
- 把 `canvas` 作为锚定表面；深色用 `#010102`，浅色用 `#ffffff`。
- 强调色只用在这四处：品牌标记、主按钮、焦点环、链接。
- 用表面阶梯造层级，不跳级。
- 标题 600 / 正文 400；显示级负字距。
- 卡片 12px 圆角、按钮与输入 8px 圆角、药丸全圆。
- 悬浮窗默认深色，让答案区（`primary` 薰衣草强调）一眼可读。

**Don't**
- 不要用强调色做卡片底色或大区块背景。
- 不要引入第二种彩色强调（橙、粉、绿）去装饰。
- 不要加渐变、光斑、彩色插画堆叠。
- 不要把按钮做成全圆药丸（除状态标签外）。
- 深色不要用纯 `#000000`，浅色不要用纯灰底替代白底。
- 不要用重投影制造层级。

## 响应行为（Responsive Behavior）

| 断点 | 宽度 | 变化 |
|---|---|---|
| Desktop | ≥1024px | 内容 860px 居中，设置网格 2 列 |
| Tablet | 768–1024px | 设置网格仍 2 列，卡片内边距略减 |
| Compact | 480–768px | 设置网格 1 列，标签栏可横向滚动 |
| Float | ~380px | 悬浮窗单列，底部按钮等宽平分 |

- 触摸 / 点击目标 ≥ 36px（按钮 `8px 14px` 已达）。
- 悬浮窗固定尺寸，内容区滚动，底部操作常驻。

## Agent 提示指南（Agent Prompt Guide）

**快速色参**
- 主色 `#5e6ad2`｜悬停 `#828fff`｜按下 `#5e69d1`
- 深色画布 `#010102`｜深色面板 `#0f1011`｜深色边框 `#23252a`｜深色文字 `#f7f8f8`
- 浅色画布 `#ffffff`｜浅色面板 `#f7f8fa`｜浅色边框 `#e3e5e9`｜浅色文字 `#282a30`
- 成功 `#27a644`｜警告 `#d97706`｜危险 `#e5484d`

**可直接使用的提示词**
> 用本文件 `DESIGN.md` 的 Linear 设计语言实现界面：surface ladder 造层级、1px 发丝边框、卡片 12px / 按钮 8px 圆角；唯一强调色是 `#5e6ad2`，只用于品牌标记、主按钮、焦点环、链接；深色画布 `#010102`、浅色 `#ffffff`；无渐变、无重投影；标题 600 字重、正文 400。

**实现约定（本项目）**
- 令牌以 CSS 变量落在 `desktop/ui/styles.css` 的 `:root`（浅色）与 `[data-theme="dark"]`（深色）。
- 主窗口 `index.html` + `app.js`；悬浮窗 `float.html` + `float.js`，悬浮窗样式统一收敛在 `styles.css` 的 `.float-window` 作用域内。
- 主题切换写 `localStorage['zhs-theme']`（`light` / `dark`），默认 `light`。
