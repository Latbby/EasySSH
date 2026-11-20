# ssh-client 界面独立评审报告

- **评审人**：ui-review（独立第三方视角，首次接触本界面）
- **评审时间**：2026-11-20 11:35–11:48（Asia/Shanghai）
- **评审对象**：`src/renderer/src/assets/main.css`、`src/renderer/src/App.tsx`、`src/renderer/src/components/*.tsx`
- **素材**：`scripts/ui-shots/after/` 10 张 + `scripts/ui-shots/before/` 3 张对照
  - after 实测文件时间：`01-empty.png` 11:34:28 → `10-narrow.png` 11:34:33（均在评审前 1 分钟内生成，为最新一轮修复后的状态）
  - before 实测文件时间：11:29:13–11:29:16
- **方法**：`read_image` 逐张目视 + Pillow 逐像素量化（背景/文字峰值色、元素边界、列对齐、行距）+ 全量代码走查（含 CSS 特异性推演）+ WCAG 2.1 相对亮度计算
- **声明**：本轮**未修改任何源码或 CSS**，未执行任何 git 操作。报告中所有 file:line 均指评审时的文件内容。凡"计算值"（而非截图像素实测）均已标注。
- **素材与代码的时序核对（重要）**：截图生成于 11:34:28–11:34:33，而代码在截图之后仍被改动过——`HostKeyDialog.tsx` 11:34:35、`ConnectionForm.tsx` 11:34:45、`TerminalSearchBar.tsx` 11:34:54、`App.tsx` 11:35:09。其中：

  | 文件 | 最后修改 | 相关截图 | 是否可能过期 |
  |---|---|---|---|
  | `assets/main.css` | 11:33:34 | 全部 | 否（早于所有截图，故全部像素结论与当前 CSS 一致） |
  | `ConnectionList.tsx` | 11:33:39 | 01/02 | 否 |
  | `Toast.tsx` | 11:34:26 | 09 | 否 |
  | `ConnectionForm.tsx` | 11:34:45 | 08（11:34:32 生成） | **是**——我逐字段核对了当前组件（6 个字段：名称 / 主机+端口 / 用户名 / 认证方式 / 私钥文件 / 私钥口令），与 08 截图一致，故结论仍成立 |
  | `TerminalSearchBar.tsx` | 11:34:54 | 05（11:34:31 生成） | **是**——当前组件的元素构成（输入框 / 计数 / ↑ / ↓ / Aa / ×）与 05 截图一致，故结论仍成立 |
  | `App.tsx` | 11:35:09 | 全部 | **是**——所有 App.tsx 相关结论（报文渲染、弹窗挂载、全局快捷键、`window.confirm`）均以**当前版本**为准复核过 |

  由于 `main.css` 早于全部截图，且 `--text-faint`、`.toast.error` 缺失、`.conn-actions` 几何等关键结论都以当前 CSS 为依据，报告结论不受上述时序影响；但**建议下一轮改完后重跑 `ui-shot.cjs`，并确认 05/08/09 三张图与当时代码同版本**。

> 本轮 lead 已修的 4 个缺陷（Toast 居中、SFTP 文件名居中、连接项操作按钮挤占主机名、空态提示位置）已确认生效：截图实测 Toast 中心 x=679.5 = 视口中心；SFTP 表头「名称」与文件名左沿同为 x=312；连接项主机名不再被按钮挤压（对照 before 里「生产 Web 服…」被截断）；空态提示紧贴搜索框下方。下面列的是**仍然存在**的问题。

---

## 0. 结论摘要

| 维度 | 高 | 中 | 低 | 小计 |
|---|---|---|---|---|
| A 视觉层级与一致性 | 0 | 1 | 5 | 6 |
| B 对比度与语义色 | 2 | 2 | 0 | 4 |
| C 交互状态覆盖 | 1 | 5 | 4 | 10 |
| D 边界与响应式 | 0 | 2 | 2 | 4（另 D5 待复核） |
| E 细节打磨 | 0 | 1 | 6 | 7 |
| **合计** | **3** | **11** | **17** | **31（+1 待复核）** |

三个最值得注意的结论：

1. **`--text-faint` 这一个令牌就拖垮了整个界面的对比度达标率**（3.38–3.98:1），它承载的却是页脚计数、输入框占位符、SFTP 表头、右键菜单快捷键、空态说明等功能性文本，共 9 处。改 1 行令牌可一次性解决。
2. **错误 Toast 没有任何语义色**：`showToast('error', …)` 走的是 `.toast.error`，但 CSS 里只有 `.toast.success` / `.toast.info`。截图实测错误提示的左侧状态条是 accent 蓝 `#6d9bff`，与"连接已保存"完全一致——唯一的严重度视觉编码失效。
3. **交互态在"已选中/已连接"这类复合状态下会互相覆盖**：`.sftp-row.selected` 被 hover 覆盖、`.conn-item.session-active` 的 hover 反向覆盖，都是 CSS 特异性没算清，而不是设计取舍。

---

## A. 视觉层级与一致性

### A1 中｜字号 8 档，其中 3 档只出现 1–2 次

**现象（证据）**：`main.css` 实际使用 11 / 11.5 / 12 / 12.5 / 13 / 13.5 / 14 / 14.5 共 8 种字号。其中：

- `11.5px` 全文件仅 1 处：`main.css:910`（SFTP 表头）
- `13.5px` 仅 2 处：`main.css:259`（侧栏标题「连接」）、`main.css:1049`（拖拽提示层）
- "标题级"同时存在 `14.5px`（`main.css:1151` 弹窗标题）、`14px`（`main.css:716` 空态标题）、`13.5px`（`main.css:259` 侧栏标题）三种
- `12px` 与 `12.5px` 混用于同类元素：全局按钮 12.5（`main.css:141`）vs 侧栏按钮 12（`main.css:267`）、SFTP 行 12.5（`main.css:905`）vs SFTP 提示条 12（`main.css:892`）、弹窗说明 12.5（`main.css:1184`）vs 弹窗字段标签 12（`main.css:1193`）

**影响**：11.5 与 12、13 与 13.5 在 100% 缩放下肉眼不可分辨，属于"白增一档"；同级标题三档不齐，层级读起来像是随手定的，而不是设计出来的。这正是"第一次看会觉得哪里不齐、但说不出哪里"的典型来源。

**修法**：收敛为 4 档（11 辅助等宽小字 / 12 次要 UI 与说明 / 13 正文与列表主名 / 14 区块与弹窗标题）：

- `main.css:910`：`11.5px` → `12px`
- `main.css:259`：`13.5px` → `14px`（与弹窗标题统一为区块标题档）
- `main.css:1049`：`13.5px` → `13px`
- `main.css:267`：`12px` → `12.5px`（与全局按钮一致）
- `main.css:892`：`12px` → `12.5px`（与 SFTP 行一致）

### A2 低｜间距没有令牌，且混入 3/5/14/18/22/26 一组奇数

**现象（证据）**：`:root`（`main.css:10-66`）令牌化了颜色、圆角、阴影、焦点环、字体、动效时长，**唯独没有间距令牌**。实际 gap/padding 值分布：1、2、3、4、5、6、8、10、12、14、16、18、22、24、26、28。其中脱离 4px 网格的：`main.css:218`（kbd gap 3）、`main.css:382`（连接项两行 gap 3）、`main.css:1252`（指纹行 gap 5）、`main.css:802`（菜单项 gap 1）、`main.css:1145`（弹窗头 padding 16px 18px）、`main.css:1159`（弹窗体 padding 18）、`main.css:919`（表头让位 26）、`main.css:754`（搜索栏 padding 6）。侧栏内部自成一套（14/12/10/8/6/4/3/2），弹窗内部自成另一套（18/16/14/10/8/6）。

**影响**：跨组件搬运样式时无法靠令牌对齐；弹窗（18/14）与侧栏（14/12）两套节奏并置时，同屏可见的 14px 与 18px 留白不成倍数关系。

**修法**：在 `main.css:65` 附近补间距令牌 `--sp-1: 4px; --sp-2: 6px; --sp-3: 8px; --sp-4: 12px; --sp-5: 16px; --sp-6: 24px`，新代码一律引用；存量只统一 3 处最明显的：`main.css:382` 与 `main.css:218` 的 `gap: 3px` → `4px`（连接项行高 +1px，可接受）、`main.css:1252` 的 `gap: 5px` → `6px`。**不建议**为凑令牌做全局替换，收益低于回归风险。

### A3 低｜四个"顶栏"的首元素左沿分别是 14 / 18 / 12 / 14 px

**现象（证据）**：左侧内容起始位置实测（均相对各自容器的左沿）——侧栏标题「连接」x=14（`main.css:254` padding 0 14px）；标签栏首个标签内容 x=18（`main.css:562` padding 6px 8px + `main.css:580` padding-left 10px）；SFTP 工具栏图标按钮 x=12（绝对 x=285 =272+1+`main.css:866` padding 12px）；SFTP 列表行图标 x=14（绝对 x=287 =273+`main.css:904` padding 0 14px）。四者横向高度也各不相同：34px（`main.css:517` 状态条）/ 44px（`main.css:561` 标签栏）/ 50px（`main.css:866` SFTP 工具栏）/ 52px（`main.css:253` 侧栏头）。

**影响**：切换标签到 SFTP 时，左侧第一条竖线会跳动 4–6px；截图对比 01-empty 与 07-sftp 的左上角能直接看出错位。

**修法**：以 14px 为全局左基准线（已是侧栏/状态条/SFTP 行的取值）：`main.css:562` 标签栏 padding 改为 `6px 4px`（4+10=14 与侧栏对齐）；`main.css:866` SFTP 工具栏 padding 改为 `10px 14px`。

### A4 低｜两处圆角脱离令牌

**现象（证据）**：`main.css:1120` `.modal { border-radius: 14px }`——其余所有浮层都是 `--radius-lg`（12px）：`main.css:757`（搜索栏）、`807`（右键菜单）、`1053`（拖拽层）、`1301`（Toast）。`main.css:228`（`.kbd`）与 `main.css:657`（`.tab-icon`）用 `5px`，而 `--radius-sm` 是 6px。

**影响**：弹窗与同屏出现的右键菜单/Toast 圆角不一致（14 vs 12），在 06/08 两张图里并排看会显得弹窗"更圆一点"。

**修法**：`main.css:1120` → `var(--radius-lg)`；`main.css:228`、`657` → `var(--radius-sm)`。

### A5 低｜调色板只令牌化了一半：13 处字面色值（12 处内联 rgba + 1 个手调近似色）

**现象（证据）**：`:root` 之外仍有 13 行字面色值：`main.css:93`（选区）、`107`/`114`（滚动条）、`371`（`--row-hover: #2d3952`）、`373`（active 行描边 `rgba(109,155,255,0.22)`）、`530`（spinner 环 `rgba(109,155,255,0.25)`）、`794`（搜索按钮激活描边 `rgba(109,155,255,0.35)`）、`1051`（拖拽层底 `rgba(14,16,21,0.86)`）、`1098`（遮罩 `rgba(6,8,12,0.62)`）、`1170`（页脚底 `rgba(0,0,0,0.14)`）、`1239`/`1273`/`1278`（错误/指纹描边）。其中 accent 的 RGB `(109,155,255)` 在 `:root` 之外又以 **4 种不同 alpha**（0.22 / 0.25 / 0.32 / 0.35）重复出现，加上令牌内的 0.14（`--accent-soft`）与 0.26（`--ring`）共 6 种。另有 `TerminalView.tsx:234-241` 硬编码了一整套终端主题色（`#15181f`/`#e7eaf0`/`#6d9bff`/`rgba(109,155,255,0.3)`），`TerminalView.tsx:232-233` 又复制了一遍 `--font-mono` 字体栈（多了 Noto Sans Mono CJK SC）。

**影响**：改主题时要全局搜色值；`--row-hover: #2d3952` 还是个"手调近似色"，且与事实不符（见 C3）。

**修法**：`main.css:33` 附近加 `--accent-rgb: 109 155 255; --danger-rgb: 255 122 144; --warning-rgb: 227 179 65;`，把 6 处 accent 内联改成 `rgb(var(--accent-rgb) / 0.22)` 这类写法；`main.css:371` 改为 `--row-hover: color-mix(in srgb, var(--accent) 14%, var(--bg-hover));` 并同步注释。终端主题（xterm 需要字面量）可保留，但建议加注释说明"与 :root 令牌手工同步"。

### A6 低｜SFTP 用彩色 emoji 图标，是全界面最饱和的一块颜色

**现象（证据）**：`SftpPanel.tsx:100-104` 返回 `📁` / `🔗` / `📄`。截图 07 实测文件夹图标峰值色 **`#ffda57`**（亮黄），是整张图里饱和度最高的像素；界面其余图标全部是单色字符：`⇅ ✎ ⧉ × ↻ ↑ ↓`。

**影响**：黄色 emoji 在冷调暗色底上非常跳，抢走对文件名的注意力；emoji 的字形随系统字体变化（Windows/macOS/Linux 三套观感），且基线/字重与单色字符不一致，18px 图标列里看起来大小不齐。

**修法**：`SftpPanel.tsx:100-104` 换成单色字符（目录 `▸`、链接 `↗`、文件 `▢`），或在 `main.css:1008-1013` 用 `mask-image` + `background: var(--text-muted)` 做成可上色图标；选中/hover 时切 `var(--accent)`。

---

## B. 对比度与语义色（WCAG 2.1 相对亮度，实测 + 令牌计算）

### B1 高｜错误提示没有语义色（`.toast.error` 规则缺失）

**现象（证据）**：`Toast.tsx:19` 输出 ``className={`toast ${toast.kind}`}``，`types.ts:35` 定义了 `success | error | info` 三种，`App.tsx:101-106` 把失败路径统一交给 `showToast('error', …)`（错误停留 8 秒，成功/信息 3 秒）；但 `main.css:1318-1324` 只写了 `.toast.success` 与 `.toast.info`，**没有 `.toast.error`** → 错误提示落到 `main.css:1300` 的默认值 `border-left: 3px solid var(--accent)`。像素实测（09-toast.png；该图由脚本先断言 `.toast.error` 存在再截取，见 `ui-shot.cjs:1455`）：提示条左侧状态条 x=360–362 = **`#6d9bff`**（accent 蓝），与"连接已保存"的成功提示完全同色。

**影响**：左侧 3px 状态条是全应用唯一的严重度视觉编码；错误态失效后，用户必须读完整句才能区分"连接失败"与"连接已保存"，而错误提示恰好停留最久（8 秒）且覆盖在内容之上。屏幕阅读器侧是好的（`Toast.tsx:20-21` 用了 `role="alert"` + `aria-live="assertive"`），纯视觉用户拿不到对应信息。

**修法（1 行）**：`main.css:1324` 之后补：

```css
.toast.error { border-left-color: var(--danger); }
```

如需更强提示，可再加 `background: color-mix(in srgb, var(--danger) 8%, var(--bg-raised))`，但只补这一行就能恢复语义区分。

### B2 高｜`--text-faint` 在所有背景上都不达 4.5:1，而它承载的是功能性文本

**现象（证据）**：`--text-faint: #6b7484`（`main.css:30`）对各级背景的对比度：

| 前景 | `--bg-app`<br>#0e1015 | `--bg-sidebar`<br>#12141b | `--bg-surface`<br>#171a22 | `--bg-raised`<br>#1e222c | `--bg-hover`<br>#232936 | `--bg-active`<br>#2b3346 |
|---|---|---|---|---|---|---|
| `--text` #e7eaf0 | 15.79 | 15.26 | 14.43 | 13.20 | 12.08 | 10.47 |
| `--text-muted` #98a2b3 | 7.39 | 7.14 | 6.75 | 6.18 | 5.66 | 4.90 |
| **`--text-faint` #6b7484** | **4.04** | **3.90** | **3.69** | **3.38** | **3.09** | **2.68** |
| `--accent` #6d9bff | 7.05 | 6.82 | 6.45 | 5.89 | 5.40 | 4.68 |

截图像素实测（峰值色，非计算值）：空态说明 `#6b7484` 对 `#171a22` = **3.69:1**；侧栏页脚「共 6 个连接」`#6b7484` 对 `#12141b` = **3.90:1**；快速连接说明 = **3.69:1**；搜索框 placeholder = **3.69:1**；SFTP 表头「名称」= **3.90:1**；右键菜单快捷键 `Ctrl+Shift+C` = **3.38:1**。这些字号是 11–12.5px（远小于"大字"门槛 18.66px 粗体/24px），必须按 4.5:1 判定。

使用点共 9 处（全部低于 4.5:1）：`main.css:188`（input::placeholder）、`277`（侧栏页脚）、`315`（快速连接说明）、`492`（hint-text）、`618`（标签种类符号）、`711`+`741`（空态说明与快捷键标签）、`838`（菜单快捷键提示）、`912`（SFTP 表头「名称」）、另 `main.css:654`/`1339`（标签关闭 ×、Toast 关闭 ×，作为 UI 组件按 3:1 判定，3.38:1 勉强达标）。

**影响**：这是全界面唯一系统性违反 WCAG AA 的地方，且命中的全是"用户需要读它才能操作"的文字（占位符、快捷键、表头、计数）。在亮度偏低或反光环境下，11px 的 `#6b7484` 基本读不清。

**修法（改 1 行）**：`main.css:30` → `--text-faint: #8b93a3;`（sidebar 5.96 / surface 5.63 / raised 5.15 / hover 4.72，全部达标）。若担心与 `--text-muted` 层次拉不开，最低可用 `#868fa0`（5.65 / 5.34 / 4.89 / 4.47）；也可同时把 `--text-muted` 提到 `#a7b0bf` 以保持三级层次：

| 候选 | sidebar | surface | raised | hover |
|---|---|---|---|---|
| `#6b7484`（现状） | 3.90 | 3.69 | 3.38 | 3.09 |
| `#7a8495` | 4.87 | 4.61 | 4.21 | 3.86 |
| `#868fa0` | 5.65 | 5.34 | 4.89 | 4.47 |
| **`#8b93a3`（建议）** | **5.96** | **5.63** | **5.15** | **4.72** |
| `#939cac` | 6.65 | 6.29 | 5.75 | 5.27 |

### B3 中｜SFTP 表头同一行里两种文字颜色

**现象（证据）**：`main.css:912` 给 `.sftp-head` 设了 `color: var(--text-faint)`，但 `main.css:952`（`.col-size`）与 `main.css:959`（`.col-time`）把颜色写死成 `var(--text-muted)`——表头行本身也是 `.sftp-row`，于是这三个单元格同时被两组规则命中。截图实测：表头「名称」峰值 `#6b7484`（**3.90:1**），而「大小」「修改时间」峰值 `#98a2b3`（**7.14:1**）。

**影响**：同一行表头三种列名亮度不同，读起来像「名称」被置灰（用户会误以为该列不可用）；同时它是 B2 之外的第二个不达标点。

**修法（2 行）**：把列颜色限定到数据行——`main.css:952`、`959` 改为 `.sftp-list .col-size { … }` / `.sftp-list .col-time { … }`（或在 `main.css:912` 把表头颜色统一为 `var(--text-muted)`，让三种列名一致）。

### B4 中｜次要按钮与输入框的边界对比只有 1.20–1.37:1

**现象（证据）**：

| 元素 | 描边/填充 | 背景 | 对比度 |
|---|---|---|---|
| 弹窗输入框描边 `#2b303c` | `--border` | 弹窗底 `#1e222c` | **1.20:1** |
| 弹窗输入框填充 `#0f1218` | `--bg-input` | 弹窗底 `#1e222c` | 1.18:1 |
| 弹窗页脚「取消」按钮填充 `#1e222c` | = 弹窗底 | 页脚底 `#1a1d26` | 1.06:1 |
| 弹窗页脚「取消」按钮描边 | `--border` | 页脚底 `#1a1d26` | **1.27:1** |
| SFTP 工具栏默认按钮描边（08 之外） | `--border` | 面板底 `#171a22` | **1.37:1** |

WCAG 1.4.11（非文本对比）对"识别控件所需的视觉信息"要求 3:1。截图目视这些输入框与按钮仍可辨认（1.2:1 的描边在纯暗底上依然成形），因此我**不把它列为高优先级**，但需要显式记录取舍。

**修法（含取舍）**：严格达标需要约 `#636b7a` 的描边（对 `#1e222c` ≈ 2.97:1），会把暗色界面整体"点亮"，观感变化明显。建议折中：表单控件与默认按钮的描边从 `var(--border)` 提到 `var(--border-strong)` `#3a4150`（对 `#1e222c` 1.55:1、对 `#171a22` 1.70:1），并给输入框加 `box-shadow: inset 0 1px 0 rgba(255,255,255,0.04)` 强化"可输入"暗示（`main.css:174-185`）。若团队接受低对比描边的暗色风格，请把这条记进设计约定，避免下一轮被当成漏改反复提出。

### B5 达标项（不用动，供对照）

`--text` 10.47–15.79:1；`--text-muted` 最差 4.90:1（在 `--bg-active` 上，实际未用于该底色）；`--accent` 最差 4.68:1；主按钮 `--accent-ink` on `--accent` = **6.94:1**（截图实测主按钮底 `#6d9bff`、文字 `#0b1220`）；`--accent` on `--accent-soft`(over surface) = 5.16:1（SFTP 提示条 `main.css:893`、搜索栏激活态 `main.css:792`）；`--warning` on `--warning-soft` = 7.33:1；`--danger` on `--danger-soft` = 5.09:1；`--text-muted` on `--accent-soft`(over surface) = 5.41:1（状态条 `main.css:520`）。**这些不要因为修 B1 而连带改动。**

---

## C. 交互状态覆盖

### C1 高｜标签栏键盘不可达（ARIA tabs 模式只实现了一半）

**现象（证据）**：`TabBar.tsx:31` 用了 `role="tablist"`、`33-48` 用 `role="tab"` + `tabIndex={activeId ? 0 : -1}`（漫游 tabindex），但 `TabBar.tsx:41-47` 只处理 `Enter` / `Space`——**没有 ←/→/Home/End**，也没有把焦点移到新激活的标签上。后果：Tab 键跳过所有非激活标签（`tabIndex=-1`），键盘用户无法把焦点放到第 2 个标签上；能落到非激活标签里的只有它的「×」按钮。

**影响**：ARIA APG 的 tabs 模式要求漫游 tabindex 必须配方向键，当前实现只完成了一半，读屏/键盘用户会以为标签栏不可操作。缓解项确实存在：`App.tsx:347-351` 的 Ctrl+Tab / Ctrl+Shift+Tab、`App.tsx:368-371` 的 Alt+1..9 可用且空态有提示（`WorkspaceTabs.tsx:71-78`），所以不是"完全不能用"，但控件的语义与行为不一致。

**修法**：`TabBar.tsx:41-47` 增加方向键处理，并把焦点移到目标标签（需给每个 `.tab` 加 ref 或用事件目标定位）：

```tsx
const tabRefs = useRef<Array<HTMLDivElement | null>>([])
// onKeyDown 内：
const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
if (step !== 0 || event.key === 'Home' || event.key === 'End') {
  event.preventDefault()
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
    : (index + step + tabs.length) % tabs.length
  onActivate(tabs[next].id)
  tabRefs.current[next]?.focus()
}
```

同时给每个面板补 `role="tabpanel"` + `aria-controls`（`WorkspaceTabs.tsx:43-57`），让 `aria-selected` 有对应关系。

### C2 中｜弹窗缺焦点陷阱与焦点归还；主机密钥弹窗连 Esc 和初始焦点都没有

**现象（证据）**：

- `ConnectionForm.tsx:100-109` 与 `HostKeyDialog.tsx:23-30` 都声明了 `aria-modal="true"`，但都没有焦点陷阱，也没有对背景加 `inert` / `aria-hidden`；`App.tsx:481-497` 关闭时只是 `setEditor(null)` / `setHostKey(null)`，**不把焦点还给触发元素**（关闭后焦点落到 body，键盘用户要重新 Tab 十几下才能回到「+ 新建」）。
- `ConnectionForm.tsx:41-47` 有 Esc 关闭，`HostKeyDialog.tsx` **完全没有键盘监听 → Esc 无效**。
- `ConnectionForm.tsx:124` 有 `autoFocus`，`HostKeyDialog.tsx` 没有任何初始焦点 → 弹窗打开后焦点仍在后面的终端/侧栏，Tab 会直接走进背景界面。

**影响**：`aria-modal="true"` 的语义与实际行为不符（读屏用户会被告知"模态"，却仍能 Tab 到背景的连接列表）；主机密钥弹窗是安全敏感操作，却只能靠鼠标关掉。

**修法（最小改动优先）**：

1. `HostKeyDialog.tsx` 复制 `ConnectionForm.tsx:41-47` 的 Esc 监听（→ `onCancel`），并给「信任新密钥并连接」按钮加 `autoFocus`（3 行，建议本轮就做）。
2. 抽一个 `useModalFocus(ref)`：打开时记录 `document.activeElement`、聚焦容器内首个可聚焦元素、Tab 在容器内循环、卸载时 `previouslyFocused.focus()`；在两个弹窗各调一次（约 30 行，可下一轮做）。
3. 弹窗打开期间给 `<main>` / `<aside>` 加 `inert`（React 19 支持 `inert` 属性）。

### C3 中｜"已连接"行的悬停态失效，且浮层底色与实际行底色不一致

**现象（证据）**：

- `main.css:364-366` `.conn-item:hover { background: var(--row-hover) }` 与 `main.css:369-374` `.conn-item.session-active { background: var(--accent-soft) }` **特异性相同（0,2,0）**，后者在文件里更靠后 → 已连接行悬停时行底色不变，**没有任何悬停反馈**。
- `main.css:371` 把 `--row-hover` 重定义为 `#2d3952`，注释写"accent-soft 叠加在 bg-hover 上的近似色，用于悬停态保持一致"，`:443` 用它做浮层底色。**这个色值算得没错**（accent-soft(0.14) over `--bg-hover` `#232936` 精确等于 `#2d3952`），问题在于它的**前提没成立**：因为上一条的特异性问题，已连接行悬停时底色并没有变成 `--bg-hover`，仍停留在 accent-soft over 侧栏底 = **`#1e273b`**（截图 04 实测，预测值 `#1f273b`）。两个色值的对比度是 **1.29:1** → 悬停已连接行时，行右侧会出现一块明确更亮的浮层矩形。

**影响**：用户悬停已连接（正在使用）的连接想看操作按钮时，会看到一块"贴上去的"色块，同时整行没有任何"我正指着这一行"的反馈。这是本轮"操作按钮浮层"改动的残留：注释推导的是"悬停→行变亮"的理想态，但那条 hover 规则被后面的规则盖住了。

**修法（1 行，让注释成立）**：在 `main.css:374` 后补一条提高特异性的规则，把理想态真正落地：

```css
/* 悬停时行底色升到 --row-hover；该值在 .session-active 下正是 accent-soft over bg-hover，
   与 .conn-actions 的浮层底色一致，既补上悬停反馈，也消掉浮层色块 */
.conn-item.session-active:hover { background: var(--row-hover); }
```

（若希望浮层/行底色更贴近"accent-soft 叠在行自身底色上"的观感，再考虑 `color-mix(in srgb, var(--accent) 14%, var(--bg-hover))`；但仅补上面这条 1 行规则即可同时解决"没有悬停反馈"与"色块不匹配"两个问题。）

### C4 中｜SFTP 选中行悬停时丢失选中底色（特异性倒挂）

**现象（证据）**：`main.css:933-935` `.sftp-row.clickable:hover { background: var(--bg-hover) }` 特异性 (0,3,0)，`main.css:937-940` `.sftp-row.selected { background: var(--accent-soft) }` 只有 (0,2,0) → **hover 覆盖 selected**：鼠标移到已选中的行上，背景从 accent 淡蓝变成中性灰 `#232936`（只剩左侧 2px accent 条还在）。

**影响**：选中态在悬停瞬间"消失"，用户会怀疑是不是点掉了选中；与 VS Code / 资源管理器的行为相反。

**修法（1 行）**：`main.css:933` → `.sftp-row.clickable:not(.selected):hover { background: var(--bg-hover); }`。

### C5 中｜连接项悬停时，浮层压住主机名尾部（5/6 行都会发生）

**现象（证据）**：`.conn-actions`（`main.css:434-447`）是绝对定位浮层，宽 = 4×26 + 3×2 + padding-left 10 = **120px**，右内缩 6px；行宽 256px（272 − 2×8），故浮层左沿在**绝对 x≈137**。截图 02 实测各主机行文字右沿：`173 / 153 / 153 / 134 / 147 / 160` → **6 行里有 5 行**在悬停时被浮层盖住 10–36px（即 `:22` 或 IP 末段），且浮层底色与悬停行底色相同，视觉上是"按钮字符直接叠在主机名字符上"。

**影响**：用户恰恰是在悬停（准备点编辑/删除/复制）的那一刻读不到完整的 `user@host:port`，而删除是不可逆操作——"我要删的是 10.20.0.11 还是 10.20.0.1？"这个信息在关键瞬间被遮住。同时 `.conn-main` 的 tooltip 是 `打开终端：{label}`（`ConnectionList.tsx:137`），不含主机，无法作为兜底。

**修法（1–2 行，最低风险）**：`main.css:443` 把浮层底色改为左侧渐隐，让被压住的文字淡出而不是硬切：

```css
background: linear-gradient(90deg, transparent 0, var(--row-hover) 14px);
```

（`padding-left: 10px` 提到 `16px`，保证按钮下方仍是实底。）另建议 `ConnectionList.tsx:137` 的 title 补上主机：`` title={`打开终端：${label}（${vo.username}@${vo.host}:${vo.port}）`} ``。

### C6 中｜右键菜单不接收焦点，且无 `role="menu"`

**现象（证据）**：`TerminalContextMenu.tsx:90-110` 渲染的是普通 `div` + `button`，没有 `role="menu"` / `role="menuitem"`，打开后不把焦点移入（`TerminalView.tsx:407-419` 只挂载组件），因此 ↑/↓/Enter 都不能操作菜单，Tab 会跑到菜单之外。关闭时机做得很完整（`TerminalContextMenu.tsx:56-77`：点击外部、Esc、滚动、滚轮），贴边收拢也做了（`45-53`）。

**影响**：菜单是"鼠标专属"控件。键盘用户只能改用终端内等价快捷键（`TerminalView.tsx:265-291` 的 Ctrl+Shift+C / Ctrl+Shift+V / Ctrl+F），功能不缺，但控件本身不可操作；读屏用户听到的是一串无角色的按钮。

**修法**：容器加 `role="menu"`、按钮加 `role="menuitem"`，`useLayoutEffect` 里对第一个 `[role=menuitem]:not(:disabled)` 调 `focus()`，并处理 ↑/↓ 循环与 Enter（Esc 已有）。若判定为"鼠标专属、键盘走快捷键"的取舍，请在代码注释里写明，避免后续被反复提出。

### C7 低｜4 个图标按钮的可见性靠 hover，但常驻在 Tab 序里

**现象（证据）**：`main.css:434-452` 的操作浮层 `opacity: 0`，按钮仍是可聚焦元素；`main.css:665-669`、`976-980` 同理。Tab 序实测推算：6 个连接 = 6×5 = 30 个停留点。

**影响**：键盘用户在侧栏要按 30 次 Tab 才能走到标签栏；虽然 `:focus-within` 会让按钮显现（这点做得对，不能去掉），但缺少"跳到列表"或"行内操作合并"的路径。

**修法（可选）**：给每行的 4 个操作加一个"更多"聚合按钮（`⋯`）把 Tab 序从 5 降到 2；或给列表加 `role="list"` 的 roving tabindex（↑/↓ 在行间移动）。属于增强项，不做也不算缺陷。

### C8 低｜表单校验不标注出错字段

**现象（证据）**：`ConnectionForm.tsx:63-70` 校验失败只 `setError('主机与用户名不能为空')`，`220` 行在表单底部渲染一条 `.form-error`；出错的 input 没有 `aria-invalid`、没有 `aria-describedby`，也不聚焦到出错字段。视觉上输入框没有错误态（`main.css:196-200` 只有 focus 态）。

**影响**：读屏用户听到一条错误却不知道是哪个控件；视觉用户要自己找（本表单 6 个字段，主机与端口还在同一行）。

**修法**：给 host/username 的 input 加 `aria-invalid={Boolean(error)}`，校验失败时 `hostRef.current?.focus()`；`main.css:196` 附近加 `input[aria-invalid='true'] { border-color: var(--danger); }`。

### C9 低｜Toast 容器可点击但不可聚焦

**现象（证据）**：`Toast.tsx:18-24` 是带 `onClick` 与 `title="点击关闭"` 的 `div`，`main.css:1303` 还给了 `cursor: pointer`，但没有 `tabIndex` / 键盘处理；右侧「×」是真实 `button`（`Toast.tsx:26-36`）可以 Tab 到。

**影响**：低——键盘用户有替代路径（× 按钮），但"看起来能点、Tab 却到不了"是不一致。

**修法**：容器加 `tabIndex={0}` + `onKeyDown`（Enter/Escape → onClose），或去掉容器的 `cursor: pointer`/`title`，只保留按钮关闭。

### C10 低｜原生 `window.confirm` 与深色界面不一致，且阻塞渲染进程

**现象（证据）**：`App.tsx:435`（删除连接）、`SftpPanel.tsx:333`（删除远程文件）用 `window.confirm`。Electron 的 `window.confirm` 走系统对话框样式（浅色、系统字体），与应用内其它确认（`HostKeyDialog` 的深色弹窗）完全不同；它同时会阻塞渲染进程。

**影响**：删除是高频操作，每次都会弹出一个风格迥异的系统框；与"界面刚做完统一"的观感落差明显。

**修法**：复用模态样式做一个 `ConfirmDialog`（`HostKeyDialog` 已是现成骨架：`main.css:1090-1172` 的 mask/modal/head/body/foot）。可下一轮做，属观感问题而非功能问题。

---

## D. 边界与响应式

### D1 中｜最小窗口 780×520 本轮没有任何实测证据

**现象（证据）**：`ui-shot.cjs:57` 的窄视口常量是 `NARROW_VIEWPORT = { width: 1024, height: 680 }`，任务描述里要求覆盖的最小窗口是 780×520。10-narrow.png 实测尺寸确为 1024×680。也就是说：**比目标最小尺寸大 27%（宽度）/ 31%（高度）**，本轮无法对"最小窗口是否溢出/截断"给出实测结论。

**修法**：`ui-shot.cjs:57` 增加一档 `MIN_VIEWPORT = { width: 780, height: 520 }` 并补第 11 张截图（或把 10-narrow 改成 780×520 另存 11-min）；同时在截图步骤里加断言 `document.documentElement.scrollHeight <= window.innerHeight + 1`（见 D4）。

### D2 中｜780×520 的解析测算：标签栏溢出约 60px，且没有可见的滚动提示

**现象（计算值，依据截图实测几何）**：780 窗口下工作区宽 = 780 − 272 = 508，标签栏可用内容宽 = 508 − 16 = 492。4 个标签实测占位 x=280..831（绝对坐标，含每个标签为「×」预留的 28px），即 **551px** → **溢出约 59px**；门槛约为窗口宽 840px。而 `main.css:565-571` 是 `overflow-x: auto` + `::-webkit-scrollbar { height: 0 }` → 溢出的标签既看不到滚动条，也没有左右按钮或下拉列表，鼠标用户若没有横向滚轮就点不到第 4 个标签。10-narrow（1024）下未溢出，所以这个问题只在更窄的窗口暴露。同类风险：SFTP 固定列宽合计 96+136+104+3×12 = **372px**，780 下名称列只剩 508−28−372 ≈ **107px**（约 13 个半角字符就被省略号截断）。

**修法**：

1. `main.css:569-571` 把标签栏滚动条从 `height: 0` 改成可见的 6px（或加左右滚动按钮 / 标签溢出下拉）。
2. 允许标签先压缩再滚动：`main.css:577` `flex: 0 0 auto` → `flex: 0 1 auto`，`main.css:578` 之后补 `min-width: 96px`。
3. 窄宽下隐藏「修改时间」列：`@media (max-width: 900px) { .sftp-head .col-time, .sftp-row .col-time { display: none } }`（同时把 `.col-actions` 的 104px 收窄到 72px）。
4. 按 D1 补 780×520 截图。

其余边界测算（均未发现问题）：弹窗 460px 宽 + 遮罩左右 24px = 508，恰好比 507 多 1px，但 `main.css:1115` 的 `max-width: 100%` 会把它压到 459px，不会溢出；弹窗 88vh = 458px < 表单实测内容高 537px → `main.css:1160` 的 `overflow-y: auto` 生效，属设计内滚动。

### D3 低｜长文本表现良好，仅一处需要注意

**现象（证据）**：连接名与主机行 `ellipsis` 生效（02 实测最长主机行到 x=173，未触界）；SFTP 文件名 `ellipsis` 生效；标签标题 `max-width: 220px` + `ellipsis`（`main.css:579/605-610`）；Toast 文案 `word-break: break-word`（`main.css:1328`）实测 78 字错误信息正常折成 2 行（09）；空态说明 `max-width: 460px` 折成 2 行居中。唯一注意点：`.ctx-menu { min-width: 172px }`（`main.css:803`）是固定值，快捷键文案写死在 `TerminalContextMenu.tsx:93/97/105`，未来加更长的组合（如 `Ctrl+Shift+S`）会撑宽菜单——不构成缺陷。

### D4 低｜窄窗口下 Toast 会压住侧栏底部

**现象（证据）**：`.toast`（`main.css:1283-1293`）用 `left: 50% + translateX(-50%)` 按**视口**居中，宽度上限 `min(640px, 70vw)`。09 实测（1360 宽）：提示条 x=359..1000、宽 642、中心 679.5 = 视口中心（工作区中心是 816），完全落在工作区内，观感正常。但 780 宽时 `70vw = 546` → x≈117..663，侧栏右界 272 → **覆盖侧栏底部 155px**（最后一个连接项的操作按钮 + 页脚计数）；1024 宽时 x≈192..832，覆盖 80px。

**影响**：窄窗口下报错提示会挡住侧栏底部的连接项与页脚，持续 8 秒（`App.tsx:105`）。评级低是因为只在窄窗口 + 提示可见期间发生，且 Toast 是 App 级提示。

**修法**：`main.css:1285-1288` 改为相对工作区居中 `left: calc(272px + (100% - 272px) / 2)`；或保守做法——把宽度上限与侧栏解耦：`max-width: min(640px, calc(100vw - 272px - 32px))`（此时仍居中，但更窄，压住侧栏的宽度随之减少）。

### D5 待复核｜脚本注释记录的"1024×680 时页面高 853"

**现象（证据）**：`ui-shot.cjs:1012-1014` 的注释写着"窄视口下内容一旦溢出（例如 1024x680 时页面高 853）"，而 `main.css:87` 是 `body { overflow: hidden }` → 溢出的 173px 既不可滚动也不会显示滚动条。我在 10-narrow.png 的像素里**没有找到被裁掉的内容**（终端底色一直延伸到 y=678，最后 1px 才是工作区底 `#171a22`），因此无法定位具体溢出元素。

**修法**：在 ui-shot 脚本里加一条断言把这件事钉住（`document.documentElement.scrollHeight`、`document.body.scrollHeight` 与视口高对比），下一次跑图时即可确认是否仍然存在；若存在，用 `document.querySelectorAll('*')` 找 `getBoundingClientRect().bottom > innerHeight` 的元素打印出来。

---

## E. 细节打磨

### E1 中｜工作区顶部有一条 44px 的**空标签栏**

**现象（证据）**：`WorkspaceTabs.tsx:35-41` 无条件渲染 `<TabBar>`，即使 `tabs.length === 0`。像素实测（01-empty 与 02-connections 同样）：工作区 x=272..1360、y=0..43 全部是 `--bg-sidebar` `#12141b`，y=43 是一条 `#21252e` 分隔线，y=44 起才是 `#171a22` —— 一条**什么内容都没有、但有色差和分隔线**的工具栏条。副作用：空态内容因此相对整窗中心下移（实测内容 y=400..508、中心 454；整窗中心 430；若按 panes 中心算则是 452 —— 因为 panes 被这条空条下推了 44px）。

**影响**：第一眼看 01-empty 时，最上方那条深色带会让人以为"这里本来该有东西、没渲染出来"；空态也没有真正居中。

**修法**：`WorkspaceTabs.tsx:35` 改为条件渲染 `{tabs.length > 0 && <TabBar … />}`（空态自动回到真正居中）；若希望保留这条作为状态栏，就在里面放一行居左占位文案（如"没有打开的会话"）。

### E2 低｜图标按钮的可访问名不一致

**现象（证据）**：侧栏连接项的 4 个按钮同时有 `title` + `aria-label`（`ConnectionList.tsx:149-180`，做得很规范）；但 SFTP 工具栏「↑」（`SftpPanel.tsx:461-468`）、行内「↓/✎/×」（`SftpPanel.tsx:588-623`）、搜索栏「↑/↓/Aa/×」（`TerminalSearchBar.tsx:130-156`）只有 `title`；Toast 的「×」（`Toast.tsx:26-36`）连 `title` 都没有。其中 `Aa` 作为可访问名完全不可读（会读成"字母 A 字母 a"）。

**修法**：给上述按钮补 `aria-label`（`Aa` → `aria-label="区分大小写"`；Toast → `aria-label="关闭提示"`）；顺手给 SFTP 行内按钮沿用侧栏的措辞风格（`aria-label={\`下载 ${entry.name}\`}`）。

### E3 低｜`prefers-reduced-motion` 未覆盖终端光标闪烁

**现象（证据）**：`main.css:1352-1359` 用 `animation-duration/transition-duration: 0.001ms !important` 覆盖了全部 CSS 动效（含 `main.css:532` 的 spinner、`1099/1122/1304` 的入场动画），做得完整。但 xterm 的光标闪烁在 Canvas 里，由 `TerminalView.tsx:222` 的 `cursorBlink: true` 控制，CSS 管不到。

**修法**：`TerminalView.tsx:221-222` 改为 `cursorBlink: !window.matchMedia('(prefers-reduced-motion: reduce)').matches`（并订阅变化），或在设置里给开关。

### E4 低｜悬停不产生布局跳动（这是优点，见"保持不变的优点"，此处只记一处例外）

**现象（证据）**：全部悬停效果都用透明度或背景/描边切换实现——`main.css:434-447`（浮层 absolute + opacity）、`644-669`（tab 图标 opacity）、`970-980`（行内操作 opacity）、`133-158`（按钮边框常驻 1px transparent + 改颜色）。**未发现任何 hover 引起的尺寸/位置跳动。** 唯一例外是 `.icon-btn:hover` 时 `border-color` 从 transparent 变成 `--border`（`main.css:476-480`），因为边框宽度恒为 1px，也不跳动。

**结论**：无需修改，记入优点。

### E5 低｜双击 SFTP 文件名会同时选中文字

**现象（证据）**：`SftpPanel.tsx:574-582` 的 `.sftp-name` 是 `<button>`，行上又有 `onDoubleClick`（`549-553`）→ 双击文件名既触发"进入目录/下载"，又触发浏览器默认的文本选择，行上留下蓝色选区。

**修法**：`main.css:982-994` 的 `.sftp-name` 加 `user-select: none`（标签栏已有同样处理：`main.css:586`）。

### E6 低｜原生 `title` 承担了全部悬停说明

**现象（证据）**：全应用的悬停说明都靠 `title`（连接项、所有图标按钮、SFTP 按钮、标签）。原生 tooltip 的延迟（约 1s）、字体与配色由系统决定，在深色界面里是浅色气泡。

**修法**：接受现状（成本最低）；若要做统一视觉，可基于 `data-tip` + `::after` 实现轻量 tooltip，但会引入定位与遮挡问题，建议排在最后。

### E7 低｜`Ctrl+R` 会重载应用并丢掉所有会话（默认菜单未拦截）

**现象（证据）**：`src/main/index.ts:102` 只设了 `autoHideMenuBar: true`，没有自定义 `Menu`，因此 Electron 默认菜单的 View → Reload（Ctrl+R）/ Force Reload（Ctrl+Shift+R）仍然生效。渲染进程重启即丢失所有终端与 SFTP 会话（会话状态只存在 `App.tsx` 的内存里）。而 SFTP 面板用 F5 做刷新（`SftpPanel.tsx:422-425`），用户很容易顺手按 Ctrl+R。

**修法**：`src/main/index.ts` 加一个最小自定义菜单（去掉 Reload/Force Reload，或把它们改绑到需要确认的动作）。属主进程范畴，本轮仅记录。

---

## 保持不变的优点（下一轮修改时请勿破坏）

1. **令牌化骨架是对的**：三层表面 + 描边 + 文本 + 语义色 + 圆角/阴影/焦点环/字体/动效时长（`main.css:10-66`）。`--text` 10.5–15.8:1、`--text-muted` 4.9–7.4:1、`--accent` 4.7–7.1:1 全部达标，只有 `--text-faint` 一档不达标（B2）。**不要因为修 B2 就整体调亮**——`--text-muted` 与 `--accent` 的层次现在正好。
2. **连接列表的信息结构**：主名（13px/600/`--text`）+ 主机行（等宽 11px/`--text-muted`）+ 已连接绿点（`main.css:401-430`），实测对比度 15.26:1 / 7.14:1。对照 `before/02-connections.png`：旧版名称被截成「生产 Web 服…」、快速连接说明被截成「…用 Z…」，现在两者都完整——这是本轮最扎实的改进之一。
3. **SFTP 表与数据严格对齐**：表头「名称」与文件名左沿同为 x=312，大小列右沿 1081/1082 齐平，修改时间左沿 1094 齐平（`main.css:917-920` 的 26px 让位算法有效）；行高恒定 32px；数字列 `tabular-nums` + 右对齐（`main.css:947-960`）。
4. **弹窗内部节奏严格**：字段 label→input 间距 20px、字段间 50px、每字段块 70px，6 个字段完全等距（实测行带间距 `[57, 20, 50, 20, 50, 20, 50, 20, 50, 20, 50, 20]`）；页脚右对齐、主按钮（`--accent` 底 + `--accent-ink` 字 = 6.94:1）与次按钮主次分明。
5. **交互态基线覆盖扎实**：按钮 hover/active/disabled/focus-visible 四态齐全（`main.css:133-167`），输入框 hover/focus（`191-200`），`:focus-visible` 只给键盘、鼠标点击不出光环（`123-131`）——这是很多项目做不对的细节。
6. **悬停零布局跳动**（见 E4），并且图标按钮默认隐藏但 `:focus-within` 会显现（`main.css:449-452`、`665-669`、`976-980`），键盘用户不会遇到"焦点落在看不见的按钮上"。
7. **危险操作有防护**：删除二次确认（`App.tsx:435`、`SftpPanel.tsx:333`）、主机密钥变更用专门的核对弹窗并排展示新旧指纹（`HostKeyDialog.tsx:44-53`），且重试时沿用原入参（`App.tsx:259-273`）。
8. **动效克制**：`--duration: 120ms`（`main.css:65`）统一，入场动画 120–160ms，并完整尊重 `prefers-reduced-motion`（`1352-1359`）。
9. **标签栏三重编码**：圆点颜色（绿/红/蓝）+ 种类符号（`>_` / `⇅`）+ 标题（`TabBar.tsx:49-54`），比 `before/07-sftp.png` 里每个标签都写「终端 / 文件」文字徽标省空间得多，且颜色不是唯一区分手段。
10. **空态可行动**：三条快捷键提示 + 明确的下一步（`WorkspaceTabs.tsx:62-79`），比旧版只有两行说明更有用。
11. **终端侧的技术细节**：输出按 sessionId 精确路由、首屏输出缓冲回放（`App.tsx:44-57/133-155/168-178`）、非激活标签不 fit 尺寸避免 0 尺寸测量（`TerminalView.tsx:346-372`）、全局快捷键在终端内拦截但不阻止冒泡（`TerminalView.tsx:253-263`）——这些都不是视觉问题，但决定了界面"用得下去"，改动时不要误伤。

---

## 刻意取舍（我判定不算缺陷，附理由与替代方案）

| 取舍 | 现状 | 我的判断 | 若真要动 |
|---|---|---|---|
| 侧栏固定 272px（`main.css:235`） | 780 窗口下占 35% | **保留**。272 = 名称 + 主机 + 4×26 操作按钮 算出的最小可用宽度；实测最长主机行 x=173、浮层左沿 x=137，正好卡住不重叠（C5 的遮挡是"悬停瞬间"的问题，不是宽度不够） | 若要动，用 `clamp(240px, 30vw, 272px)`，但会让操作按钮浮层更早压住主机名 |
| 终端深色底 + 10/12px 内边距（`TerminalView.tsx:236`、`main.css:694`） | 终端底 `#15181f` 对工作区底 `#171a22` = **1.02:1** | **保留深色底**，但"屏幕"层次实际几乎不可见，那 12px 留白读起来像无意义的空隙 | 二选一：① 给 `.terminal-host` 加 `border-radius: var(--radius)` + `overflow: hidden`（与全局圆角语言一致）；② 收掉 padding 让终端铺满面板。当前"有留白但看不出边框"是三者里最弱的一种 |
| 图标按钮悬停才出现（`main.css:434-452`、`970-980`） | 默认 opacity 0 | **保留**（比旧版常显好得多，对照 `before/07-sftp.png`：旧版每行常驻 ↓✎× 噪声很大）。代价是 Tab 序变长（C7）与浮层遮挡（C5） | 若要降低 Tab 序，加"更多 ⋯"聚合；不要改成常显 |
| Toast 按视口居中（`main.css:1285`） | 1360 下中心 679.5，工作区中心 816 | **保留**（App 级提示，视口居中符合预期，1360 下完全落在工作区内） | 仅窄窗口有问题（D4），可按 D4 的方案处理 |
| 快捷键只用 Ctrl 组合（`App.tsx:346-372`） | Ctrl+Tab / Ctrl+Shift+W / Ctrl+N / Alt+1..9 | **保留**，与终端输入冲突最小，且空态有提示 | — |
| 禁用态用 `opacity: .45`（`main.css:164-167`） | 全局统一 | **保留**，一致性优先 | — |
| 低对比描边（B4） | 1.20–1.37:1 | **可接受的暗色取舍**，但请显式写进设计约定 | 折中提 `--border-strong`（1.55–1.70:1） |

---

## 若只能改 5 处

| # | 改什么 | 位置 | 工作量 | 为什么排前面 |
|---|---|---|---|---|
| 1 | 补 `.toast.error` 语义色 | `main.css:1324` 后加 `.toast.error { border-left-color: var(--danger); }` | 1 行 | 错误提示目前与成功/信息完全同色（实测左边框 `#6d9bff`），严重度编码失效；`showToast('error', …)` 是全应用最常用的失败反馈路径 |
| 2 | `--text-faint` 提亮到 `#8b93a3` | `main.css:30` | 1 行 | 一次性把 9 处功能性文本从 3.38–3.98:1 提到 4.72–5.96:1，清除唯一的系统性 WCAG AA 失败 |
| 3 | SFTP 表头列色统一 | `main.css:952`、`959` 加 `.sftp-list` 前缀（或 `912` 改 `--text-muted`） | 2 行 | 同一行表头「名称」3.90:1 与「大小/修改时间」7.14:1 并排，读起来像「名称」被禁用 |
| 4 | 标签栏方向键导航 + 焦点跟随 | `TabBar.tsx:41-47`（配 ref） | ≈8 行 | 补齐 ARIA tabs 模式缺的另一半；当前非激活标签键盘根本到不了 |
| 5 | 连接项浮层左侧渐隐 | `main.css:443`（`background: linear-gradient(90deg, transparent 0, var(--row-hover) 14px)`，padding-left 提到 16px） | 1–2 行 | 6 行里 5 行在悬停时会遮住 `host:port` 尾部 10–36px，恰好是准备点删除/编辑的那一刻 |

**紧随其后（第 6–8 名）**：`HostKeyDialog` 补 Esc + `autoFocus`（3 行，安全敏感弹窗）；空标签条条件渲染（`WorkspaceTabs.tsx:35`，1 行，第一眼就能看出）；`--row-hover` 与 `.sftp-row` 的两处特异性倒挂（C3/C4，共 3 行）。

---

## 素材未覆盖的界面状态（本轮无法目视验证）

以下状态不在 10 张截图里，报告中对它们的判断**全部来自代码与令牌计算**，建议下一轮补图或明确接受风险：

1. `.status-bar`「正在连接 …」（`main.css:512-547`；`App.tsx:463-468`）——accent-soft 铺底 34px 条，是连接过程中唯一的反馈。
2. `.form-error` 表单错误条（`main.css:1233-1241`；08 截图里表单是合法状态）。
3. 主机密钥变更弹窗（`HostKeyDialog.tsx`）——**安全敏感，却没有截图**，其焦点/键盘问题（C2）也因此无法目视确认。
4. `.sftp-drop` 拖拽上传浮层（`main.css:1042-1055`）、`.sftp-progress` 传输进度（`1057-1079`）、行内重命名（`1015-1020`）、新建目录行（`1022-1028`）。
5. 搜索栏「无结果」/「共 N 项」两种计数文案（`TerminalSearchBar.tsx:30-36`）。
6. 所有 hover / focus-visible / disabled 态（截图是静态的，`.conn-actions`、`.tab-icon`、`.col-actions` 的悬停后果只能靠几何推算，见 C3/C5）。
7. 空目录提示「这里没有内容」（`SftpPanel.tsx:628`）、搜索无匹配「没有匹配的连接」（`ConnectionList.tsx:126`）。
8. `.warn-text`「系统安全存储不可用」（`main.css:497-500`；`ConnectionList.tsx:107-109`）。
9. 780×520 最小窗口（见 D1）。

---

## 附：关键测量数据（供复核）

- 截图时间戳：after 全部 2026-11-20 11:34:28–11:34:33；before 11:29:13–11:29:16。
- 视口：01–09 为 1360×860（`ui-shot.cjs:55`）；10 为 1024×680（`ui-shot.cjs:57`）；dpr=1，故 1 像素 = 1 CSS px。
- 背景实测：侧栏 `#12141b`、工作区 `#171a22`、终端 `#15181f`、标签栏 `#12141b`、激活标签/浮层 `#1e222c`、输入框 `#0f1218`、弹窗页脚 `#1a1d26`、已连接行 `#1e273b`（= accent-soft over 侧栏底，预测 `#1f273b`）。
- 几何实测：侧栏 272（右边框 x=271）；标签栏内容区 y=0..43 + 分隔线 y=43；终端内容 x=284..1347、y=55..（左 12px / 上 10px 留白）；连接项行距 59px（行高 57 + gap 2）；SFTP 工具栏 50 / 表头 30 / 行 32，列位 名称 x=312、大小右沿 1081、时间左沿 1094；弹窗 x=451..908（宽 458 + 边框 = 460）、中心 679.5、字段块 70px；右键菜单 172×178，项高 30 + gap 1，分隔线额外 12px；Toast x=359..1000（宽 642）、y=779..838、中心 679.5。
- 引用的像素测量脚本为一次性分析文件，写在系统临时目录（`%TEMP%\ui-review\`），**未落入仓库**。
