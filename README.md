# SSH 客户端

一个可保存连接的跨平台 SSH 客户端，基于 Electron + TypeScript 构建。

## 技术栈

| 层   | 选型                                                      | 说明                                        |
| ---- | --------------------------------------------------------- | ------------------------------------------- |
| 壳   | Electron 38                                               | 三平台共用一套代码                          |
| 构建 | electron-vite 6                                           | 主进程 / preload / 渲染进程统一构建与热更新 |
| 终端 | @xterm/xterm + addon-fit / addon-search / addon-web-links | 渲染、尺寸自适应、搜索高亮与计数、链接识别  |
| SSH  | ssh2                                                      | 纯 JS 实现，同时支撑 shell 与 SFTP          |
| UI   | React 19                                                  | 连接列表、多标签工作区                      |
| 存储 | JSON + Electron safeStorage                               | 配置原子写盘，凭据加密存储                  |

## 目录结构

```
src/
├─ shared/
│  ├─ types.ts            主进程与渲染进程共享的 DTO / VO / IPC 通道常量
│  └─ errors.ts           主机密钥变更等需要跨进程传递的结构化错误编码
├─ main/
│  ├─ index.ts            应用入口，创建窗口与注册 IPC
│  ├─ ipc.ts              IPC 处理器，把入参解析为可用的连接配置
│  ├─ ssh.ts              SSH 连接池、终端会话管理、主机密钥校验与输出批量合并
│  ├─ sftp.ts             SFTP 会话、文件操作、传输进度与断点续传
│  ├─ edit.ts             远程文件编辑：下载到临时目录、系统程序打开、保存后回传
│  ├─ session.ts          会话快照的读写与校验（只落连接 id 与标签类型）
│  ├─ errors.ts           ssh2 / Node 原始错误的中文化翻译
│  └─ store.ts            连接配置持久化、分组与凭据加解密
├─ preload/index.ts       经 contextBridge 暴露的业务 API
└─ renderer/src/
   ├─ App.tsx             根组件，编排连接列表、标签、提示与全局快捷键
   ├─ types.ts            标签与提示条类型
   ├─ utils.ts            错误文案整理与主机密钥变更错误识别
   ├─ theme.ts            深浅色 / 跟随系统主题的读写、应用与订阅
   ├─ terminalPrefs.ts    终端字号偏好的读写、限幅与跨标签广播
   ├─ useFocusTrap.ts     弹窗焦点陷阱与焦点归还
   └─ components/         图标、连接列表、连接表单、标签栏、工作区、终端视图、
                          终端搜索栏、终端右键菜单、SFTP 面板、主机密钥弹窗、
                          会话恢复提示条、主题开关、提示条、错误边界
scripts/                  可独立运行的验证脚本与截图取证脚本
```

## 开发命令

```bash
npm install          # 安装依赖
npm run dev          # 开发模式（热更新）
npm run build        # 类型检查 + 构建产物
npm run build:win    # 打包 Windows 安装包
npm run build:mac    # 打包 macOS
npm run build:linux  # 打包 Linux
npm run lint         # ESLint
npm run typecheck    # 类型检查
```

## 界面设计

界面样式集中在 `src/renderer/src/assets/main.css`，分为「设计令牌 → 基础元素 → 应用骨架 →
侧边栏 → 工作区标签 → 终端 → SFTP → 弹窗 → 提示」若干段，组件样式只引用令牌，不写死颜色与间距。

- **主题**：内置深色与浅色两套令牌（`:root` 与 `:root[data-theme='light']`），支持跟随系统；
  切换入口在侧栏页脚（点击在深浅之间切换，Shift+点击或右键回到跟随系统），选择写入 localStorage。
  主题以 `<html data-theme>` 属性驱动，CSS、滚动条、原生表单控件与 xterm 自己绘制的终端配色
  都跟随同一处状态，新增组件无需接收 theme 参数。
- **颜色**：一套表面层级（`--bg-app` → `--bg-sidebar` → `--bg-surface` → `--bg-raised`）
  加主题色与语义色（`--accent` / `--success` / `--warning` / `--danger` 及各 `-soft` 变体）。
- **字号**：收敛为四档——11（快捷键等辅助等宽小字）/ 12（次要 UI 与说明）/ 13（正文与列表主名）/
  14（区块与弹窗标题）。
- **间距与圆角**：以 4px 为基本节奏（4/6/8/10/12/14/16/18/24），圆角分 `--radius-sm` 6px、
  `--radius` 8px、`--radius-lg` 12px 三档。
- **图标**：统一使用 `components/Icon.tsx` 的线性图标（16 视口、1.5 描边、currentColor），
  不再用字符符号，深浅主题与禁用态自动跟随。
- **对比度**：正文与功能性次要文本在深浅两套主题下都按 WCAG 正文标准（≥ 4.5:1）选定；
  纯描边刻意保持低对比（1.2–1.4:1），以免界面被线条切割得过于零碎。
- **交互状态**：按钮、图标按钮、输入框、标签、列表行、菜单项都有 hover / active / `:focus-visible` /
  disabled 四态；标签栏支持 ← → / Home / End 键盘导航（ARIA tabs 模式），弹窗有焦点陷阱、Esc 关闭，
  关闭后焦点归还原处；悬停出现的行内操作按钮在键盘聚焦时同样出现；动效尊重
  `prefers-reduced-motion`。
- **视觉取证**：`npm run ui:shot` 用 CDP 驱动真实 Electron，把空状态、连接列表、终端、多标签、搜索、
  右键菜单、SFTP、连接表单、提示条、窄窗口等状态截成固定命名的 PNG（输出在 `scripts/ui-shots/`，
  已加入 `.gitignore`），便于改样式后快速比对。开发态若因完整性标签无法启动，可用环境变量
  `E2E_ELECTRON_BIN` 指向 `node_modules/electron/dist` 的副本。

## 快捷键

| 快捷键                      | 作用                                                            |
| --------------------------- | --------------------------------------------------------------- |
| Ctrl+N                      | 新建连接                                                        |
| Ctrl+Tab / Ctrl+Shift+Tab   | 切换到下 / 上一个标签                                           |
| Alt+1..9                    | 直接跳到第 n 个标签                                             |
| Ctrl+Shift+W                | 关闭当前标签（不会把 ^W 发给远端）                              |
| Ctrl+F / Ctrl+Shift+F       | 终端内搜索：Enter 下一个、Shift+Enter 上一个、Esc 关闭          |
| Ctrl+Shift+C / Ctrl+Shift+V | 复制选中 / 粘贴（Ctrl+Insert、Shift+Insert 同样可用，中键粘贴） |
| 在终端里点右键              | 复制 / 粘贴 / 全选 / 查找 / 清屏                                |
| Ctrl+= / Ctrl+- / Ctrl+0    | 放大 / 缩小 / 复位终端字号，本机记忆并同步到所有终端标签        |
| SFTP 列表双击               | 目录进入、文件下载；单击选中，Enter 打开，F5 刷新               |

## 验证脚本

```bash
npm run verify              # 依次运行下面 6 个协议 / 单元脚本
npm run verify:ssh          # SSH 协议链路：连接、shell、PTY 尺寸、UTF-8、窗口变更
npm run verify:store        # 存储安全：密码不明文落盘、凭据更新语义、原子写、损坏降级
npm run verify:sftp         # SFTP：目录浏览、上传下载、增删改、连接复用、进度上报
npm run verify:hostkey      # 主机密钥：TOFU 首连信任、变更拒绝、确认后信任并重连
npm run verify:resume       # 断点续传：中途中断后重试，最终文件逐字节一致
npm run verify:perf         # 终端吞吐：20MB 输出不丢字节、顺序与退出事件时序
npm run verify:e2e          # 端到端：真实 Electron + IPC + safeStorage + 真实 SSH 会话 + 界面交互
npm run ui:shot             # 界面截图取证（CDP 驱动真实 Electron，见「界面设计」）
```

前六个脚本不启动 Electron，可在任意环境运行；`verify:sftp` 会在本地起一个内存文件系统的
SFTP 服务端，因此无需真实的 SSH 服务器。
`verify:e2e` 需要能启动 Electron 图形进程的桌面会话，并会覆盖 `out/` 产物。

最近一轮的验证结论、未覆盖项与已知风险见 `scripts/verify-report.md`。

## 已实现

- 连接配置的新增、编辑、删除、复制与持久化，列表支持按名称 / 主机 / 用户名搜索
- 连接分组：侧栏按分组折叠展示、可批量移动分组
- 密码与私钥口令经 Electron safeStorage 加密，明文不落盘，列表出参不回流凭据；
  编辑连接时按需回显该连接已保存的凭据，并可用输入框右侧的小眼睛切换明文 / 密文显示
- 同一连接的终端标签与 SFTP 面板共享一条 SSH 连接，减少握手与 `MaxSessions` 压力
- 多标签工作区，后台终端持续接收输出，切换不丢回滚缓冲
- 深色 / 浅色 / 跟随系统三态主题，终端配色随之切换
- 终端尺寸自动同步远端 PTY，全屏程序不错行；字号可缩放并跨标签记忆
- 终端内搜索（命中高亮 + 第 n/m 项计数）、复制粘贴、右键操作菜单
- 主机公钥采用 TOFU 校验：首次连接记录指纹，指纹变化时拒绝连接并弹出新旧指纹让用户核对，
  确认后才更新 `known_hosts.json`
- 连接失败给出中文原因（端口未开放、超时、域名解析失败、认证失败、私钥口令错误等），
  并保留原始错误码便于排查
- 会话建立过程有「正在连接 …」状态提示，断开后标签可一键重连
- 会话恢复：退出时记录打开过的标签（只记已保存连接的 id 与类型，绝不落盘凭据），下次启动询问是否恢复
- SFTP 文件管理：单击选中 / 双击打开、路径栏直接输入跳转、上传、下载、重命名、删除、新建目录
- SFTP 拖拽上传、多文件聚合进度、断点续传、列宽拖拽、大目录虚拟滚动，
  以及「用系统默认程序打开远程文件、保存后自动回传」的远程编辑
- 提示条分级（成功 / 信息 / 错误）并自动消失，界面异常有错误边界兜底不白屏
- 配置文件的原子写与损坏降级

## 架构要点

- **凭据不出主进程**：渲染进程只拿到 `ConnectionVO`，密码与私钥内容始终在主进程内解密使用。
- **IPC 按会话 id 路由**：终端与 SFTP 操作都带各自 id，高频读写使用 `send` 而非 `invoke`。
- **连接池按引用计数持有连接**：shell 与 sftp 通道各自占用一次引用，关掉 SFTP 面板不会影响
  仍在使用的终端标签，全部释放后才断开 TCP 连接。
- **终端输出传原始字节**：主进程不把 Buffer 转成字符串，交给 xterm 的 UTF-8 解码器处理跨数据包的
  多字节字符，避免中文乱码。
- **同一事件循环内的输出合并上报**：主进程用 `setImmediate` 把一批到达的分片合并成一次 IPC，
  高吞吐输出（`cat` 大文件等）下明显减少消息数量；关闭会话前会先补齐最后一段数据。
- **首屏输出不丢**：渲染进程按 sessionId 缓冲「终端实例尚未注册写入函数」期间到达的输出，
  注册时按序回放，避免连接太快导致欢迎语丢失。
- **标签切换用显隐而非卸载**：终端实例常驻，避免重建导致的输出错位与历史丢失。
- **主机密钥变更可恢复**：校验失败时把新旧指纹记入待确认表并抛出结构化错误，界面弹窗核对后
  由 `system:trust-host-key` 落盘，既不会静默信任新密钥，也不会把用户堵在无法恢复的错误里。
- **错误统一中文化**：主进程 `errors.ts` 把 ssh2 / Node 的错误码翻译成中文并保留原始错误码，
  渲染进程只需展示。
- **终端数据通道的取舍**：README 曾把「用 `MessageChannelMain` 直连终端数据流」列为待办，
  实测后**没有采用**：本机 20MB 连续输出下，端口路径与 IPC 路径的端到端差异被噪声淹没；
  `setImmediate` 批量合并已经把 20MB 压成 21~32 条消息（4KB 分片 1024 片时仅 5 条），
  而此时纯 ssh2 数据段吞吐约 280~310MB/s、经应用层约 80~140MB/s，瓶颈在 ssh2 自身的
  加解密与包处理，IPC 序列化并非瓶颈；合成压力测试里端口路径在 512KB/64KB 分片下反而慢约 20%。
  测量方法与原始数据见 `scripts/verify-report.md` 的性能章节，`src/main/ipc.ts` 顶部也留了说明。

## 已知限制

- 拖拽上传取的是浏览器给出的本地文件路径，拖入文件夹只会得到目录路径本身，服务端不支持时会提示失败。
- `known_hosts.json` 解析失败时会备份为 `known_hosts.json.bak` 并重新按 TOFU 记录指纹
  （保留现场、不阻断连接），如需更严格策略可改为直接拒绝连接。
- 终端搜索高亮与命中计数使用 xterm 的 proposed API（构造函数里的 `allowProposedApi`），
  升级 xterm 大版本时需要回归一次搜索功能。
- 远程编辑把文件下载到系统临时目录，编辑器采用「写临时文件再改名」时依赖目录监听，个别编辑器
  可能需要手动再保存一次；会话关闭后本地副本保留，便于再次编辑。
- 会话恢复只记录已保存连接的标签，未保存的临时会话不会被恢复。
- 编辑连接会按需回显该连接已保存的凭据，凭据在这一个表单的生命周期内会出现在渲染进程内存里
  （只按连接 id 读取，没有批量接口）；不接受这一点的用户可以让密码框保持原样提交。

## 待办

- 打包签名：macOS 需要签名与公证，Windows 需要代码签名证书（需要相应证书，本机无法完成）
- 多窗口 / 分屏：同一应用内并排查看多台机器
- 终端性能下一步：瓶颈已确认在 ssh2 侧（cipher 选择、背压），而不是 IPC 通道

## Windows 分发

`npm run build:win` 产出：

- `dist/win-unpacked/` —— 免安装目录版，直接运行其中的 `ssh-client.exe`（推荐）
- `dist/ssh-client-<版本>-win.zip` —— 上述目录的压缩包

**刻意不使用 NSIS 安装包与 portable 单文件版**：

- NSIS 安装包在构建时需要实际运行一次生成的 exe 来提取卸载器，受限环境下构建即失败；
- portable 版启动时要先把整个应用自解压到 `%TEMP%` 再执行，这类行为容易被安全软件拦截，
  典型的报错是 `NSIS Error: Error writing temporary file`（文件本身并未损坏）。

两者都不如目录版可靠。确实需要正式安装包时，在普通机器上把 `win.target` 换回 `nsis` 重新打包。

## 环境备注

本机开发环境若设置了 `ELECTRON_RUN_AS_NODE=1`，`electron.exe` 会退化成纯 Node 运行、
无法启动图形界面，需要在该变量未设置的环境下启动应用或运行 `verify:e2e`
（`scripts/e2e-smoke.cjs` 内部会自动剔除该变量）。

## 双击没反应？先看强制完整性标签（重要）

产物是**未签名**的 Electron 应用，但未签名本身并不会阻止它启动（本机实测：Smart App Control
关闭、无 WDAC/AppLocker 策略、CodeIntegrity 无任何阻断事件，未签名程序照常运行）。

真正会让"双击毫无反应"的是产物的**强制完整性标签**（Mandatory Integrity Label）。Windows 的
完整性级别按文件标签继承：若打包发生在带 `Low Mandatory Level` 标签的目录下（例如被 Windows
沙箱打标过的目录 —— 沙箱以受限令牌 + Low 完整性派生进程，它在工作区里新建的文件会继承这个可
继承的 Low 标签），产物中的 `ssh-client.exe` 也会带上该标签。此后即使只是普通双击，Windows 也会
把进程降到 Low 完整性级别；而 Low IL 进程无法为 Chromium 的沙箱子进程在 `%TEMP%`、`%APPDATA%`
这类 Medium 目录上配置 ACL（Chromium 日志原文：`Failed to create network context data directory
… 拒绝访问。 (0x5)`），浏览器进程会在主进程 JS 执行之前以 `0x80000003`
（STATUS_BREAKPOINT）退出。

表现特征：**没有窗口、没有日志、没有崩溃转储**，`%TEMP%` 与 exe 目录下都找不到
`ssh-client-startup.log`，事件日志里也没有 Application Error —— 与"被安全软件静默拦截"极像，
但原因完全不同。

判断方法：

- `icacls dist\win-unpacked\ssh-client.exe` 输出中出现 `Mandatory Label\Low Mandatory Level`；
- 把产物整个目录复制到桌面等普通目录后双击可以正常打开（复制件不再继承该标签）；
- 带 `--no-sandbox` 启动也能打开 —— 因为不再需要为沙箱子进程配置 ACL。

解决方式：

1. **构建侧已自动处理**：electron-builder 的 `afterPack` 钩子（`scripts/after-pack.cjs`）在打包
   目录组装完成后把整棵产物的完整性标签重置为 Medium，并在重置失败时直接让构建失败，避免把
   "双击没反应"的产物发出去；
2. 手工补救：`icacls <产物目录> /setintegritylevel Medium /T /C`；
3. 或者把产物复制 / 解压到普通目录（桌面、`C:\Program Files` 等）再运行。

`--no-sandbox` 同样能启动，但它会关闭渲染进程沙箱，只建议作为排障手段，不要作为常规启动方式。

可用的排查工具（随包分发在应用目录下）：

- `run-debug.bat`：双击即可看到启动日志与退出码；
- `start.bat` / `start.lnk`：带 `--no-sandbox` 的兜底启动器，仅在标签无法重置时使用。

主进程会把启动全过程写入日志，包括未捕获异常与渲染进程加载失败。日志按以下顺序挑选第一个可写
位置：`%TEMP%\ssh-client-startup.log` → `<userData>\startup.log` → exe 所在目录。
