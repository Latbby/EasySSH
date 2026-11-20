# SSH 客户端

一个可保存连接的跨平台 SSH 客户端，基于 Electron + TypeScript 构建。

## 技术栈

| 层   | 选型                        | 说明                                        |
| ---- | --------------------------- | ------------------------------------------- |
| 壳   | Electron 44                 | 三平台共用一套代码                          |
| 构建 | electron-vite 6             | 主进程 / preload / 渲染进程统一构建与热更新 |
| 终端 | @xterm/xterm                | 终端渲染、尺寸自适应、链接识别              |
| SSH  | ssh2                        | 纯 JS 实现，同时支撑 shell 与 SFTP          |
| UI   | React 19                    | 连接列表、多标签工作区                      |
| 存储 | JSON + Electron safeStorage | 配置原子写盘，凭据加密存储                  |

## 目录结构

```
src/
├─ shared/types.ts        主进程与渲染进程共享的 DTO / VO / IPC 通道常量
├─ main/
│  ├─ index.ts            应用入口，创建窗口与注册 IPC
│  ├─ ipc.ts              IPC 处理器，把入参解析为可用的连接配置
│  ├─ ssh.ts              SSH 连接池与终端会话管理
│  ├─ sftp.ts             SFTP 会话与文件操作
│  └─ store.ts            连接配置持久化与凭据加解密
├─ preload/index.ts       经 contextBridge 暴露的业务 API
└─ renderer/src/
   ├─ App.tsx             根组件，编排连接列表、标签与会话
   ├─ types.ts            标签类型（终端 / SFTP）
   └─ components/         连接列表、连接表单、标签栏、工作区、终端视图、SFTP 面板
scripts/                  可独立运行的验证脚本
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

## 验证脚本

```bash
npm run verify:ssh    # SSH 协议链路：连接、shell、PTY 尺寸、UTF-8、窗口变更
npm run verify:store  # 存储安全：密码不明文落盘、凭据更新语义、原子写、损坏降级
npm run verify:sftp   # SFTP：目录浏览、上传下载、增删改、连接复用与引用计数
npm run verify:e2e    # 端到端：真实 Electron + IPC + safeStorage + 真实 SSH 会话
```

前三个脚本不启动 Electron，可在任意环境运行；`verify:sftp` 会在本地起一个内存文件系统的
SFTP 服务端，因此无需真实的 SSH 服务器。
`verify:e2e` 需要能启动 Electron 图形进程的桌面会话。

## 已实现

- 连接配置的新增、编辑、删除与持久化
- 密码与私钥口令经 Electron safeStorage 加密，明文不落盘，列表出参不回流凭据
- 同一连接的终端标签与 SFTP 面板共享一条 SSH 连接，减少握手与 `MaxSessions` 压力
- 多标签工作区，后台终端持续接收输出，切换不丢回滚缓冲
- 终端尺寸自动同步远端 PTY，全屏程序不错行
- 主机公钥采用 TOFU 校验，指纹变化时拒绝连接
- 会话断开后标签可一键重连
- SFTP 文件管理：目录浏览、上传、下载、重命名、删除、新建目录
- 配置文件的原子写与损坏降级

## 架构要点

- **凭据不出主进程**：渲染进程只拿到 `ConnectionVO`，密码与私钥内容始终在主进程内解密使用。
- **IPC 按会话 id 路由**：终端与 SFTP 操作都带各自 id，高频读写使用 `send` 而非 `invoke`。
- **连接池按引用计数持有连接**：shell 与 sftp 通道各自占用一次引用，关掉 SFTP 面板不会影响
  仍在使用的终端标签，全部释放后才断开 TCP 连接。
- **终端输出传原始字节**：主进程不把 Buffer 转成字符串，交给 xterm 的 UTF-8 解码器处理跨数据包的
  多字节字符，避免中文乱码。
- **标签切换用显隐而非卸载**：终端实例常驻，避免重建导致的输出错位与历史丢失。

## Windows 分发

`npm run build:win` 产出：

- `dist/win-unpacked/` —— 免安装目录版，直接运行其中的 `ssh-client.exe`（推荐）
- `dist/ssh-client-<版本>-win.zip` —— 上述目录的压缩包

**刻意不使用 NSIS 安装包与 portable 单文件版**：

- NSIS 安装包在构建时需要实际运行一次生成的 exe 来提取卸载器，受限环境下构建即失败；
- portable 版启动时要先把整个应用自解压到 `%TEMP%` 再执行，这类行为容易被安全软件拦截，
  典型的报错是 `NSIS Error: Error writing temporary file`（文件本身并未损坏）。

两者都不如目录版可靠。确实需要正式安装包时，在普通机器上把 `win.target` 换回 `nsis` 重新打包。

## 待办

- 端口转发 / 隧道管理
- 连接分组、搜索与导入导出
- SFTP 传输进度与断点续传，拖拽上传
- 使用 `MessageChannelMain` 直连终端数据流，降低高频输出下的主进程转发开销
- 打包签名：macOS 需要签名与公证，Windows 需要代码签名证书

## 环境备注

本机开发环境若设置了 `ELECTRON_RUN_AS_NODE=1`，`electron.exe` 会退化成纯 Node 运行、
无法启动图形界面，需要在该变量未设置的环境下启动应用或运行 `verify:e2e`。

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
