# ssh-client 体验优化轮 · 独立验证报告（task-5 首轮 + task-9 复验轮）

> 本报告分三轮记录：
> **首轮（task-5）** 第一~九节，记录体验优化改动本身的验证结果与发现的缺陷；
> **复验轮（task-9）** 见第十节，记录 task-6/7/8 三个缺陷修复 + lead 的 App.tsx/ErrorBoundary 修复的复验结果；
> **第三轮（task-19）** 见第十一节，记录主题 / 分组与导入导出 / SFTP 增强 / 端口转发 / 会话恢复 / 终端性能结论的独立验证。
> 首轮的失败项与缺陷结论已在复验轮更新，**以第十节为准**；本轮新增功能的结论**以第十一节为准**。

- 验证对象：本轮体验优化改动（主进程 errors.ts/ssh.ts/sftp.ts/ipc.ts、共享契约、preload、渲染进程 App/Terminal 系列/SFTP/Toast/ConnectionList/quickConnect 等）
- 验证者：verifier（独立验证，仅写 `scripts/**`，未改动任何 `src/**`）
- 验证方式：真实命令 + 真实 SSH/SFTP 协议 + 真实 Electron 进程（CDP 驱动 UI），全部结果为脚本实跑输出，非代码走查
- 报告配套脚本：
  - `scripts/verify-hostkey.cjs`（新增；复验轮扩充到 31 项断言）
  - `scripts/verify-quickconnect.cjs`（新增；复验轮扩充到 91 项断言）
  - `scripts/e2e-smoke.cjs`（新增 13 组用例，未削弱既有用例；复验轮全部改为硬断言）
  - `scripts/verify-sftp.cjs`（追加 3 组用例，未削弱既有用例）

---

## 一、验证环境与关键环境处置

| 项目 | 值 |
| --- | --- |
| 仓库 | `<repo>` |
| Node / Electron | Node v24.13.0；Electron 38.8.6（node 22.22.0） |
| SSH 测试端口 | `127.0.0.1:2222`（所有脚本串行执行，不并发） |
| 系统 ssh-keygen | `C:\WINDOWS\System32\OpenSSH\ssh-keygen.exe`（用于指纹独立交叉核对） |

### 1.1 端到端必须把 dist 改名（真实踩到）

本轮 e2e 先 `npm run build` 生成 `out/`，再把 `dist` 改名 `dist.bak`，让脚本回退到开发态；
跑完已把 `dist.bak` 改回 `dist`（已确认 `dist` 存在、`dist.bak` 不存在）。

**实测反证**：若不改名，脚本会启动 `dist/win-unpacked/ssh-client.exe`（上一轮产物），
新增用例立即失败：

```
[信息] 启动打包产物：...\dist\win-unpacked\ssh-client.exe
[警告] 打包产物早于 out/ 最新构建，可能掩盖本轮改动；验证新代码请先把 dist 改名后重跑
[失败] 页面执行出错：Error: 元素不存在：.quick-connect input
```

说明「旧打包产物掩盖新代码」的风险真实存在；本次已为脚本补上该场景的显式告警（不影响既有断言）。

### 1.2 开发态 Electron 在本工作区无法直接启动（Low 完整性标签）

```
$ node_modules\electron\dist\electron.exe . --remote-debugging-port=9333
HasExited=True ExitCode=-2147483645     # 0x80000003 STATUS_BREAKPOINT
CDP query failed: 目标计算机积极拒绝
```

```
$ icacls node_modules\electron\dist\electron.exe
Mandatory Label\Low Mandatory Level:(I)(NW)      # 低完整性标签
$ icacls dist\win-unpacked\ssh-client.exe
Mandatory Label\Medium Mandatory Level:(NW)      # 打包产物被 afterPack 重置过
```

这与 `src/main/index.ts` 头部注释描述的「低完整性导致浏览器进程在加载应用前以 0x80000003 退出」完全一致；
`e2e-electron.log` 为空，`%TEMP%\ssh-client-startup.log` 无本次启动记录，可排除应用自身问题。

**绕过方式（已写入脚本头部注释，脚本支持 `E2E_ELECTRON_BIN` 覆盖）**：

```powershell
robocopy node_modules\electron\dist "$env:TEMP\e2e-electron-dist" /E
$env:E2E_ELECTRON_BIN = "$env:TEMP\e2e-electron-dist\electron.exe"
```

副本位于 `%TEMP%`（Medium 完整性），实测可正常启动并暴露 CDP 调试端点；本次全部 GUI 用例均在该副本上运行，
被测代码仍是 `out/` 下由本轮源码新构建的产物（`npm run build` 退出码 0）。

### 1.3 其它环境处置

- `ELECTRON_RUN_AS_NODE=1` 由脚本内部剔除（既有逻辑，未改动）。
- e2e 内部测试服务由脚本自己起（`ssh2` 的 `Server`），本轮为它补了内存文件系统 + SFTP 子系统，才可能验证 SFTP 面板路径栏；
  同时给服务端连接加了 `error` 兜底（客户端拒绝主机密钥时服务端会抛 `KEY_EXCHANGE_FAILED`，否则脚本进程直接退出）。
- `closeServer` 改为不等 `server.close` 回调 + 主动断开存量连接：`net.Server.close` 的回调要等所有客户端连接结束，
  而被测应用当时仍挂着终端/SFTP 会话，初版会卡死（已实测卡住 10 分钟，修复后正常）。

---

## 二、基线回归（串行执行，全部退出码 0）

命令（逐条串行，避免抢占 127.0.0.1:2222）：

```
npm run typecheck
npm run lint
npm run verify:ssh
npm run verify:store
npm run verify:sftp
```

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `npm run typecheck` | 0 | `typecheck:node` / `typecheck:web` 均通过，无输出 |
| `npm run lint` | 0 | eslint 无告警；补完本轮脚本改动后复跑仍为 0 |
| `npm run verify:ssh` | 0 | `[结果] 全部通过，共 8 项` |
| `npm run verify:store` | 0 | `[结果] 全部通过，共 14 项` |
| `npm run verify:sftp` | 0 | 本轮增强后 `[结果] 全部通过，共 31 项`（原 21 项，未削弱任何既有断言） |
| `npm run build` | 0 | typecheck + electron-vite 三端构建成功（main 39.97 kB / preload 4.05 kB / renderer 1.10 MB） |

`verify:sftp` 本轮新增的 3 组用例（覆盖本轮 sftp.ts 改动）：

| 用例 | 目的 | 入参 | 出参 | 预期 | 实际 |
| --- | --- | --- | --- | --- | --- |
| 12 | 验证拖拽上传底层入口 `uploadPaths` 与 `fastPut` step 进度 | `{sftpId, remoteDir:'/home', localPaths:[300KB 本地文件]}` | `['big-upload.bin']`，进度 11 条 | 返回文件名、内容逐字节一致、有非零进度与 `done`（total=307200） | 全部一致，通过 |
| 13 | 验证 `fastGet` step 下载进度 | `download(sftpId, '/home/big-upload.bin')` + 保存框桩 | `true`，进度 11 条 | 下载内容逐字节一致、有进度与完成事件 | 通过 |
| 14 | 验证删除非空目录的中文提示 | `remove(sftpId, '/home/notempty')`（目录内有一个文件） | 抛错 `目录非空，请先删除其中的内容：/home/notempty` | 文案明确、可读 | 通过 |

> 为让用例 14 有意义，内存服务端的 `RMDIR` 改为「非空目录拒绝删除」（与真实服务端一致）；
> 既有用例删除的都是空目录，复跑全部通过，未削弱原有断言。

---

## 三、`scripts/verify-hostkey.cjs`（新增，退出码 0）

命令：`node scripts/verify-hostkey.cjs`
做法：`typescript.transpileModule` 编译 `src/main/ssh.ts` + electron 桩（`app.getPath('userData')` 指向临时目录，
故 `known_hosts.json` 完全隔离），用 `ssh2` 的 `Server` 在 `127.0.0.1:2222` 起真实 SSH 服务端。

**结果：断言通过 24 项，非致命发现 2 项，退出码 0。**

### 3.1 关键证据：指纹与服务端密钥的真实 SHA256 一致（含 ssh-keygen 独立核对）

```
[通过] A 指纹与 ssh-keygen 独立计算结果一致（SHA256:5SlGrBqNrnpHB5Dqb8x/G++yDLhbuMazGpyv/ydybvM）
[证据] ssh-keygen 输出：256 SHA256:5SlGrBqNrnpHB5Dqb8x/G++yDLhbuMazGpyv/ydybvM no comment (ED25519)
[通过] B 指纹与 ssh-keygen 独立计算结果一致（SHA256:6IyFz2UtD0U+ua1bTJEhgpj+6eXO1c3hNyg5fOxfMXI）
[证据] ssh-keygen 输出：256 SHA256:6IyFz2UtD0U+ua1bTJEhgpj+6eXO1c3hNyg5fOxfMXI no comment (ED25519)
```

指纹来源：`utils.parseKey(私钥).getPublicSSH()`；已单独验证该 blob 与客户端 `hostVerifier` 实际收到的字节
`Buffer.compare === 0`（与真实握手一致）。

### 3.2 用例明细

| # | 目的 | 入参 | 出参 | 预期 | 实际 |
| --- | --- | --- | --- | --- | --- |
| a | 首次连接 TOFU 自动信任并落盘 | 服务端主机密钥 A；`pool.acquire({host:127.0.0.1, port:2222, username:'tester'})` | 连接成功；`known_hosts.json = {"127.0.0.1:2222":"SHA256:5SlG…"}` | 首次信任并写入真实指纹，无 `.tmp` 残留 | 通过（指纹与 ssh-keygen 一致） |
| b | 换另一把主机密钥后拒绝连接且错误可还原 | 服务端重启为密钥 B；再次 `acquire` | `Error: HOST_KEY_CHANGED:{"host":"127.0.0.1","port":2222,"oldFingerprint":"SHA256:5SlG…","newFingerprint":"SHA256:6IyF…"}` | 连接失败；`parseHostKeyChanged` 还原出 host/port/新旧指纹，且等于 A/B 真实指纹 | 通过 |
| d | 未确认前重连始终失败且不静默信任 | 第二次 `acquire` | 同样被拒绝；`known_hosts.json` 仍为 A 指纹 | 稳定失败、文件不被改写 | 通过 |
| c | `trustPendingHostKey` 后重连成功且指纹更新 | `trustPendingHostKey('127.0.0.1', 2222)` → `acquire` | 连接成功；文件更新为 B 指纹；重复调用无副作用 | 更新为新指纹并重连成功 | 通过 |
| 附 1 | Electron 包装后的错误仍可还原 | `Error invoking remote method 'terminal:open': Error: HOST_KEY_CHANGED:{…}` | 还原成功 | 与渲染进程 `asHostKeyChanged` 路径一致 | 通过 |
| 附 2 | 普通错误与截断 JSON 不误判 | `连接 127.0.0.1:2222 失败：连接被拒绝`、`HOST_KEY_CHANGED:{ 截断` | `null` | 不抛异常、返回 null | 通过 |

### 3.3 非致命发现（见第七节缺陷 3、4 的原始输出）

```
[发现 1] 服务端未监听（ECONNREFUSED）时，错误被上报为主机密钥变更：HOST_KEY_CHANGED:{"host":"127.0.0.1","port":2222,
         "oldFingerprint":"SHA256:HqA+…"，原因是 ssh.ts 的 acquire 只要发现待确认记录就无条件抛出编码错误，未区分真实失败原因
[发现 2] known_hosts.json 内容损坏时被静默当作空表，直接重新 TOFU 信任了新指纹。记录表损坏不会报错也不会提示用户
```

---

## 四、`scripts/verify-quickconnect.cjs`（新增，退出码 0）

命令：`node scripts/verify-quickconnect.cjs`
做法：编译加载 `src/renderer/src/quickConnect.ts`。

**结果：通过 79 项，失败 0 项。**

设计缺陷判定：**未发现**。编译产物中不含任何 `require(`，模块在纯 Node 环境可直接加载，
说明它确实是「纯函数、不依赖 DOM/window」的实现（脚本已把这一点做成断言）。

| 用例组 | 目的 | 入参 | 出参 | 预期 | 实际 |
| --- | --- | --- | --- | --- | --- |
| a1–a15 | 正常解析 | `example.com`、`alice@example.com`、`example.com:2222`、`alice@example.com:2222`、`ssh://alice@example.com:2222`、`   alice@…:2222   `、`SSH://…`、`Ssh://…`、端口 `1`/`65535`/`0022`、`bob@…`、`127.0.0.1:2222` | `{ok:true, dto:{name,host,port,username,authType:'password'}}` | 主机/端口/用户名正确；名称=`用户名@主机`；**不含 password/privateKeyPath/passphrase** | 全部通过 |
| a12 | 用户名缺省用 defaultUsername | `example.com` + `defaultUsername=''` | `username:''`、`name:'@example.com'` | （观察项）逻辑符合「无用户名则用默认值」；默认值来自 `os.userInfo().username`，正常非空 | 通过（已登记为低风险观察） |
| b1–b9 | 端口非法 | `abc`、`0`、`65536`、`22.5`、空端口 `host:`、`-1`、`22x`、超长数字、`70000` | `{ok:false, error:'端口必须是 1-65535 之间的整数'}` | 全部拒绝并给出统一中文原因 | 全部通过 |
| c1–c5 | 输入非法 | `''`、`'    '`、`'ssh://'`、`'alice@'`、`'alice@:2222'` | `请输入连接地址，例如 user@host:22` / `缺少主机地址，例如 user@host:22` | 明确中文原因 | 全部通过 |
| c6–c7 | IPv6 明确拒绝 | `::1`、`fe80::1:2222` | `暂不支持 IPv6 地址，请输入主机名或 IPv4` | 不猜主机、明确报错 | 全部通过 |
| 附加 | 纯函数无状态 | 同一输入解析两次 | 结果完全一致 | 结果稳定 | 通过 |

---

## 五、端到端 `scripts/e2e-smoke.cjs`（真实 Electron + CDP 驱动 UI）· 首轮记录（失败项已在第十节修复并复验通过）

命令（本轮实际执行序列）：

```powershell
npm run build
Rename-Item dist dist.bak
robocopy node_modules\electron\dist "$env:TEMP\e2e-electron-dist" /E
$env:E2E_ELECTRON_BIN = "$env:TEMP\e2e-electron-dist\electron.exe"
node scripts/e2e-smoke.cjs
Rename-Item dist.bak dist
```

**结果：通过 49 项、已知缺陷 2 项（非致命探针）、失败 1 项，退出码 1（失败项见第五.2）。**

### 5.1 本轮新增/增强用例（全部为真实 UI 交互）

| # | 用例 | 目的 | 入参 | 出参 | 预期 | 实际 |
| --- | --- | --- | --- | --- | --- | --- |
| 7 | 快速连接 | 输入地址回车能否真实连上 | `.quick-connect input` 写 `127.0.0.1:2222` + Enter | 新标签 `ZHH@127.0.0.1`；IPC 收到新会话数据 | 出现新标签（任务要求的判定） | **通过** |
| 7b | 首屏输出探针 | 建成瞬间的远端输出是否进入终端 | 观察 `.xterm-rows` 与 IPC 计数 | IPC 欢迎语 2 次 / 终端文本长度 1 | 终端应显示欢迎语 | **缺陷 1（非致命探针，详见七）** |
| 7c | 挂载后输出链路 | writer 注册后输出能否渲染 | `terminal.write(sid,'echo E2E-QUICK-ECHO-OK\n')` | 屏幕出现 `E2E-QUICK-ECHO-OK` | 能渲染 | 通过 |
| 8 | 界面新建连接 | 表单提交后列表自动刷新（为 SFTP 用例准备列表项） | 点「+ 新建」→ 填名称/主机/端口/用户名 → 保存 | 表单关闭、`.conn-item` 出现；字段回读 `{"名称":"E2E 界面连接","主机":"127.0.0.1","端口":"2222","用户名":"tester"}` | 保存成功且列表刷新 | 通过 |
| 9 | SFTP 路径栏 | 打开面板并按 `/` 跳转 | 点 ⇅ 打开 SFTP；`.sftp-path-input` 置 `/` + Enter | 初始值 `/home` → 跳转后值 `/`，列表出现 `root-file.txt` | 路径栏可编辑跳转 | 通过 |
| 10 | Toast | 失败操作是否出现分级提示 | 快速连接 `127.0.0.1:59998` + Enter | `.toast.error`；文案 `目标端口未开放或 SSH 服务未启动（连接 127.0.0.1:59998；原始错误码 ECONNREFUSED：…）`；点击后立即消失 | 出现带 kind 类名的提示 | 通过 |
| 11 | 主机密钥变更弹窗 | 换服务端密钥后 UI 能否弹窗并在确认后连上 | 先连接记录指纹 A → 服务端换密钥 B 重启 → 快速连接 `e2e-hk@127.0.0.1:2222` → 点「信任新密钥并连接」 | 弹窗标题「主机密钥已变更」；`.fp-value.old/new` = A/B 真实 SHA256；未确认前文件仍为 A；确认后弹窗关闭、新标签出现、`known_hosts.json` 更新为 B、会话可收发（`E2E-HK-OK` 回显） | 全链路成立 | **全部通过** |
| 11b | 重连首屏探针 | 同 7b | — | — | — | **缺陷 1 复现（非致命探针）** |
| 12.1 | 窗口标题 | 标题是否跟随标签 | 当前标签 `e2e-hk@127.0.0.1` | `document.title === 'e2e-hk@127.0.0.1 · SSH 客户端'` | 与标签一致 | 通过 |
| 12.2 | 连接搜索过滤 | 关键字过滤与恢复 | `.conn-search input` = `ZZZ-不存在的连接-7788` → 清空 | 列表 0 项 → 恢复为原数量 | 过滤生效 | 通过 |
| 12.3 | 复制连接 | 复制是否生成不带凭据的草稿 | 点 `[title="复制连接"]` | 弹出「新建连接」表单，名称 `E2E 测试机 副本` | 草稿名称带「副本」 | 通过（随后取消关闭） |
| 12.4 | 右键菜单 | 终端右键菜单是否完整可关闭 | 在激活终端派发 `contextmenu` | `.ctx-menu` 出现，含 复制/粘贴/全选/查找/清屏；Esc 关闭 | 菜单完整、可关闭 | 通过 |
| 12.5 | 字号快捷键 | Ctrl+= / Ctrl+0 是否持久化 | CDP 真实按键（先聚焦 xterm 输入区） | `localStorage['ssh-client:font-size']` = `15` → `14` | 持久化并按默认值复位 | 通过 |
| 13 | 终端搜索 | Ctrl+F 展开、关键词计数 | 写入 `E2E-SEARCH-MARKER-2026` 到终端 → CDP 注入 Ctrl+F → 搜索栏输入关键词 | `.term-search` 出现（通过）；计数文案未出现，页面未捕获异常 | 计数文案应变为 `第 x/y 项` | **失败（见 5.2）** |
| 14 | 全程无未捕获异常 | — | — | — | 无异常 | 未执行到（13 提前失败，异常内容已在 13 的失败信息中给出） |

### 5.2 失败项（1 项，真实产品缺陷）

```
[失败] 输入关键词后命中计数未出现：计数文案="<计数元素不存在>"，
       {"应用仍挂载":false,"根节点内容长度":0}，
       页面未捕获异常=["Uncaught Error: You must set the allowProposedApi option to true to use proposed API"]
```

- 复现步骤：Ctrl+F 打开搜索栏（成功）→ 向 `.term-search-input` 输入任意关键词 → 计数区域 `#root` 被整体卸载（白屏）。
- 判定：**失败**（任务要求的「输入关键词后计数文案变化」未成立），并且升级为「整个界面被卸载」的严重问题。
- 最小化证据：`#root.innerHTML` 长度为 0（React 根被卸载）；未捕获异常文本直接来自 xterm 的 proposed API 校验。
- 静态佐证（构建产物 `out/renderer/assets/index-*.js`）：
  - xterm 默认值 `allowProposedApi: !1`；
  - `_checkProposedApi(){ if(!this._core.optionsService.rawOptions.allowProposedApi) throw new Error("You must set the allowProposedApi option to true to use proposed API") }`；
  - 产物中 **不存在** `allowProposedApi:!0`，即应用从未开启该选项。
- 触发链：`TerminalSearchBar` 在有关键词时调用 `search.findNext(keyword, { decorations: SEARCH_DECORATIONS })`
  → `SearchAddon` 走 `_highlightAllMatches` → `Terminal.registerDecoration()`（proposed API）→ 抛错
  → React 无错误边界 → 整棵组件树被卸载。

### 5.3 已知缺陷探针（2 项，脚本按「非致命」记录，不影响契约用例判定）

```
[缺陷] 快速连接后终端为空屏：远端欢迎语已经到达渲染进程（IPC 层可见），但没有进入 xterm 缓冲区。
       现场={"hostCount":1,"hosts":[{"cls":"terminal-host","size":[923,691],"行数":43,"文本长度":1}],
             "screenSize":[902,688],"当前屏幕文本":" ","IPC累计欢迎语次数":2}
[缺陷] 主机密钥确认后重连的终端为空屏（与快速连接同一原因）。
       现场={...,"IPC累计欢迎语次数":3}
```

判定依据：欢迎语在 IPC 层出现 2/3 次（渲染进程确实收到），但 xterm 缓冲区文本长度为 1（仅一个空格）；
同一会话稍后写入的 `E2E-QUICK-ECHO-OK` / `E2E-HK-OK` 均能正常渲染，说明不是终端渲染或链路问题，
而是「会话建立瞬间的输出早于 `registerWriter` 注册，被 App 的 `writers.current.get(sessionId)?.()` 静默丢弃」。

---

## 六、通过 / 失败清单 · 首轮记录（复验轮结果见第十节 10.1）

### 通过（脚本断言总计 24 + 79 + 31 + 49 = 183 项）

| 范围 | 项数 | 结论 |
| --- | --- | --- |
| `scripts/verify-hostkey.cjs` | 24 | TOFU 自动信任、指纹变更拒绝、错误编码还原、真实指纹一致（ssh-keygen 核对）、未确认不静默信任、确认后重连成功并更新指纹 |
| `scripts/verify-quickconnect.cjs` | 79 | 10 类正常解析 + 9 类端口非法 + 7 类输入非法/边界 + 无状态性，全部符合预期 |
| `scripts/verify-sftp.cjs`（含新增 3 组） | 31 | 既有 21 项继续通过；新增 uploadPaths、fastPut/fastGet 进度、非空目录中文提示全部通过 |
| `scripts/e2e-smoke.cjs` | 49 | 既有 10 项全部通过（原有第 11 项「全程无未捕获异常」因搜索用例提前失败未执行到）；新增 39 项（快速连接、表单保存刷新列表、SFTP 路径栏、Toast、主机密钥变更弹窗全链路、窗口标题、搜索过滤、复制连接、右键菜单、字号持久化） |
| 基线命令 | 5 条 | `typecheck` / `lint` / `verify:ssh` / `verify:store` / `verify:sftp` / `build` 全部退出码 0 |

### 失败

| 范围 | 项数 | 说明 |
| --- | --- | --- |
| `scripts/e2e-smoke.cjs` 用例 13（终端搜索计数） | 1 | 输入关键词触发未捕获异常，React 根被卸载（白屏）；详见缺陷 1 |
| `scripts/e2e-smoke.cjs` 用例 14（全程无未捕获异常） | 未执行到 | 因 13 提前失败；异常内容已在 13 的失败信息中完整给出 |

---

## 七、缺陷与风险等级（首轮发现；修复状态见第十节）

状态标记：✅ 已修复并在复验轮验证通过 ｜ 📌 产品决策（已记录，不计为缺陷）

### 缺陷 1【高，✅ 已修复】终端搜索一输入关键词就白屏（本轮新增功能，必须修）

- 现象：Ctrl+F 能打开搜索栏，但只要输入关键词，立即抛未捕获异常并把整个界面卸载（`#root` 内容长度 0）。
- 根因：`src/renderer/src/components/TerminalView.tsx` 创建 `new Terminal({...})` 时未开启 `allowProposedApi`，
  而 `TerminalSearchBar` 传入 `decorations`（计数 `onDidChangeResults` 依赖它）会走 `registerDecoration` 这一 proposed API。
- 建议修法（最小改动、风险最低）：在 `TerminalView.tsx` 的 `new Terminal({...})` 中加 `allowProposedApi: true` 一行；
  若不愿引入 proposed API，则必须去掉 `decorations` 并改用其它方式呈现计数（否则计数永远为空）。
- 次生风险【低】渲染进程没有错误边界，任何渲染期异常都会导致整窗白屏；建议补一个 ErrorBoundary 兜底并提示用户。

### 缺陷 2【中，✅ 已修复】UI 打开的终端会丢失「建成瞬间」的远端输出

- 现象：欢迎语/MOTD/首个提示符在 IPC 层已到达渲染进程，但终端挂载前被丢弃，用户看到空白终端。
- 证据：`IPC累计欢迎语次数=2/3`，而终端缓冲文本长度 1；同一会话稍后写入的内容能正常显示。
- 根因：`App.tsx` 的全局 `onData` 只做 `writers.current.get(sessionId)?.(data)`，会话数据先于 `TerminalView` 挂载时无缓冲可落。
- 归属：该写法在上一轮代码（HEAD）中已存在，本研究轮改动未新增该缺陷，但本轮的「连接中状态条 + 快速连接 + 主机密钥确认后重连」让这条路径被更频繁地走到，用户体验影响放大。
- 建议修法：App 层为每个 sessionId 维护待写队列，`registerWriter` 时把积压数据一次性回放（约 10 行改动）。

### 缺陷 3【中，✅ 已修复】待确认主机密钥存在时，任意连接失败都会被误报为「主机密钥已变更」

- 现象（`verify-hostkey.cjs` 发现 1）：服务端已下线（ECONNREFUSED）时，界面仍会弹出「主机密钥已变更」并要求核对指纹，
  此时展示的新指纹是上一次握手观察到的陈旧值，用户可能据此点「信任新密钥并连接」。
- 根因：`src/main/ssh.ts` 的 `acquire` 错误处理只要 `pendingHostKeys` 命中该 `host:port` 就无条件抛 `encodeHostKeyChanged`，
  未判断本次失败是否真的由 `hostVerifier` 拒绝导致。
- 建议修法：在 `verifyHostKey` 内记录「本次握手已被拒绝」标记（或比对错误信息），仅该标记存在时才返回编码错误，其余走 `toReadableError`。

### 缺陷 4【低，📌 产品决策】`known_hosts.json` 损坏时重建空表并重新 TOFU（已改为保留现场 + 日志）

- 现象（`verify-hostkey.cjs` 发现 2）：文件内容不是合法 JSON 时被当作空表，直接信任新指纹并覆盖写回，不报错不提示，
  该场景下中间人防护静默失效（且影响所有主机记录）。
- 建议修法：读取失败时保留原文件并给出告警（或备份为 `.bak`），不要静默重建空表。

### 观察 5【低，✅ 已修复】快速连接在 `defaultUsername` 为空串时会以空用户名连接

- `parseQuickConnect('example.com', '')` 返回 `username:''`、`name:'@example.com'`，随后会以空用户名发起认证。
- 现实中默认用户名取自 `os.userInfo().username`，正常非空；仅在取默认用户名失败（IPC 异常）时出现。建议加一条回退提示或拒绝。

### 环境/工具风险【低】

- 开发态 Electron 在本工作区（被沙箱打标过）无法启动（Low 完整性，0x80000003）；未做 `icacls` 改写（属于工作区外改动），
  改用 `E2E_ELECTRON_BIN` 指向 `%TEMP%` 副本。该副本约 250 MB，位于 `%TEMP%\e2e-electron-dist`，可随时删除。
- `scripts/e2e-smoke.cjs` 默认优先打包产物；若 `dist` 落后于源码会跑旧代码（本轮已加显式告警，但仍需人工改名）。

---

## 八、未验证项与原因

| # | 未验证内容 | 原因 / 已尝试的做法 |
| --- | --- | --- |
| 1 | 打包产物形态（`dist/win-unpacked`）下的端到端 | 按任务要求把 `dist` 改名以强制走 `out/` 开发态（旧 `dist` 是上一轮产物，不代表新代码）。若要补验：`npm run build:unpack` 后重跑 e2e（afterPack 会把标签重置为 Medium，可直接启动） |
| 2 | 拖拽上传的真实拖拽链路（`onDrop` + `webUtils.getPathForFile`） | CDP 无法构造带真实磁盘路径的 `DataTransfer`（`File` 需来自真实拖拽来源），已尝试用合成 `DragEvent` 但 `dataTransfer.files` 无法携带有效路径，故未验证。底层 `uploadPaths` 已在 `verify:sftp` 覆盖，前端 `onDrop` 分支仍是空白 |
| 3 | SFTP 面板其余交互：行内重命名、新建目录输入、双击进入目录/下载、传输进度条 DOM、拖拽覆盖层文案、单击选中样式 | 本轮 e2e 只按任务清单补了要求用例；这些点未在本轮范围内，未做（属覆盖空白，非已知问题） |
| 4 | 剪贴板链路（Ctrl+Shift+C/V、右键复制/粘贴、中键粘贴、Ctrl/Shift+Insert） | 需要真实系统剪贴板与终端选中文本，且会污染宿主剪贴板；未验证。仅确认 IPC `clipboardRead/clipboardWrite` 已注册、菜单项文案存在 |
| 5 | 全局快捷键（Ctrl+Tab / Ctrl+Shift+Tab / Alt+1..9 / Ctrl+Shift+W / Ctrl+N） | 未在本轮 e2e 覆盖（CDP 可注入，但会与终端标签状态耦合，时间成本高）；代码路径为 App 级 `keydown` 监听，未经真实验证 |
| 6 | 字号在应用重启后仍生效 | 只验证了写入 `localStorage`（15）与复位（14）；未做「重启后 `readFontSize()` 生效」的跨进程验证 |
| 7 | 主机密钥变更发生在 SFTP 打开路径时的弹窗 | e2e 只覆盖了终端路径；两条路径共用 `ipc.ts` 的 `trustHostKey` 与 `App` 的 `trustAndRetry`，差异小但未单独跑 |
| 8 | 连接超时路径（`readyTimeout: 20s`）、keepalive、多窗口广播、连接池高并发 | 未构造相应场景（会显著拉长脚本时长），未验证 |
| 9 | `npm run verify:e2e` 一键脚本在「dist 存在」时的行为 | 已知会跑旧产物；本轮以改名方式规避，未修改 package.json 流程（超出 `scripts/**` 写入范围） |

---

## 九、复现指引

```powershell
cd <repo>

# 1) 基线（串行，勿并发，均占用 127.0.0.1:2222）
npm run typecheck; npm run lint
npm run verify:ssh; npm run verify:store; npm run verify:sftp

# 2) 新增验证脚本
node scripts/verify-hostkey.cjs        # 期望：断言通过 24 项，非致命发现 2 项，退出码 0
node scripts/verify-quickconnect.cjs   # 期望：通过 79 项，失败 0 项，退出码 0

# 3) 端到端（必须先把 dist 改名，否则跑到旧打包产物）
npm run build
Rename-Item dist dist.bak
robocopy node_modules\electron\dist "$env:TEMP\e2e-electron-dist" /E
$env:E2E_ELECTRON_BIN = "$env:TEMP\e2e-electron-dist\electron.exe"
node scripts/e2e-smoke.cjs
Rename-Item dist.bak dist

# 期望（当前代码）：通过 49 项、已知缺陷 2 项、失败 1 项（终端搜索输入关键词导致白屏），退出码 1
# 修复缺陷 1 后预期：通过 49 项、失败 0 项，并应看到「输入已存在于终端缓冲区的关键词后显示命中计数」
```

> 说明：`scripts/verify-sftp.cjs` 的服务端装载器补丁（`compileTo` 的 `sourceDir` 参数、`shared-errors.js`/`errors.js` 编译、
> `Module._load` 中登记 `@shared/errors` 与 `./errors`）由 lead 提供，本轮验证完整复用，未删除、未改动语义。

---

## 十、复验轮（task-9）：缺陷修复回归验证

复验对象：task-6（终端搜索白屏）、task-7（主机密钥误判）、task-8（快速连接空用户名）三个修复，
以及 lead 在 `App.tsx` 的「首屏输出缓冲回放」与新增顶层 `ErrorBoundary`（`src/renderer/src/components/ErrorBoundary.tsx`，`main.tsx` 已挂载）。
`src/**` 仍只读，本轮只改 `scripts/**`。

## 10.1 命令与结果（全部串行，占用 127.0.0.1:2222 的顺序执行）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `npm run typecheck` | 0 | 通过 |
| `npm run lint` | 0 | 通过 |
| `npm run verify:ssh` | 0 | 8 项通过 |
| `npm run verify:store` | 0 | 14 项通过 |
| `npm run verify:sftp` | 0 | 31 项通过（含首轮新增 3 组，断言未被削弱） |
| `npm run verify:hostkey` | 0 | **31 项断言通过，非致命发现 0 项**（首轮为 24 项 + 2 项发现） |
| `npm run verify:quickconnect` | 0 | **91 项通过，0 失败**（首轮 79 项） |
| `npm run build` | 0 | typecheck + 三端构建通过 |
| `node scripts/e2e-smoke.cjs` | **0** | **62 项全部通过，0 失败，0 缺陷**（首轮 49 通过 / 1 失败 / 2 缺陷探针） |

复验轮断言总计：31 + 91 + 31 + 62 = **215 项全部通过**，另有基线 8 + 14 项，全部退出码 0。

## 10.2 逐项修复验证

### a) 终端搜索白屏（task-6，首轮唯一失败项）→ 已通过

修复：`TerminalView.tsx` 的 `new Terminal({...})` 增加 `allowProposedApi: true`（中文注释说明 decorations 属 proposed API）。

```
[通过] Ctrl+F 展开终端搜索栏（.term-search 出现）
[通过] 输入已存在于终端缓冲区的关键词后显示命中计数（第 1/1 项）
[通过] 换成不存在的关键词后计数文案变为「无结果」
[通过] 关闭搜索栏后元素消失
[通过] 渲染进程全程无未捕获异常
[通过] 渲染根节点保持挂载（内容长度 126303）
```

首轮失败信息里的异常 `Uncaught Error: You must set the allowProposedApi option to true to use proposed API`
与 `"应用仍挂载":false,"根节点内容长度":0` 均不再出现；e2e 新增了「无未捕获异常 + `#root` 非空」的硬断言作为白屏回归防线。

### b) 首屏输出丢失（lead 修复 App.tsx 缓冲回放）→ 已通过

首轮的探针（IPC 收到欢迎语但终端为空屏）已改为**硬断言**，两条路径均通过：

```
[通过] 快速连接的终端显示远端欢迎语（首屏输出未丢失）
[通过] 确认信任后重连的终端显示远端欢迎语（首屏输出未丢失）
```

### c) 主机密钥误判（task-7）→ 主进程级与 UI 级双重验证通过

主进程级（`verify-hostkey.cjs`，服务端下线时 pending 记录仍在）：

```
[通过] 服务端未监听时未被误判为主机密钥变更（实际信息：目标端口未开放或 SSH 服务未启动（连接 127.0.0.1:2222；原始错误码 ECONNREFUSED：…
[通过] 服务端未监听时给出中文原因并保留原始错误码（目标端口未开放或 SSH 服务未启动（…ECONNREFUSED：connect ECONNREFUSED 127.0.0.1:2222））
[通过] 服务端恢复后待确认记录仍能触发可解析的主机密钥变更错误
```

UI 级（e2e 新增 11.x / 11.y / 11.z）：

```
[通过] 取消连接后弹窗关闭
[通过] 取消连接后 known_hosts.json 仍保存旧指纹
[通过] 待确认记录存在且服务端下线时出现错误提示
[通过] 服务端下线时给出中文 ECONNREFUSED 且未误报密钥变更（目标端口未开放或 SSH 服务未启动（连接 127.0.0.1:2222；原始错误码 ECONNREFUSED：…））
[通过] 服务端恢复后再次弹出主机密钥变更确认弹窗
[通过] 再次弹出的弹窗仍展示服务端 B 的真实指纹
[通过] 确认信任后自动重连成功并新建标签
[通过] 确认信任后 known_hosts.json 更新为主机 B 的真实 SHA256 指纹
```

即：**无关失败不再误报**，而**真正的指纹变更仍会弹框并可恢复**，两条路径都被覆盖。

### d) 快速连接空用户名（task-8）→ 已通过

`verify-quickconnect.cjs` 的 a12 观察项改为 d 组用例（原先「返回 username:''」的期望已删除，替换为期望报错）：

```
[通过] d1 默认用户名为空串且未写用户名 → 请输入用户名，例如 root@host
[通过] d2 默认用户名纯空白且未写用户名 → 请输入用户名，例如 root@host
[通过] d3 @host 且默认用户名为空 → 请输入用户名，例如 root@host
[通过] d4 @host:2222 且默认用户名纯空白 → 请输入用户名，例如 root@host
[通过] d5 输入自带用户名时不受空默认值影响 → bob@example.com:22
[通过] d6 默认用户名首尾空白会被 trim 后使用 → dev@example.com:22
```

### e) known_hosts 损坏（首轮缺陷 4）→ 按产品决策验收，发现项清零

main-proc 按 lead 决策实现「改名为 `known_hosts.json.bak` + `console.warn` + 重建空表后继续 TOFU」，不采用 fail-closed。
脚本相应改为断言该预期行为（原先只看「能否连上」的 `[发现]` 已删除）：

```
[ssh-client] known_hosts 无法解析，已备份为 …\known_hosts.json.bak 并重建空表，本次连接将重新记录主机指纹
[通过] known_hosts.json 损坏后连接仍可建立（重建空表并重新 TOFU）
[通过] 损坏的记录表已改名为 .bak 并完整保留现场
[通过] 重建后的记录表重新记录了本次握手指纹（TOFU 继续可用）
```

**结论：本条已由 lead 定性为产品决策（低危，已记录）**，现场不再静默丢失，`[发现]` 计数由 2 归零。

## 10.3 脚本自检

| 检查项 | 结论 |
| --- | --- |
| `verify-hostkey.cjs` 的 `pass is not defined`（main-proc 交叉验证时实测到，两处调用未定义函数） | 已补 `pass(message)` 实现；脚本现可完整跑完 31 项，退出码 0 |
| `verify-sftp.cjs` 既有断言是否被削弱 | 未削弱：首轮 21 项全部保留，仅追加 3 组（`uploadPaths`、fastPut/fastGet 进度、非空目录中文提示），本轮复跑 31 项全通过 |
| `e2e-smoke.cjs` 是否吞掉断言失败 | 未吞：`main()` 只有 `try/finally`（finally 仅做进程清理），无 `catch`；失败经 `main().catch` 置 `process.exitCode = 1`。首轮用于「记录但不失败」的 `knownIssues` 探针已随缺陷修复全部改为硬断言，`knownIssues` 机制已删除 |
| 是否存在被跳过的用例 | 无。复验轮 e2e 62 项全部执行完毕（首轮因搜索失败未执行到的「全程无未捕获异常」也已执行并通过） |

## 10.4 剩余缺陷与风险（复验轮结论）

| # | 项目 | 等级 | 状态 |
| --- | --- | --- | --- |
| 1 | 终端搜索白屏 | 高 | ✅ 已修复并验证（allowProposedApi: true） |
| 2 | 首屏输出丢失 | 中 | ✅ 已修复并验证（App 层缓冲回放） |
| 3 | 主机密钥变更误判 | 中 | ✅ 已修复并验证（信息匹配 + `level === 'handshake'`） |
| 4 | known_hosts 损坏重新 TOFU | 低 | 📌 产品决策（.bak 保留现场 + 主进程 `console.warn` + 重建空表）；**残余风险：界面无任何提示**，普通用户不会感知记录表曾损坏，如需用户可见需产品再决策 |
| 5 | 快速连接空用户名 | 低 | ✅ 已修复并验证（明确报错） |
| 6 | 无错误边界导致渲染异常白屏 | 低 | ✅ 已缓解：新增顶层 `ErrorBoundary`，e2e 断言 `#root` 保持非空（126303 字符） |
| 7 | 开发态 Electron 因 Low 完整性标签无法启动 | 低（环境） | 仍在：需 `E2E_ELECTRON_BIN` 指向 `%TEMP%` 副本；属工作区打标问题，非产品缺陷 |
| 8 | `verify:e2e` 在 `dist` 存在时会跑旧打包产物 | 低（工具链） | 仍在：脚本已加陈旧产物告警，但流程上仍需人工先把 `dist` 改名 |
| 9 | `ErrorBoundary` 的兜底界面文案与可恢复性未做视觉/交互验证 | 低 | 本轮只验证了「不白屏」；未构造真实渲染异常去触发兜底 UI |

**复验结论：首轮 1 项失败 + 4 项缺陷（含 1 项观察）中，3 项中高危缺陷与 2 项低危项全部修复并验证通过，
1 项低危项按产品决策验收；当前不存在已知的功能性缺陷。**

## 10.5 仍未覆盖项（较首轮的变化）

首轮未覆盖项中，以下仍然未覆盖，原因不变（详见第八节）：

1. 打包产物形态（`dist/win-unpacked`）下的端到端 —— 复验轮同样按流程把 `dist` 改名走 `out/` 开发态。
   **新增建议**：缺陷修复已完成，下一轮可执行 `npm run build:unpack` 后直接跑 e2e 验证打包形态（afterPack 会重置完整性标签）。
2. 拖拽上传的真实拖拽链路（`onDrop` + `webUtils.getPathForFile`）—— CDP 无法构造带真实磁盘路径的 `DataTransfer`；底层 `uploadPaths` 已覆盖。
3. SFTP 面板其余交互（行内重命名、新建目录输入、双击打开、进度条 DOM、拖拽覆盖层、选中样式）。
4. 剪贴板链路（Ctrl+Shift+C/V、右键复制/粘贴、中键粘贴）。
5. 全局快捷键（Ctrl+Tab / Ctrl+Shift+Tab / Alt+1..9 / Ctrl+Shift+W / Ctrl+N）。
6. 字号在应用重启后生效。
7. 主机密钥变更发生在 SFTP 打开路径（仅在终端路径上验证）。
8. 连接超时（`readyTimeout`）、keepalive、多窗口广播、连接池并发。

## 10.6 复验轮复现指引

```powershell
cd <repo>

# 串行复跑（均占用 127.0.0.1:2222）
npm run typecheck; npm run lint
npm run verify:ssh; npm run verify:store; npm run verify:sftp
npm run verify:hostkey        # 期望：断言通过 31 项，非致命发现 0 项，退出码 0
npm run verify:quickconnect   # 期望：通过 91 项，失败 0 项，退出码 0
# 或一键：npm run verify

# 端到端
npm run build
Rename-Item dist dist.bak
robocopy node_modules\electron\dist "$env:TEMP\e2e-electron-dist" /E   # 仅首次需要
$env:E2E_ELECTRON_BIN = "$env:TEMP\e2e-electron-dist\electron.exe"
node scripts/e2e-smoke.cjs     # 期望：全部通过，共 62 项，退出码 0
Rename-Item dist.bak dist
```

---

## 十一、第三轮（task-19）：本轮新增功能独立验证

> - 验证者：verifier2（独立验证；**只写 `scripts/**`，未改动任何 `src/**`**）
> - 验证对象：本轮新增的 6 块功能 —— 主题系统、连接分组 + 导入导出、SFTP 增强（列宽拖拽 / 大目录虚拟滚动 / 多文件进度聚合 / 远程编辑入口 / 断点续传）、端口转发（local / remote / dynamic-SOCKS5）、会话恢复、终端性能结论复核
> - 验证方式：**真实命令 + 真实 SSH/SFTP 协议 + 真实 Electron 打包产物（CDP 驱动 UI）**，全部结论来自脚本实跑输出，不做代码走查
> - 环境：Windows 10.0.26200 / Node v24.13.0 / Electron 38.8.6；测试 SSH 服务 `127.0.0.1:2222`（串行复用）；CDP `9333`；端口转发用例另占 `15210`；**未占用并行视觉验证任务的 `2323/9455`**
> - 打包产物：`npm run build:unpack`（退出码 0，含 typecheck + 三端构建 + electron-builder --dir，afterPack 会把完整性标签重置为 Medium）→ `dist/win-unpacked/ssh-client.exe`，e2e 优先跑该产物

### 11.1 本轮新增 / 扩展的脚本

| 脚本 | 断言数 | 退出码 | 覆盖点 |
| --- | --- | --- | --- |
| `scripts/verify-forward.cjs`（新增） | 29 | 0 | local / remote / dynamic-SOCKS5 三种转发、端口占用可读错误、stop 后端口释放、连接引用计数回收 |
| `scripts/verify-config-io.cjs`（新增） | 49（另有 1 条非致命发现） | 0 | OpenSSH 配置解析、JSON 往返、导出不含凭据、重复导入计入 skipped、会话快照白名单与损坏降级 |
| `scripts/verify-resume.cjs`（新增） | 30 | 0 | 上传 / 下载断点续传逐字节一致、脏 `.part` 判定、多文件进度顺序 |
| `scripts/verify-perf.cjs`（新增） | 9 | 0 | 20MB 输出完整性 / 顺序 / 退出时序、批量合并条数、吞吐复核 |
| `scripts/e2e-smoke.cjs`（扩展） | **126**（既有 62 项全部保留，新增 64 项） | 0 | 主题、分组、导入导出入口、列宽拖拽、2000 行虚拟滚动、远程编辑提示、隧道面板、会话恢复 |

新增脚本一律沿用仓库既有做法：用 `typescript.transpileModule` 把 `src/main/*.ts` 转成 CJS 后加载**被测真实代码**，只把 `electron`（`app` / `dialog` / `safeStorage`）替换为可控桩，因此验证的是产品代码本身而不是复刻实现。

### 11.2 基线回归（串行执行，退出码全部为 0）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `npm run typecheck` | 0 | `typecheck:node` / `typecheck:web` 均通过，无输出 |
| `npm run lint` | 0 | eslint 无告警（`scripts/**` 按仓库配置不参与 lint） |
| `npm run verify:ssh` | 0 | `[结果] 全部通过，共 8 项` |
| `npm run verify:store` | 0 | `[结果] 全部通过，共 14 项` |
| `npm run verify:sftp` | 0 | `[结果] 全部通过，共 31 项` |
| `npm run verify:hostkey` | 0 | `[结果] 断言通过 31 项，非致命发现 0 项` |
| `npm run verify:quickconnect` | 0 | `[结果] 通过 91 项，失败 0 项` |
| `npm run verify`（5 脚本串联） | 0 | 合计 **175** 项断言，与本轮基线口径一致，未削弱任何既有断言 |
| `npm run build:unpack` | 0 | 构建 + 打包成功，产物 `dist/win-unpacked/ssh-client.exe` |

### 11.3 `scripts/verify-forward.cjs`（新增，29 项，退出码 0）

做法：起一个真实 ssh2 服务端（`127.0.0.1:2222`）与一个本地回显服务；服务端 `tcpip` 事件按请求的 `destPort` 真实连到目标（direct-tcpip），并实现 `tcpip-forward` / `cancel-tcpip-forward` 全局请求；客户端侧用 `src/main/forward.ts` 的 `ForwardManager` + `src/main/ssh.ts` 的真实连接池。

| 用例 | 目的 | 入参 | 出参 | 预期 | 实际 |
| --- | --- | --- | --- | --- | --- |
| local | 本地转发连通 + 双向数据 | `{type:'local', localHost:'127.0.0.1', localPort:15101, remoteHost:'127.0.0.1', remotePort:<回显服务>}` | `status='running'`，`title='转发验证目标 · 本地转发'` | 隧道端口可连、收到目标问候、中文往返完整、`connections` 计数被推送 | 通过（收到 `TARGET-HELLO` 与 `PING-本地转发`，计数 1） |
| 端口占用 | 失败可读且不抛异常 | 先占住 15102，再启动同端口规则 | `status='error'` | 中文说明指明「端口已被占用」 | 通过：`端口已被占用，请换一个端口或先停止占用它的程序（监听 127.0.0.1:15102）` |
| 非法端口 | 入参校验 | `localPort=0` | `status='error'` | 中文说明 1-65535 | 通过：`监听端口必须是 1-65535 之间的整数` |
| stop | 端口释放 + 连接销毁 | `manager.stop(id)` | `status='stopped'` | 已建隧道被断开、端口可重新绑定 | 通过（隧道 socket 收到 close，15101 可重新 listen） |
| dynamic | SOCKS5 连通 | `{type:'dynamic', localPort:15103}` + 手写 SOCKS5 客户端（域名寻址 `localhost`） | 应答码 `0` | 握手成功、数据双向、目标不可达时回失败码 `1` | 通过（应答码 0 与 1，失败后规则仍为 running） |
| remote | 远端连接导到本机目标 | `{type:'remote', localHost:'127.0.0.1', localPort:15105, remoteHost/Port:<回显服务>}` | 服务端收到 `127.0.0.1:15105` 的监听请求 | 服务端发起 `forwarded-tcpip` 后数据双向；stop 时服务端收到 `cancel-tcpip-forward` | 通过（两条断言全部命中） |
| 目标不可达 | 单连接失败不毁规则 | 规则指向未监听端口，再连一次隧道 | `status='running'` + `message` | 只记录最后一条失败原因 | 通过：`转发通道被服务端拒绝，目标地址可能不可达或不被允许（转发到 127.0.0.1:15998）` |
| 引用计数 | 全部停止后释放底层连接 | `manager.dispose()` | 服务端连接数归零 | 无规则残留 running | 通过 |

### 11.4 `scripts/verify-config-io.cjs`（新增，49 项 + 1 条非致命，退出码 0）

| 用例组 | 目的 | 入参 | 预期 | 实际 |
| --- | --- | --- | --- | --- |
| OpenSSH 解析 | Host 块 / 多别名 / 通配 / 注释 / IdentityFile / 缺省值 | 含 4 个 Host 块 + 1 个通配块 + 行内注释 + 非法端口的 `config` 文件 | 导入 4 条；通配块整块跳过并给出原因；`Host web` → `10.0.0.10:2222/deploy` 私有钥认证且 `~` 展开；`db` 端口缺省 22、用户名回退系统用户；`only-alias` 主机名取别名 | 全部通过（含 `第 12 行：通配 Host「*.internal」不支持导入，已跳过`、`第 17 行：端口「0」不是合法端口，已按 22 处理`） |
| 重复导入 | 幂等 | 同一配置文件再导一次 | `imported=0 / skipped=4`，逐条「已存在」 | 通过，连接总数仍为 4 |
| JSON 导入 | 字段映射 / 分组 / 端口规范化 / 缺字段 | 3 条记录（1 合法 + 1 端口非法 + 1 缺主机） | 导入 2 条、`group` 保留、非法端口回退 22、缺主机跳过并说明 | 通过 |
| 异常输入 | 非数组 / 非法 JSON / 空配置 / 用户取消 | 4 个文件与取消路径 | 可读中文原因；取消返回 `null` 且无副作用 | 通过（含 `JSON 文件格式不正确，无法解析`） |
| 导出 | 格式选择 + 不含凭据 | 2 条连接（1 条带密码）导出 `.json` 与 `.conf` | 后缀决定格式；导出文本无密码明文、无 `secret` 字段；别名空白转 `-`；含空格私钥路径加引号 | 通过（两种格式各 5 项断言） |
| 分组批量调整 | `store.assignGroup` | `[id1,id2] → '  生产  '`，再把 id1 移出 | 分组名去空白、落盘、留空表示移出且不写空串 | 通过 |
| 会话快照 | 白名单 / 上限 / 损坏 / 清除 | 含 `password`、`host` 的多余字段、60 个标签、损坏 JSON | 只落 `kind` + `connectionId`（绝不写凭据与主机）；上限 50；损坏备份 `.bak` 并返回 `null`；空快照等于清除 | 通过 |

**非致命发现（1 条，等级：低-中）**：导出时对含空格的私钥路径加引号，导入时不去引号，导致往返不一致：

```
导出：IdentityFile "C:\Users\John Doe\.ssh\id_rsa"
导入后：privateKeyPath = "\"C:\\Users\\John Doe\\.ssh\\id_rsa\""   ← 仍带引号
```

Windows 登录名带空格的用户（`C:\Users\John Doe\...`）导出再导入后，该连接的私钥路径不可用，连接时会报「无法读取私钥文件」。建议在解析 `IdentityFile` 时去掉成对的引号（OpenSSH 自身允许引号值）。不影响本轮其余用例。

### 11.5 `scripts/verify-resume.cjs`（新增，30 项，退出码 0）

做法：内存 SFTP 服务端上加**故障注入**（偏移 ≥ 256KB 的 WRITE 一律返回 FAILURE 且不写任何字节），用真实 `SftpManager` 跑「中断 → 重试」。

| 用例 | 目的 | 入参 | 预期 | 实际 |
| --- | --- | --- | --- | --- |
| 上传中断 | 远端只留已确认前缀 | 1MB 文件，故障点 256KB | 以异常返回；远端 262144 字节且与本地前 N 字节一致；被拒绝的写 1 次 | 通过：`服务端拒绝执行该操作（上传文件；原始错误码 4：Failure）` |
| 上传续传 | 不重传已完成部分 | 关闭故障后重试同一文件 | 首条进度 `resumed=true`；**只发送剩余 786432 字节**；最终逐字节一致 | 通过（远端与本地 SHA 级一致，`writtenBytes=786432`） |
| 断点清除 | 成功后不误续传 | 同一文件再传一次 | 首条进度无 `resumed`、从头开始、写入完整 1MB | 通过（先截断再写，无尾部残留） |
| 下载续传 | 复用 `.part` | 远端 1MB；本地 `.part` 预置前 307200 字节 | `resumed=true`；**服务端最小读取偏移=307200**；最终逐字节一致；`.part` 改名消失 | 通过（本轮读取 741376 字节） |
| 脏 `.part` | 等长 / 过大按重下处理 | `.part` 等于远端、`.part` 大于远端 | 不标记 resumed、从偏移 0 重下、最终内容正确 | 通过 |
| 多文件 | 逐个上传、进度有序 | 2×128KB | 按入参顺序返回；进度按文件先后；前一个先报完成 | 通过 |

### 11.6 `scripts/verify-perf.cjs`（新增，9 项，退出码 0）+ 对 README 性能结论的复核

README「架构要点」的结论是「不回退到 `MessageChannelMain`」，依据是 20MB 连续输出下端口路径与 IPC 路径差异被噪声淹没、瓶颈在 ssh2 侧（45~70MB/s）、批量合并已把 20MB 压成 35~45 条消息。本脚本用同一口径复跑：

| 指标 | 本轮实测（两次运行） | README 说法 | 结论 |
| --- | --- | --- | --- |
| 20MB 完整性 | 字节数 20971532/20971532、SHA-256 与源负载一致、抽查 6 个 1KB 块的块号与偏移一一对应 | — | **通过**：逐字节不丢、顺序不乱 |
| 退出时序 | 退出事件触发时已收满 20971532 字节（`会话已关闭`） | — | **通过**：退出事件在全部数据之后 |
| 批量合并条数（20MB / 64KB 分片） | 21 条、32 条（平均 640KB~975KB/条） | 35~45 条 | 同量级，合并效果甚至更强（结论方向一致） |
| 4KB 分片 | 1024 个分片 → **5 条**消息 | 「合成压力下端口路径在 512KB/64KB 分片反而慢约 20%」 | 分片被有效合并，与结论方向一致 |
| 纯 ssh2 数据段吞吐 | **284~312MB/s** | 45~70MB/s | **相差约 5 倍，README 的绝对数字不可复现** |
| 会话管理器路径（IPC 之前） | 81~144MB/s（数据段 99~227MB/s） | — | 应用层批量合并未成为瓶颈 |

**发现（等级：低-中，文档口径）**：README 的「45~70MB/s」在本机（同一台机器、同为 20MB、同走 ssh2）复现不出来——主进程侧纯 ssh2 数据段吞吐是 284~312MB/s，应用层 81~144MB/s（两次运行差异来自并行任务占用的 CPU 噪声）。README 的参考编号更可能来自**端到端（含渲染进程 xterm 写入）**的口径，而不是「ssh2 自身的加解密与包处理」。**结论方向仍然成立**：瓶颈在 ssh2 侧、IPC 通道不是瓶颈、批量合并有效（20MB 仅 21~32 条消息）。建议 README 标注测量口径（主进程侧 / 端到端）或改用「几十 MB/s~几百 MB/s 量级」的表述。

另外：`src/main/ipc.ts` 顶部注释与 README 都写有「测量方法与原始数据见 `scripts/verify-report.md` 的性能章节」——在本轮之前该章节**并不存在**（悬空引用），本节即为其补上的内容，引用现已成立。

### 11.7 端到端 `scripts/e2e-smoke.cjs`（扩展后 126 项，退出码 0；既有 62 项全部保留）

运行形态：`dist/win-unpacked/ssh-client.exe`（打包产物）+ 临时 userData + 真实 ssh2 服务端（含内存 SFTP 与 direct-tcpip），CDP 驱动真实 UI。新增 64 项断言，全部为硬断言（失败即非零退出）。

> **构建与源码时序（重要）**：本轮共跑了两次完整 e2e ——
> ① 13:21 构建的产物（对应 `src/**` 13:10~13:14 的源码）→ `全部通过，共 126 项`，退出码 0；
> ② 并行任务在 13:47:17 又改过 `src/renderer/src/assets/main.css`（视觉/样式层，未改 TS 逻辑），
> 因此 13:49 用 `npm run build:unpack` 重新打包（产物时间 13:49:28）后再跑一次 → 仍然 `全部通过，共 126 项`，退出码 0。
> 结论：本轮功能验证对应**最新源码**；若后续还有 `src/**` 改动，需重新打包复跑（命令见 11.10）。

| 新增用例组 | 关键断言（节选） | 结果 |
| --- | --- | --- |
| 主题（10 项） | 首次启动 `mode=null`（语义等价 system）且 `data-theme` 等于系统偏好；点击切到显式主题并写 localStorage；`color-scheme` 同步；**终端配色跟随**（`.xterm` 前景色 `rgb(231,234,240)` ↔ `rgb(31,36,48)`，两次切换现场确实不同）；Shift+点击回到跟随系统；重新加载后主题仍按 localStorage 生效 | 通过 |
| 分组（6 项） | 「移动到分组…」弹窗保存 → 侧栏出现分组标题；IPC 回读 `[["E2E 测试机","E2E 分组"],["E2E 界面连接",null]]`；点分组标题折叠（连接 2→1 项）与展开 | 通过 |
| 导入导出（3 项） | 侧栏「导入」「导出」入口存在且文案正确；`window.api.connections` 的 `importFromFile/exportToFile/assignGroup` 均为 function（预加载链路接通）；**不点击**（原生对话框无法用 CDP 关闭，文件级行为由 11.4 覆盖） | 通过 |
| SFTP 列宽（6 项） | 表头 3 个手柄；拖动 +40px → 136px 且数据行同宽；拖 -1000px 钳制到最小 72px；双击复位 96px | 通过 |
| 虚拟滚动（5 项） | 2000 项目录只渲染 **27** 行 DOM；占位高度 64008px；滚动到底部渲染出 `f-1999.txt`；**响应 9.6~18.0ms**；滚动后 DOM 仍 27 行 | 通过 |
| 远程编辑（4 项） | 每行存在「用系统程序编辑」入口；远端文件不可读时面板提示 `路径不存在（下载 /home/readme.txt；原始错误码 2：No such file or directory）`（不触发真实编辑器） | 通过 |
| 端口转发面板（7 项） | 「隧道」按钮打开面板；填 local 规则（连接=`E2E 测试机`、监听 15210、目标=本地回显服务）→ 状态「运行中」；**隧道真实双向数据**；面板「连接 1」；停止后状态「已停止」且 15210 可重新绑定；关闭面板 | 通过 |
| 会话恢复（19 项） | 快照落盘只含 `{kind, connectionId}` 且不含凭据；`location.reload()` 后应用重挂载、主题持久化生效、提示条 `上次有 1 个会话（终端 1 / 文件 0），是否恢复？` 并列出连接名；点「恢复」重开终端并收到远端欢迎语、提示条消失、快照被清除；第二次快照（SFTP）→ 重新加载 → 「忽略」→ 提示条消失且 `session.list` 读回 `null`；两次重新加载后均无未捕获异常、根节点未卸载 | 通过 |

> 附带发现（测试脚本层面，非产品缺陷）：e2e 跑到 SFTP 用例时，测试 9 打开的 SFTP 会话已被「主机密钥变更 → 服务端重启」带走（主进程日志 `sftp:list → SFTP 会话已关闭，请重新打开`），因此新增用例先关闭失效标签再重新打开面板；同时新增用例会把激活标签切到 SFTP，故在既有搜索用例前显式切回终端标签。两处都只增强了前置条件，**未改动、未削弱任何既有断言**。

### 11.8 通过 / 失败清单（本轮）

| 类别 | 结果 |
| --- | --- |
| 基线 5 脚本 | 175 项断言通过，退出码 0 |
| 本轮新增脚本 | 29 + 49 + 30 + 9 = **117** 项断言通过，退出码均为 0 |
| 端到端 | **126** 项通过（既有 62 项无回归 + 新增 64 项），退出码 0 |
| 失败项 | **0** |
| 非致命发现 | 1 条（`verify-config-io.cjs`：IdentityFile 引号未去，见 11.4） |
| 文档 / 口径发现 | 2 条（README 悬空引用性能章节；README 45~70MB/s 口径不可复现，见 11.6） |

### 11.9 未覆盖项与风险等级

| 未覆盖项 | 原因 | 风险等级 | 补偿证据 |
| --- | --- | --- | --- |
| 导入 / 导出**原生文件对话框**的真实交互 | 主进程 `dialog.showOpenDialog/showSaveDialog` 是系统模态框，CDP 无法关闭，点了会挂住后续用例 | 低 | 入口 + `window.api` 链路已在 e2e 断言；解析 / 跳过 / 去凭据 / 往返由 11.4 用真实代码 + 文件覆盖 |
| 远程编辑**成功路径**（真的用系统默认程序打开，保存后自动回传） | 自动化环境会真的拉起编辑器窗口，且会干扰并行运行的视觉验证 | **中** | 入口存在 + 失败提示中文化已断言；`edit.ts` 的下载 / `shell.openPath` / 回传链路本轮**没有**端到端覆盖，建议人工点一次 |
| 端口转发 remote / dynamic 的**面板**操作 | e2e 只驱动了一条 local 规则（面板交互成本高） | 低 | 三种模式在 11.3 用真实协议 + 真实管理器全覆盖 |
| 系统深色偏好在**运行中**变化（`prefers-color-scheme` 监听） | 需改操作系统设置 | 低 | `subscribeTheme` 的显式切换路径已断言；系统偏好变化路径仅代码层可见 |
| 20MB 输出在 **IPC 序列化 + xterm 渲染**段的完整性 | 11.6 只覆盖到主进程 `onData` 边界（即 IPC 之前） | 低-中 | 与上一轮口径一致；渲染段完整性由 e2e 的终端交互用例间接覆盖 |
| 断点续传在**真实网络中断 / 进程崩溃**下的行为 | 用服务端拒绝写入注入故障，等价于「远端写失败」，不等价于链路中断 | 低 | 断点记录只用内存字典，语义上重启即重新开始（README 已声明） |
| 主题在**多窗口**、`known_hosts` 变更发生在 SFTP 路径等 | 沿用上一轮未覆盖项，本轮无变化 | 低 | 见第十节 10.5 |

### 11.10 本轮复现指引

```powershell
cd <repo>

# 基线（串行；全部占用 127.0.0.1:2222，勿并发）
npm run typecheck; npm run lint
npm run verify                      # 期望：8 + 14 + 31 + 31 + 91 = 175 项，退出码 0

# 本轮新增脚本（逐个串行，同样占用 2222；verify-forward 与 verify-resume 各自起真实服务端）
node scripts/verify-forward.cjs     # 期望：全部通过，共 29 项
node scripts/verify-config-io.cjs   # 期望：断言通过 49 项，非致命发现 1 项（IdentityFile 引号）
node scripts/verify-resume.cjs      # 期望：全部通过，共 30 项
node scripts/verify-perf.cjs        # 期望：全部通过，共 9 项 + 3 行 [数据] 吞吐/消息数

# 端到端（必须先用最新源码打包，否则跑的是旧产物）
npm run build:unpack
node scripts/e2e-smoke.cjs           # 期望：全部通过，共 126 项，退出码 0
```

> 注意：`scripts/**` 未加入 `package.json` 的 npm scripts（本轮写入范围仅限 `scripts/**`），新增脚本请按上面的 `node scripts/...` 方式调用；如需固化为 `npm run verify:*`，由 lead 在 `package.json` 里补一行即可。

---

## 十二、第四轮（task-22）：按用户要求移除的功能与测试清理

- **验证人**：verifier3（独立验证，写入范围仅 `scripts/**`；未修改任何 `src/**`，也未执行任何 git 操作）
- **时间**：2026-11-20 14:14–14:45（Asia/Shanghai）
- **背景**：用户实际使用后要求移除三项功能，lead 已删除源码与样式（`quickConnect.ts`、`config-io.ts`、`forward.ts`、`ForwardPanel.tsx`、侧栏快速连接卡片与操作行、`.fwd-*` 样式、`defaultUsername`/`connImport`/`connExport`/`forward:*` 契约），并新增「编辑连接回显已保存凭据 + 小眼睛」与「弹窗遮罩只在按下与松开都落在遮罩本身时才关闭」。本轮把测试与截图脚本里对应的用例清掉，并为两项新行为补覆盖，然后复跑全量。

### 12.1 删除清单

| 对象 | 规模 | 说明 |
| --- | --- | --- |
| `scripts/verify-quickconnect.cjs` | 283 行（历史记录 79→91 项断言） | 被测源码 `src/renderer/src/quickConnect.ts` 已删除，脚本失去被测对象 |
| `scripts/verify-forward.cjs` | 630 行（29 项断言） | 被测源码 `src/main/forward.ts` 已删除，`forward:*` 契约已移除 |
| `scripts/verify-config-io.cjs` | 560 行（49 项断言 + 1 条非致命） | 被测源码 `src/main/config-io.ts` 已删除，`connImport`/`connExport` 已移除 |
| `package.json` 的 `verify` 串 | — | lead 已同步为 6 个脚本：`ssh / store / sftp / hostkey / resume / perf`（本轮核对无残留引用） |
| e2e 用例 12.8（导入导出入口 + `window.api` 链路） | 3 项断言 | 功能已移除 |
| e2e 用例 12.12（端口转发面板启停 + 真实隧道往返） | 7 项 | 功能已移除 |
| e2e 用例 7 的「快速连接输入框可写入地址」 | 1 项 | 输入框已不存在，用例整体改走点击已保存连接 |

> 历史章节（第一至十一节）**未做任何删改**，其中的 `verify-quickconnect.cjs` / `verify-forward.cjs` / `verify-config-io.cjs` 记录保留为当时的事实。

### 12.2 `scripts/e2e-smoke.cjs`：逐处改用的方式

改造原则：**优先保留 UI 路径**，只有确实没有 UI 入口时才退回 `window.api`。

| 原用例 | 原驱动方式 | 现驱动方式 |
| --- | --- | --- |
| 2 保存连接 + 加密落盘 | 直接 `window.api.connections.save(...)` | 改为「+ 新建 → 填表 → 保存」的**真实表单路径**（底层仍是同一个 `connections.save` IPC），随后经 `connections.list()` 取回 id；「列表不泄漏凭据」「落盘为密文」两条断言原样保留 |
| 7 打开会话 | `.quick-connect input` 写 `127.0.0.1:2222` + 回车 | 点击侧栏**已保存连接**（`.conn-item .conn-main`）；该连接由 2 号用例的表单创建，侧栏提交后自动刷新（无需重载页面） |
| 10 失败 Toast | quick-connect 连未监听端口 59998 | 表单新建「E2E 未监听端口」（127.0.0.1:59998）→ 点它开终端 → `.toast.error` 中文提示；`error` 分级类名与点击关闭断言保留 |
| 11 主机密钥变更 | inline 临时连接 `e2e-hk@127.0.0.1:2222`（靠不同用户名换新复用键） | 表单新建「E2E 密钥变更机」（username=`e2e-hk`）→ 点它；连接池的复用键是**连接 id**，该 id 从未成功进池，必然重新握手（等价于原来的「换复用键」意图） |
| 11.y 服务端下线 | inline 连接 `e2e-hk-offline@...` | 同一条已保存连接再点一次（此时仍未进池），断言改为「中文 ECONNREFUSED 且不误报密钥变更」 |
| 11.z 恢复后重连 | 同 11.y 的 inline 地址 | 同一条已保存连接再点一次 → 复现密钥变更弹窗 → 信任并重连 |
| 12.1 窗口标题 | `e2e-hk@127.0.0.1 · SSH 客户端` | `E2E 密钥变更机 · SSH 客户端`（标签标题取已保存连接的名称，`App.tsx` 的 `document.title` 规则未变） |
| 12.8 导入导出 | 入口按钮 + `importFromFile`/`exportToFile` 链路 | **整案删除**（编号不复用，保留占位注释以便与历史报告对照） |
| 12.12 端口转发面板 | `.sidebar-actions button[title="端口转发"]` + `exchangeThroughTunnel` 往返 | **整案删除**（同上） |

同步清理的无用代码：`PAGE_HELPERS` 里的 `setFwdField` / `setFwdSelect` / `fwdStatus` / `fwdText`；脚本级 `startEchoService` / `tryListen` / `exchangeThroughTunnel` 与常量 `FORWARD_TUNNEL_PORT`；测试 SSH 服务端仅供转发用的 `tcpip`（direct-tcpip）分支；随之失去引用的 `net` 依赖。

新增的页面内辅助函数（供新用例复用）：`findConnection` / `openConnection` / `clickConnectionAction`（按名称操作侧栏连接项）、`fieldState` / `clickFieldEye`（密码框状态与小眼睛）、`maskGesture('inside-to-mask' | 'mask-only')`（模拟遮罩上的按下与松开组合），以及脚本级 `createConnectionViaForm()`（表单建连，提交后等侧栏自动刷新）。

### 12.3 `scripts/ui-shot.cjs`：改造与最终状态清单

| 位置 | 改动 |
| --- | --- |
| 种子连接 | 原本就是 `window.api.connections.save` + 重载判定，**无需改动**（quick-connect 从未参与种子） |
| 09-toast | 去掉 `.quick-connect input` 驱动；改为**编辑「备份节点」临时指向 127.0.0.1:2399 → 点它开终端**，走与用户一致的 UI 路径；新增该步的 `verify` 钩子，截图后把配置改回 `10.20.0.51:22`，避免污染 10 步之后的画面 |
| 15-forward | 整步删除（面板已不存在），编号不复用；16 的前置依赖由 `15` 改为 `14` |
| 侧栏操作行 | `shot.openForward` / `shot.fwdRows` 两个辅助函数一并删除（`.sidebar-actions` 已无任何引用） |
| contrast 检查 | 删除「第六段：端口转发面板空态 / 运行中 / 已停止」3 张取样；令牌审计里删除「快速连接提示文案」「快速连接解析错误」2 项 |
| 关闭浮层兜底 | 保留 `.modal-foot` 文案为「关闭」的兜底点击（当前弹窗均为「取消」，注释已改为防御性说明） |
| 旧产物清理 | `scripts/ui-shots/after/` 下上一轮遗留的 `15-forward.png` 与 `contrast-forward{,-empty,-stopped}.png` 已删除（脚本只清理本次计划产出的同名文件，不删会误导「该状态仍存在」）；`before/` 作为历史基线保持只读不动 |

**最终清单（18 张，编号 01–14 与 16–19，15 号空缺）**：`01-empty`、`02-connections`、`03-terminal`、`04-multi-tab`、`05-search`、`06-context-menu`、`07-sftp`、`08-conn-form`、`09-toast`、`10-narrow`、`11-min`、`12-light`、`13-light-sftp`、`14-groups`、`16-restore`、`17-hidpi`、`18-bigdir`、`19-light-dialog`；检查 `dpr`、`drag`、`contrast` 三项照旧。

### 12.4 新增覆盖（本轮 e2e 新增 26 项）

**1.1 移除确认（4 项）**：在打包产物里断言三项功能的入口与接口确实不存在——`.quick-connect` 不存在、`.sidebar-actions` 与 title 含「导入/导出」的按钮不存在、`window.api.connections` 上没有 `importFromFile`/`exportToFile`、`window.api` 上没有 `forward`。现场回读：`{"quickConnect":false,"sidebarActions":false,"importButton":false,"exportButton":false,"importFn":"undefined","exportFn":"undefined","forwardApi":"undefined"}`。

**8.1 编辑连接回显已保存凭据（9 项）**：打开「E2E 测试机」的编辑表单 → 密码框 value 为 `s3cret-pw`（证明 `connections.getCredential` 回显生效）→ 初始 `type=password`、小眼睛 `title=显示密码`、`aria-pressed=false` → 点小眼睛后 `type=text`、`aria-pressed=true`、值仍为真实密码 → 再点回 `type=password`、`aria-pressed=false` → **不改动直接保存** → `connections.getCredential` 回读仍为 `{"password":"s3cret-pw"}`（证明留空提交不等于清空）→ 再次打开编辑表单仍回显该密码。

**8.2 弹窗遮罩不误关（4 项，覆盖全部三个带遮罩的弹窗）**：`ConnectionForm` 上「弹窗内 mousedown → 遮罩上 mouseup + click」弹窗仍在（复现用户报的「长按后松手弹窗消失」路径），「遮罩上 mousedown + mouseup + click」正常关闭；`HostKeyDialog`（11.0）与「移动到分组」弹窗（12.7a）各加一条同样的「不误关」断言。

**表单建连路径（9 项）**：2 号用例建「E2E 测试机」（带密码）、10 号建「E2E 未监听端口」、11 号建「E2E 密钥变更机」，每条都断言「打开表单 → 提交后弹窗关闭 → 侧栏出现新连接（列表自动刷新）」。

**既有用例未削弱**：删除的 11 项全部来自已移除功能；其余用例逐字保留，仅因「标签标题由连接名决定」调整了 12.1 的期望字符串。

### 12.5 本轮复跑结果

| 步骤 | 命令 | 结果 |
| --- | --- | --- |
| 基线回归（6 脚本串行） | `npm run verify` | 8 + 14 + 31 + 31 + 30 + 9 = **123 项断言通过，失败 0，退出码 0** |
| 打包 | `npm run build:unpack` | `typecheck:node` / `typecheck:web` 通过，`electron-vite build` 通过，`electron-builder --dir` 产出 `dist/win-unpacked`，退出码 0 |
| 端到端 | node scripts/e2e-smoke.cjs | **141 项通过，失败 0，退出码 0**（上一轮 126 项：删除 11 项、新增 26 项、7 处改写驱动方式；跑的是 `dist/win-unpacked` 打包产物） |
| 界面取证 | `node scripts/ui-shot.cjs --only=all --checks=all`（`E2E_ELECTRON_BIN` → `%TEMP%\ui-shot-electron\electron.exe`，端口 2323/9455） | **18 张截图 + 3 项检查全部完成，失败 0，退出码 0** |

关键证据（截取）：

- `[通过] 侧栏不再有快速连接卡片（.quick-connect 不存在）`
- `[通过] 侧栏不再有导入 / 导出操作行（现场 {"quickConnect":false,"sidebarActions":false,"importButton":false,"exportButton":false,"importFn":"undefined","exportFn":"undefined","forwardApi":"undefined"}）`
- `[通过] window.api.connections 上不再暴露导入 / 导出接口` / `[通过] window.api 上不再暴露端口转发接口（forward:*）`
- `[通过] 编辑表单回显了已保存的密码（密码框 value 非空）`
- `[通过] 点小眼睛后密码框切明文且内容为真实密码（type=text，aria-pressed=true）`
- `[通过] 不改动保存后凭据仍在（getCredential 回读 {"password":"s3cret-pw"}）`
- `[通过] 在弹窗内按下、在遮罩上松手不会误关弹窗（仍为「编辑连接」）`
- `[通过] 按下与松开都落在遮罩上时弹窗正常关闭`
- `[通过] 主机密钥弹窗不会因在弹窗内按下、遮罩上松手而误关`
- `[通过] 移动到分组弹窗不会因在弹窗内按下、遮罩上松手而误关`
- `[通过] 点击侧栏已保存连接后出现新终端标签` / `[通过] 点击已保存连接打开的终端显示远端欢迎语（首屏输出未丢失）`
- `[通过] 服务端下线时给出中文 ECONNREFUSED 且未误报密钥变更（…原始错误码 ECONNREFUSED…）`

界面取证的目视核对（`read_image`）：

- `02-connections.png`：侧栏只剩搜索框 + 6 条连接，**快速连接卡片与导入/导出操作行均已消失**；
- `09-toast.png`：右下角为红边错误提示「目标端口未开放或 SSH 服务未启动（连接 127.0.0.1:2399；原始错误码 ECONNREFUSED…）」，此时「备份节点」显示为 `backup@127.0.0.1:2399`（临时改动，符合该状态的构造方式）；
- `10-narrow.png`：「备份节点」已恢复为 `backup@10.20.0.51:22`，证明 09 步的还原逻辑真实生效。

### 12.6 失败项与发现

**失败项：0。**

以下为**只报告、未修改**（均在 `src/**` 或 `README.md`，超出本轮写入范围）：

| 级别 | 发现 | 位置 | 说明 |
| --- | --- | --- | --- |
| 中（用户可见的失效文案） | 空状态提示仍在教用户用已删除的快速连接 | `src/renderer/src/components/WorkspaceTabs.tsx:66-67` | 文案为「…也可以直接在侧边栏顶部输入 user@host:22 回车直连。」——侧栏顶部已没有该输入框，用户照做会找不到入口。建议改为「点左侧连接或 Ctrl+N 新建连接」 |
| 低（文档过期） | README 仍在介绍三项已删功能 | `README.md:125-126、142、169-170、174、180、183、189` | 导入/导出、快速连接、端口转发的功能说明、取舍与「待办」条目均需同步删除或改写 |
| 低（无用样式） | `.modal-actions` 兼容规则已无任何组件使用 | `src/renderer/src/assets/main.css:1220-1226` | 其唯一使用者是已删除的转发面板；注释写的是「兼容未分栏的旧结构」，可一并清理 |

**既有（非本轮引入）观察**：ui-shot 的浅色对比度令牌审计仍有 1 项低于 4.5:1——`标签栏激活符号（非文本） #3b6fd4 on #e9ecf1 = 4.02 : 1`；`verify-perf.cjs` 仍打印既有非致命项（README 的 45~70MB/s 吞吐口径在本机不可复现）。两项与第三轮结论一致，本轮无变化。

### 12.7 本轮复现指引

```powershell
cd <repo>

# 1) 基线（6 脚本串行，勿并发，全部占用 127.0.0.1:2222）
npm run verify                        # 期望：8 + 14 + 31 + 31 + 30 + 9 = 123 项，退出码 0

# 2) 打包（端到端脚本优先跑 dist/win-unpacked，必须先打包再跑 e2e）
npm run build:unpack

# 3) 端到端（真实 Electron + CDP 驱动 UI）
node scripts/e2e-smoke.cjs            # 期望：全部通过，共 141 项，退出码 0

# 4) 界面取证（开发态需 out/ 已构建；E2E_ELECTRON_BIN 指向 %TEMP% 副本，端口保持 2323/9455）
$env:E2E_ELECTRON_BIN="$env:TEMP\ui-shot-electron\electron.exe"
node scripts/ui-shot.cjs --only=all --checks=all
# 期望：18 张截图 + 3 项检查（dpr / drag / contrast），退出码 0
```

> 说明：`verify-quickconnect.cjs`、`verify-forward.cjs`、`verify-config-io.cjs` 已随功能移除而删除，第三节 11.3 / 11.4 与第四节的历史命令不再适用，保留原文仅供追溯。

## 十三、第五轮（task-24）：交互增强验证（复制连接凭据 / 字号缩放 / 侧栏宽度 / SFTP 单击进入）

- **验证人**：verifier4（独立验证；写入范围仅 `scripts/**`，未修改任何 `src/**`，未执行任何 git 操作）
- **时间**：2026-11-20 14:57–15:40（Asia/Shanghai）
- **背景**：用户实际使用后提出 4 条反馈，lead 与两名实现者已完成源码改动，本轮独立验证并补齐测试覆盖：
  1. 复制连接要带上已保存的密码（`App.tsx` 的 `duplicateConnection` 传 `inheritedCredentialFrom`，`ConnectionForm` 复用按需回显）；
  2. 终端字号缩放（`TerminalView.tsx` 的 Ctrl+滚轮 + `.term-hud`，`TerminalContextMenu.tsx` 新增「放大 / 缩小 / 复位字号」，主进程 `Menu.setApplicationMenu(null)`）；
  3. 侧栏可拖动分配宽度（`.app` 改为 `var(--sidebar-width,300px) 6px minmax(0,1fr)`，`App.tsx` 渲染 `.splitter`，默认由 272 调大到 300）；
  4. SFTP 单击目录即进入、文件单击只选中（`SftpPanel.tsx` 的 `DIRECTORY_CLICK_GUARD_MS = 500` 防误触窗口）。

### 13.1 本轮脚本改动（仅 `scripts/**`）

| 文件 | 改动 |
| --- | --- |
| `scripts/e2e-smoke.cjs` | 新增 12.13 / 12.14 / 12.15 / 12.16 四组用例（**74 项新断言**）+ 15 节「重新加载后侧栏宽度恢复」1 项，合计 **75 项**；`connectCdp` 增加 `dispatchMouse` / `dispatchCtrlWheel` / `setViewport` / `clearViewport` / `sendCommand`；测试 SSH 服务端的 SFTP 处理器增加 `OPENDIR` / `OPEN` 计数（`sftpStats`，在协议层取证调用次数）；内存文件系统补 `e2e-dir`、`e2e-dir2/sub` 两个小目录；12.4 的右键菜单断言扩展为「必须含放大 / 缩小 / 复位字号」 |
| `scripts/ui-shot.cjs` | 17-hidpi 的像素复查去掉写死的 `?? 272`（改为跟随 `--sidebar-width` / 运行时实测右边界）；因旧「侧栏 1px 右边框」已被新的 6px 拖拽手柄列 + 居中 1px 竖线取代，改为断言「分隔带 = 6 CSS px = 12 设备像素且紧贴侧栏右边界」+「1px 竖线覆盖率 = dpr（2 个设备像素）且居中」，断言强度不低于原来 |
| `scripts/verify-report.md` | 本节（历史第一至十二节未做任何删改） |

### 13.2 用例与实测数值

**A. SFTP 单击进入目录 / 单击文件只选中（12.13，17 项）**

| 断言 | 实测 |
| --- | --- |
| 目录行 / 文件行存在 | `{"目录行":true,"文件行":true}` |
| 单击目录后路径栏进入该目录 | `/home` → `/home/e2e-dir`，列表出现 `inside.txt` |
| 单击目录时该行先进入选中态 | 采样时间线 `click 返回时 selected=false → +1ms selected=true`（React 在下一任务刷新，故用 0~32ms 短采样而非同步读） |
| 目录行 title 提示 | `单击进入 e2e-dir` |
| **一次单击只列一次目录** | 服务端 OPENDIR `6 → 7`（+1） |
| 双击目录只进一层 | 浏览器事件序列 click→click→dblclick 只产生 1 次 OPENDIR（`8 → 9`），第二下被 500ms 防误触窗口忽略 |
| 单击文件只选中不导航 | 路径仍为 `/home`；该行 `.selected` 为真；OPENDIR `13 → 13`、OPEN `1 → 1` |

**B. 侧栏拖动分配宽度（12.14，22 项）**

| 断言 | 实测 |
| --- | --- |
| 默认宽度（本轮由 272 调大到 300） | CSS 变量 `300px`，`.sidebar` 实测 300px，`localStorage` 为空（默认值来自代码） |
| 分隔条可访问性 | `role=separator`、`aria-label=调整侧栏宽度`、`tabIndex=0` |
| 按住后进入拖动态 | `.splitter.dragging` 与 `body.resizing` 同时为真 |
| 拖动中实时跟随、未落盘 | 宽度已到 `360px`，`stored=null` |
| 松手后生效并持久化 | 实测 360px，`aria-valuenow=360`，`stored=360` |
| 最小钳制 | 拖到 x=100 → **240px**（`stored=240`） |
| 最大钳制 | 拖到最右 → **560px** = min(560, 窗口宽 1267-480) |
| 窄窗口收拢 | CDP `Emulation.setDeviceMetricsOverride(900x680)` → **420px** = min(560, 900-480)；取消覆盖后窗口回到 1267px，宽度保持 420px（不会弹回 560） |
| 双击复位 | 真实 CDP 双击（clickCount=1 → clickCount=2）触发 `dblclick`，复位 **300px** 且 `stored=300`（未走到合成事件兜底路径） |
| 方向键微调 | ArrowRight → 316px → 332px，ArrowLeft → 316px，Home → 300px，再两次 ArrowRight 停在 332px |
| 持久化终值 | `stored=332`、实测 332px |
| **重新加载后按持久化恢复** | 15 节页面重新加载后 CSS 变量与实测宽度都是 `332px` |

**C. 终端字号缩放（12.16，20 项）**

| 断言 | 实测 |
| --- | --- |
| 基线 | `localStorage=14`，无残留 `.term-hud` |
| **Ctrl+滚轮放大**（CDP `Input.dispatchMouseEvent {type:'mouseWheel', modifiers:2, deltaY:-120}`） | 字号 14 → **15** 并持久化 |
| **devicePixelRatio 不变** | 全程 `2`（该机 dpr=2），未被 Chromium 抢去整页缩放 |
| 终端真实重排 | `.xterm-rows` 行高 `16 → 18px`、行字号 `14px → 15px`（不是只改了 localStorage） |
| **`.term-hud` 出现** | 文案「字号 15」 |
| **`.term-hud` 消失** | 从滚轮派发到消失实测 **1082ms**（源码设定 900ms），断言窗口 500~4000ms |
| Ctrl+滚轮缩小 | 14（HUD 文案「字号已复位」） |
| 右键菜单字号三项 | `复制Ctrl+Shift+C｜粘贴Ctrl+Shift+V｜全选｜查找Ctrl+F｜放大字号Ctrl+=｜缩小字号Ctrl+-｜复位字号Ctrl+0｜清屏` |
| 菜单项点击生效 | 放大字号 → 15；复位字号 → 14；缩小字号 → 13（并弹出 HUD「字号 13」），三次都断言菜单自动收起 |
| Ctrl+= / Ctrl+0 仍生效 | 13 → 14（`devicePixelRatio` 仍为 2），Ctrl+0 复位并弹「字号已复位」 |

**D. 复制连接带上已保存凭据（12.15，15 项）**

| 断言 | 实测 |
| --- | --- |
| 源连接确实存有密码 | `getCredential` 回读 `password="s3cret-pw"` |
| 复制表单回显密码 | 密码框 `value` 等于原值（不是占位符），`type=password` |
| 草稿内容 | 名称 `E2E 测试机 副本`，主机/端口/用户名沿用 `127.0.0.1:2222` / `tester` |
| 表单提示 | 「已从「E2E 测试机」带入密码与私钥口令，直接保存即可让副本沿用；清空输入框则副本不保存凭据。」 |
| **副本 `hasCredential` 为真** | `connections.list()` 回读 `hasCredential=true`，id 与源不同（`f7d5f192…` / `0a950a00…`） |
| 副本凭据真实落到副本 | `getCredential(副本)` 解密回读仍是 `s3cret-pw`；落盘 `connections.json` 里副本记录 `secret` 长度 56，明文未落盘 |
| **再次打开副本编辑表单密码仍是原值** | 编辑表单密码框 `value === 's3cret-pw'` |

> 取证说明：测试 SSH 服务端 `client.on('authentication', ctx => ctx.accept())` 接受任意认证，因此「副本能连上」不能证明凭据被复制；本轮以「主进程解密回读 + 密文落盘 + 二次回显」三条独立证据判定，未使用连接成功作为判据。

**证据日志**（保留在 `scripts/` 下以便复核，含失败与重跑全过程）：`e2e-run1.log`（防误触窗口导致失败）、`e2e-run2.log`（选中态采样过早导致失败）、`e2e-run3.log`（全绿 216 项）、`verify-6.log`（6 脚本）、`ui-shot-run.log` / `ui-shot-run2.log`（17-hidpi 失败）、`ui-shot-run3.log`（全绿）。

### 13.3 复跑结果（串行，全程独占 127.0.0.1:2222 / 9333 / 2323 / 9455）

| 步骤 | 命令 | 结果 |
| --- | --- | --- |
| 打包 | `npm run build:unpack` | `typecheck:node` / `typecheck:web` / `electron-vite build` / `electron-builder --dir` 全部退出码 0，产出 `dist/win-unpacked`（e2e 跑的即该产物） |
| 端到端 | `node scripts/e2e-smoke.cjs` | **216 项通过，失败 0，退出码 0**（既有 **141 项全部保留**，本轮新增 **75 项** = 12.13 的 17 项 + 12.14 的 22 项 + 12.15 的 15 项 + 12.16 的 20 项 + 重新加载持久化 1 项） |
| 基线回归（6 脚本串行） | `npm run verify` | **8 + 14 + 31 + 31 + 30 + 10 = 124 项通过，失败 0，退出码 0** |
| 界面取证 | `node scripts/ui-shot.cjs --only=all --checks=all`（`E2E_ELECTRON_BIN` → `%TEMP%\ui-shot-electron\electron.exe`，端口 2323/9455） | **18 张截图 + 3 项检查（dpr / drag / contrast）全部完成，失败 0，退出码 0** |

新增断言失败一律非零退出：本轮 e2e 前两次运行分别因「合成单击落在 500ms 防误触窗口内」「同步读选中态过早」而 `[失败]` + `EXIT=1`，修正采证方式后第三次全绿；ui-shot 前两次运行同样卡在 17-hidpi（第一次是旧描边假设未跟上新布局，第二次是我新写的断言字段取值写错）并以 `1 项失败` + `EXIT=1` 退出，改写后全绿。三次失败均如实返回非零码，符合「新增断言失败必须非零退出」的要求。

关键证据（截取）：

- `[通过] 单击目录只触发一次列目录请求（服务端 OPENDIR 计数 6 → 7）`
- `[通过] 双击目录只产生一次列目录请求（服务端 OPENDIR 计数 8 → 9，第二下被防误触窗口忽略）`
- `[通过] 单击文件未触发列目录也未打开文件（OPENDIR 13→13，OPEN 1→1）`
- `[通过] 拖到极大被钳制在 min(560, 窗口宽-480)=560px（窗口宽 1267，实测 560px）`
- `[通过] 窗口变窄到 900px 后侧栏从 560px 收拢到 420px（min(560, 900-480)）`
- `[通过] 重新加载后侧栏宽度按 localStorage 恢复为 332px（宽度持久化生效）`
- `[通过] Ctrl+滚轮向上滚一格把字号从 14 放大到 15 并持久化（localStorage=15）`
- `[通过] 缩放后 devicePixelRatio 仍为 2（Ctrl+滚轮没有被 Chromium 抢去整页缩放）`
- `[通过] 缩放提示自动消失（从滚轮派发到消失实测 1082ms，源码设定 900ms）`
- `[通过] 副本 hasCredential 为真（connections.list 回读 hasCredential=true）`
- `[通过] 再次打开副本编辑表单时密码仍是原值（凭据真的落在了副本上）`

界面取证的像素证据与目视核对：

- 17-hidpi：侧栏右边界 300px（跟随 `--sidebar-width`，不再是 272）；分隔带 12 设备像素（6 CSS px）且紧贴侧栏右边界；居中 1px 竖线覆盖率 `2`、逐像素覆盖 `[0,0,0,0,0,1,1,0,0,0,0,0]`（正好 2 个设备像素、偏移 5 居中）；
- 11-min（780x520 最小窗口）：标签栏 `scrollWidth=474 = clientWidth=474` 不溢出，侧栏 300px、工作区 474px，SFTP 面板可用；
- 06-context-menu.png 目视：右键菜单在「查找」与「清屏」之间新增「放大字号 Ctrl+= / 缩小字号 Ctrl+- / 复位字号 Ctrl+0」三项；
- 02-connections.png / 11-min.png 目视：侧栏明显比上一轮宽（300px），与工作区之间是一条细竖线（拖拽手柄列），未见错位或漏色。

### 13.4 未覆盖项与取证限制

| 项 | 原因 |
| --- | --- |
| 「单击文件不会下载」的**绝对**证明 | 下载路径会先弹原生保存框（主进程 `dialog.showSaveDialog`），e2e 无法确认/关闭原生框，也无法在渲染进程断言「未弹出」。现以「路径未变 + 行进入选中态 + 服务端未收到 OPEN」三条侧面证据判定，并**不触发**双击文件的路径 |
| 侧栏拖动的**视觉**拖影（`cursor: col-resize`、`user-select: none`） | 像素级取证需要拖动过程中的截图，本轮只断言了类名（`.splitter.dragging` / `body.resizing`）与宽度数值 |
| 缩放手势的触控板累计路径（阈值 40 的余量语义） | 只覆盖了单次 ±120 的滚轮；未模拟连续小 delta 的触控板序列 |
| 主进程 `Menu.setApplicationMenu(null)` 的直接断言 | CDP 只能访问渲染进程，无法直接读 `Menu.getApplicationMenu()`；改用可观察后果取证：Ctrl+= 改字号**且** `devicePixelRatio` 不变（默认菜单的 Zoom In 加速键会整页缩放并抢走按键） |
| 复制连接后**副本实际连接** | 测试服务端接受任意认证，连上与否不能证明凭据被复制（见 13.2 D 的取证说明），故不作为判据 |

### 13.5 发现（均在 `src/**`，按规范只报告、未修改）

| 级别 | 发现 | 位置 | 证据与建议 |
| --- | --- | --- | --- |
| 低（UX 纸割） | 500ms 防误触窗口以「**最近一次目录加载时刻**」为基准，而不是「刚被点进的那一行」，因此在窗口内点**另一个**目录也会被吞掉一次 | `src/renderer/src/components/SftpPanel.tsx:277、914` | 实测：进入 `e2e-dir2` 后 30ms 内点 `sub` → 路径停在 `/home/e2e-dir2`、OPENDIR `11 → 11`（被吞）；过窗口后再点正常进入。建议把窗口基准改成「刚刚由单击进入的那一行路径 + 时刻」，其余行不受影响 |
| 低（注释与实现差 6px） | 侧栏最大宽度按 `window.innerWidth - 480` 计算工作区下限，但工作区实际还要再扣 6px 拖拽手柄列 | `src/renderer/src/App.tsx:28-39`；`src/renderer/src/assets/main.css:296` | 最小窗口 780px 下侧栏取到上限 300px，工作区只有 780-300-6 = **474px**（比注释宣称的 480px 少 6px）；11-min 截图仍不溢出、不影响判定，若要严格兑现 480px 应把公式改为 `innerWidth - 486` |
| 观察（脚本口径变化） | `verify:perf` 由历史 9 项变为 **10 项** | `scripts/verify-perf.cjs:418-428` | 该脚本已把「纯 ssh2 数据段吞吐与 README 记录同量级」从非致命观察改为区间判定（140~400MB/s），本机实测 190.5MB/s 落在区间内，因此多出一项通过；第四轮报告里「45~70MB/s 口径不可复现」的非致命项在当前脚本下已不再出现 |
| 观察（断言加强） | 17-hidpi 的 1px 描边检查已按新布局改写 | `scripts/ui-shot.cjs`（17 步 verify） | 侧栏旧 1px 右边框已被 6px 拖拽手柄列 + 居中 1px 竖线取代，原写死 `?? 272` 的兜底已删除，改为实测分隔带宽度（12 设备像素）与竖线覆盖率（2.00）；断言强度不低于原来 |
| 既有（非本轮） | 浅色对比度令牌审计仍有 1 项低于 4.5:1：`标签栏激活符号（非文本） #3b6fd4 on #e9ecf1 = 4.02 : 1` | `src/renderer/src/assets/main.css` | 与第三、四轮结论一致，本轮无变化 |

### 13.6 本轮复现指引

```powershell
cd <repo>

# 0) 确认没有残留进程占端口（2222 / 9333 / 2323 / 9455）
Get-Process ssh-client,electron -ErrorAction SilentlyContinue

# 1) 打包（e2e 优先跑 dist/win-unpacked，必须先打包再跑 e2e）
npm run build:unpack

# 2) 端到端（真实 Electron + CDP 驱动 UI，含 CDP 真实鼠标 / 滚轮 / 视口覆盖）
node scripts/e2e-smoke.cjs            # 期望：全部通过，共 216 项，退出码 0

# 3) 基线（6 脚本串行，勿并发，全部占用 127.0.0.1:2222）
npm run verify                        # 期望：8 + 14 + 31 + 31 + 30 + 10 = 124 项，退出码 0

# 4) 界面取证（开发态需 out/ 已构建；E2E_ELECTRON_BIN 指向 %TEMP% 副本，端口保持 2323/9455）
$env:E2E_ELECTRON_BIN="$env:TEMP\ui-shot-electron\electron.exe"
node scripts/ui-shot.cjs --only=all --checks=all
# 期望：18 张截图 + 3 项检查（dpr / drag / contrast），退出码 0
```

> 本轮结论：4 项使用反馈的功能行为均已在打包产物上独立复现并通过；失败项 0；未覆盖项与取证限制见 13.4，`src/**` 的 2 条低级别发现与 2 条口径观察见 13.5，均只报告未修改。


