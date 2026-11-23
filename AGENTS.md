# AGENTS.md —— EasySSH 开发指引

面向在本仓库工作的开发者与 AI 代理。**先读本文件，再读 README.md**（README 讲"是什么/怎么用"，本文件讲"怎么改"）。

---

## 1. 项目概览

EasySSH 是一个可保存连接的跨平台 SSH 客户端：多标签终端、SFTP 文件管理、连接分组、会话恢复、
主机密钥校验。桌面壳用 Electron，界面用 React，SSH/SFTP 走纯 JS 的 ssh2。

| 层   | 选型                                                        | 说明                                |
| ---- | ----------------------------------------------------------- | ----------------------------------- |
| 壳   | Electron 38                                                 | 三平台共用一套代码                  |
| 构建 | electron-vite 6 + electron-builder 26                       | 主进程 / preload / 渲染进程统一构建 |
| 终端 | @xterm/xterm 6 + addon-fit / addon-search / addon-web-links | 渲染、自适应、搜索高亮、链接识别    |
| SSH  | ssh2 1.17                                                   | 同一套库支撑 shell 与 SFTP          |
| UI   | React 19 + TypeScript 5.9                                   | 连接列表、多标签工作区              |
| 存储 | JSON + Electron safeStorage                                 | 原子写盘，凭据加密存储              |
| 质量 | eslint 9 + prettier 3 + 自带验证脚本                        | 命令见第 3 节，验证体系见第 9 节    |

**必须记住的四条设计约束**（改动前先确认没有违反）：

1. **凭据不出主进程**：渲染进程只拿 `ConnectionVO`，密码/私钥内容始终在主进程内解密使用；
   列表出参不回流凭据。唯一例外是「编辑连接按需回显」（`conn:credential`，按连接 id 单独读取）。
2. **连接池按引用计数**：同一连接的终端标签与 SFTP 面板共享一条 SSH 连接，
   shell 与 sftp 各占一次引用，全部释放后才断开。
3. **终端输出传原始字节**：主进程不把 Buffer 转字符串，交给 xterm 的 UTF-8 解码器处理跨包多字节字符；
   `setImmediate` 批量合并上报（已评估并否决 MessageChannelMain 方案，见 README）。
4. **主机密钥变更可恢复**：校验失败时记入待确认表并抛结构化错误，用户核对后由
   `system:trust-host-key` 落盘，绝不静默信任新指纹。

---

## 2. 目录地图

```
src/
├─ shared/types.ts        主进程与渲染进程共享的 DTO / VO / IPC 通道常量（契约唯一来源）
├─ shared/errors.ts       需要跨进程传递的结构化错误编码（如主机密钥变更）
├─ main/
│  ├─ index.ts            入口：单实例、日志、更名数据迁移、窗口创建
│  ├─ ipc.ts              IPC 处理器：把入参解析为连接配置，注册全部通道
│  ├─ ssh.ts              连接池、终端会话、主机密钥校验、输出批量合并
│  ├─ sftp.ts             SFTP 会话、文件操作、上传冲突处理、传输进度与断点续传
│  ├─ edit.ts             远程编辑：下载到临时目录、系统程序打开、保存后回传
│  ├─ session.ts          会话快照读写（只落连接 id 与标签类型）
│  ├─ migrate.ts          应用更名后的数据目录迁移与加密主密钥自检
│  ├─ errors.ts           ssh2 / Node 错误 → 中文文案
│  └─ store.ts            连接与分组持久化、凭据加解密
├─ preload/index.ts       contextBridge 暴露的 window.api（唯一渲染进程出入口）
└─ renderer/src/
   ├─ App.tsx             根组件：连接列表、标签、提示条、会话恢复、全局快捷键、侧栏宽度
   ├─ terminalPrefs.ts    终端字号偏好（读写、限幅、跨标签广播）
   ├─ theme.ts            主题模式读写与应用
   ├─ useFocusTrap.ts     弹窗焦点陷阱与焦点归还
   └─ components/         ConnectionList / ConnectionForm / TabBar / WorkspaceTabs /
                          TerminalView / TerminalSearchBar / TerminalContextMenu /
                          SftpPanel / HostKeyDialog / SessionRestoreBar / ThemeToggle /
                          Toast / ErrorBoundary / Icon
scripts/                  验证脚本（可独立运行）、e2e、截图取证、构建后处理、报告
build/                    打包资源（图标、启动器 .bat、运行说明.txt、entitlements）
```

数据目录：`%APPDATA%\EasySSH\`，里面有连接 `connections.json`、分组 `groups.json`、
已知主机 `known_hosts.json`、会话快照 `session.json`，以及 Chromium 的 `Local State`。
**`Local State` 存着 safeStorage 主密钥，迁移数据目录时绝不能漏**，
否则密码密文解不开（表现为"编辑不回显密码"+"连接认证失败"）。

---

## 3. 环境与常用命令

前置：Node 20+（本机验证版本 24.13）、npm。Windows 上的打包与快捷方式生成依赖 PowerShell。

```bash
npm install                # 依赖安装（postinstall 会准备 electron 与原生依赖）

npm run dev                # 开发模式（热更新）
npm run typecheck          # 类型检查（node + web 两份 tsconfig）
npm run lint               # eslint（带缓存）
npm run format             # prettier 格式化

npm run verify             # 7 个协议/单元脚本，串行，不启动 Electron
npm run verify:e2e         # 真实 Electron 打包产物 + 真实 SSH 会话的端到端（283 项）
npm run ui:shot            # 界面截图取证（18 张 + 高DPI/拖拽/对比度检查）

npm run build              # typecheck + electron-vite 构建到 out/
npm run build:unpack       # 免安装目录版 dist/win-unpacked
npm run build:win          # 目录版 + zip，并做打包后处理（见下）
```

**环境怪癖（踩过的坑）**

- 本机若设置了 `ELECTRON_RUN_AS_NODE=1`，`electron.exe` 会退化成纯 Node、开不了窗口；
  启动应用或跑 e2e 前要清掉（e2e 脚本内部已自动剔除）。
- 开发态 `electron.exe` 可能带 Low 完整性标签：截图/e2e 需要把 electron 复制到 `%TEMP%`，
  用 `E2E_ELECTRON_BIN` 指过去。
- **强制完整性标签**：产物带 `Low Mandatory Level` 时双击会以 `0x80000003` 静默退出（无窗口、无日志）。
  `build:win` / `build:unpack` 末尾会跑 `scripts/fix-dist.cjs`：删除 zip 暂存目录、把标签重置为
  Medium 并逐个校验 exe；校验失败会直接构建失败。手工修：`icacls "<目录>" /setintegritylevel Medium /T /C`。
- **端口独占**：verify 脚本用 2222；`ui-shot.cjs` 用 2323/9455。不要并发跑多个会起测试服务的脚本。
- 构建前先确认没有残留的 `EasySSH.exe` / `electron` / `7za` 进程，否则会出现 `EBUSY` 或
  0 字节的 zip（7za 尚未写完）。

---

## 4. 代码约定（提交前自查）

**语言与注释**

- 沟通、文档、代码注释、提交信息一律**中文**。
- 对外方法写 JSDoc：作用、入参（`@param`）、出参（`@returns`）；复杂逻辑用单行注释说明"为什么"。

**接口层**

- 对象入参必须单独定义 DTO，响应必须用 VO；禁止把实体类或其继承者直接当入参/出参。
- **契约改动三件套必须同时改**，缺一个就会出现类型或运行时不一致：
  1. `src/shared/types.ts`（DTO/VO + `IPC` 通道常量 + `SshClientApi` 声明）
  2. `src/preload/index.ts`（`ipcRenderer.invoke/send` 桥接）
  3. `src/main/ipc.ts`（`ipcMain.handle` 处理器）
- 高频数据流（终端输出、进度）用 `send` 广播，不用 `invoke`。

**UI 与样式**

- 颜色、间距、圆角、字号全部走 `src/renderer/src/assets/main.css` 的 CSS 变量/令牌，**不要硬编码色值**。
- 深浅色两套主题都要能看；正文文本对比度 ≥ 4.5:1；间距按 4px 节奏；字号只用 11/12/13/14 四档
  （终端字号除外，它由用户缩放控制）。
- 弹窗：复用 `.modal-mask/.modal/.modal-head/.modal-body/.modal-foot` + `useFocusTrap`；
  **遮罩关闭必须满足"按下与松开都落在遮罩本身"**（否则在输入框里拖选文字会误关弹窗）。
- 图标按钮要有 `title` 与 `aria-label`；列表项、分组行要键盘可达（方向键/Enter）。

**终端相关**

- `new Terminal({ ... })` 必须保留 `allowProposedApi: true`（搜索高亮依赖 proposed API）。
- `attachCustomKeyEventHandler` 返回 `false` 表示"不要让 xterm 把按键发给远端"，
  仅用于 App 级快捷键；普通按键必须放行（历史上"空格打不出来"就落在这条路径上）。
- 终端缩放：`Ctrl+=` / `Ctrl+-` / `Ctrl+0` / `Ctrl+滚轮` 与右键菜单都要保持可用。

**SFTP 相关**

- 上传遇到同名文件**默认不覆盖**：不传 `conflictAction` 时同名文件只进 `conflicts`，
  由界面询问（取消 / 覆盖 / 备份后上传）；备份名为「原文件名.日期」。
- 本会话存在匹配断点记录（本地路径一致且远端长度等于断点字节数）时直接续传，不进冲突流程。
- 备份后上传失败必须回滚（清半成品 + 备份改回原名 + 清断点）。

**其它**

- 优先复用已有类型、工具函数与组件；只对真正复杂的逻辑抽私有方法，不做多余封装。
- 不做过度校验；错误文案要能指导用户下一步操作（沿用 `main/errors.ts` 的中文化风格）。

---

## 5. 开发新功能的流程

| 步骤 | 做什么                                                                           | 产出/标准                             |
| ---- | -------------------------------------------------------------------------------- | ------------------------------------- |
| 0    | 读 `AGENTS.md` + `README.md`，定位相关模块与现有实现                             | 能说清改动会碰到哪些文件              |
| 1    | 明确需求与验收标准（用户视角的可观察结果）                                       | 一句话验收标准，含边界与不做的事      |
| 2    | 设计：优先**改动最小、风险最低、易回滚**的方案；跨进程改动先冻结契约             | 契约清单（types/preload/ipc）+ 影响面 |
| 3    | 实现：契约 → 主进程 → 渲染进程 → 样式，小步提交                                  | 每个提交能独立说明一个功能点          |
| 4    | 自测：`npm run typecheck && npm run lint && npm run format`，再跑相关 `verify:*` | 全绿；UI 改动自己先看一眼             |
| 5    | 独立验证：为改动补断言（`scripts/verify-*.cjs`）与必要的 e2e/截图用例            | 断言可复现、失败会非零退出            |
| 6    | 文档：更新 `README.md`（面向用户）与 `scripts/verify-report.md`（面向维护者）    | 行为变化有文字记录                    |
| 7    | 提交：中文、按类型前缀小步提交；**未经用户明确要求不要 push**                    | 见第 8 节                             |

**契约先行的例子**：要新增一个 IPC，先在 `types.ts` 定义 `XxxDTO` / `XxxVO` / 通道常量与
`SshClientApi` 方法，再补 preload 与 ipc.ts，最后写渲染进程调用——这样三层不会各写一套。

---

## 6. 修复 bug 的流程

1. **复现**：先拿到证据，不要凭猜测改代码。日志在 `%TEMP%\easyssh-startup.log`（启动/主进程异常）
   与 `e2e-electron.log`（e2e 期间）；界面问题用 CDP/截图留现场。
   日志里若连"主进程开始执行"都没有 → 进程在 Chromium 初始化阶段就被拦截（见第 7 节）。
2. **定位**：二分/加临时日志/写最小探针脚本（放 `%TEMP%`，不要入库）。区分"没触发"与"触发了但结果错"。
3. **修根因**：不要只修表象（例如"密码不回显"的根因是迁移漏了 `Local State`，而不是界面没渲染）。
4. **加回归**：能给脚本就给脚本（优先 `verify-*`），UI 交互放 `e2e-smoke.cjs`；
   修 bug 的提交里应包含"如果没有这个修复就会失败"的用例。
5. **验证**：跑相关脚本 + 受影响的 e2e 用例；改动跨进程时跑一次 `npm run verify:e2e`。
6. **提交**：`fix(scope): 现象 + 根因 + 处置`；如涉及用户可见行为，同步 README。

---

## 7. 排查手册（现象 → 原因 → 处置）

| 现象                                              | 常见原因                                                                       | 处置                                                                                                      |
| ------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| 双击 exe 毫无反应，日志里连"主进程开始执行"都没有 | 产物/解压目录带 **Low 完整性标签**，Chromium 沙箱初始化失败（`0x80000003`）    | 解压到普通目录；`icacls "<目录>" /setintegritylevel Medium /T /C`；兜底 `start.bat`                       |
| 出现 SmartScreen「Windows 已保护你的电脑」        | 未签名 + 文件带 MOTW                                                           | 更多信息 → 仍要运行；或先对 zip"解除锁定"再解压；彻底解决需代码签名证书                                   |
| 编辑连接不回显密码，且连接报认证失败              | 更名/搬目录时漏了 `Local State`（safeCrypt 主密钥）                            | 现在启动会自检并自动恢复（写 `credential-key-repaired` 标记，只试一次）；迁移逻辑见 `src/main/migrate.ts` |
| 上传同名文件没有提示                              | 调用方没走新的 `SftpUploadResultVO` 契约                                       | 传入 `conflictAction` 前必须先看 `conflicts`；界面见 `SftpPanel` 的冲突弹窗                               |
| 打包出 0 字节 zip 或 `EBUSY`                      | 残留 `7za`/`EasySSH.exe` 进程占用 dist                                         | 先结束残留进程再重跑；构建脚本会等压缩进程结束再校验                                                      |
| `npm run lint` 报大量 prettier 警告               | `.eslintcache` 在文件被外部改动后过期                                          | 删掉 `.eslintcache` 重跑（必要时 `npm run format`）                                                       |
| 终端里某些键打不出来                              | 焦点不在终端（例如刚点过侧栏分隔条）、输入法组合状态、或自定义键处理把按键吞了 | 点一下终端区域；检查 `isAppShortcut` 与 `attachCustomKeyEventHandler` 的放行逻辑                          |
| e2e 卡住不结束                                    | 残留进程占用 2222 端口，或应用实例没被清掉                                     | 结束 `EasySSH.exe`/`electron`/`node` 里的测试进程后重跑                                                   |

---

## 8. 提交与发布

**提交规范**：中文、小步、按类型前缀：`feat` / `fix` / `refactor` / `style` / `docs` / `test` / `chore`。
示例：`fix(sftp): 备份后上传失败时回滚，避免主文件被截成 0 字节`。

**红线**：

- 不提交 `node_modules/`、`dist/`、`out/`、`scripts/ui-shots/`、生成的 `build/start.lnk`（均已在 `.gitignore`）。
- 不把凭据、真实服务器地址、本机绝对路径写进代码、日志、文档或提交信息。
- `build/*.bat` 只能包含 ASCII 内容（cmd 在 GBK 环境下会把中文注释解析成乱码导致脚本失效）。
- **未经用户明确要求不要 push**；不要 force push 已有他人协作的分支。

**发布流程**（详见 README 的分发章节）：

```bash
# 1. 升版本（语义化：修复→patch，向后兼容的新功能→minor，破坏性改动→major）
#    改 package.json 的 version
# 2. 打包（会做 typecheck、生成 start.lnk、重置并校验完整性标签）
npm run build:win
# 3. 计算校验值并写发布说明
Get-FileHash dist\EasySSH-<版本>-win.zip -Algorithm SHA256
# 4. 打标签并推送，然后在 GitHub 建 Release，上传 zip 并把 SHA256 写进说明
git tag -a v<版本> -m "EasySSH v<版本>" && git push origin v<版本>
```

发布说明至少包含：本次新增/修复、下载与运行方式（含 SmartScreen 与完整性标签提示）、
SHA256、数据目录与升级说明。

---

## 9. 验证体系现状（截至 v1.1.0）

| 项目                 | 规模                  | 说明                                                                  |
| -------------------- | --------------------- | --------------------------------------------------------------------- |
| `npm run verify`     | 7 个脚本 / 170 项断言 | ssh 8、store 27、migrate 17、sftp 40、hostkey 31、resume 37、perf 10  |
| `npm run verify:e2e` | 283 项断言            | 真实打包产物：IPC、safeStorage、真实 SSH/SFTP、界面交互、真实键盘输入 |
| `npm run ui:shot`    | 18 张截图 + 3 项检查  | 高 DPI、真实拖拽（字节一致性）、对比度（文本 ≥4.5:1）                 |

数字随迭代变化，**以脚本输出为准**；新增能力时请同步补断言，并在 `scripts/verify-report.md`
里记录本轮的目的、入参、出参与实测结果。
