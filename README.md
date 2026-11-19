# SSH 客户端

一个可保存连接的跨平台 SSH 客户端，基于 Electron + TypeScript 构建。

## 技术栈

| 层 | 选型 | 说明 |
| --- | --- | --- |
| 壳 | Electron 44 | 三平台共用一套代码 |
| 构建 | electron-vite 6 | 主进程 / preload / 渲染进程统一构建与热更新 |
| 终端 | @xterm/xterm | 终端渲染、尺寸自适应、链接识别 |
| SSH | ssh2 | 纯 JS 实现，支持 shell 与后续的 SFTP |
| UI | React 19 | 连接列表、多标签终端 |
| 存储 | JSON + Electron safeStorage | 配置原子写盘，凭据加密存储 |

## 目录结构

```
src/
├─ shared/types.ts        主进程与渲染进程共享的 DTO / VO / IPC 通道常量
├─ main/
│  ├─ index.ts            应用入口，创建窗口与注册 IPC
│  ├─ ipc.ts              IPC 处理器，把入参解析为可用的连接配置
│  ├─ ssh.ts              SSH 会话管理器：连接复用、终端会话、主机指纹校验
│  └─ store.ts            连接配置持久化与凭据加解密
├─ preload/index.ts       经 contextBridge 暴露的业务 API
└─ renderer/src/
   ├─ App.tsx             根组件，编排连接列表、终端标签与表单
   ├─ types.ts            终端标签类型
   └─ components/         连接列表、连接表单、终端标签页、终端视图
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
npm run verify:e2e    # 端到端：真实 Electron + IPC + safeStorage + 真实 SSH 会话
```

`verify:ssh` 与 `verify:store` 不启动 Electron，可在任意环境运行。
`verify:e2e` 需要能启动 Electron 图形进程的桌面会话。

## 已实现

- 连接配置的新增、编辑、删除与持久化
- 密码与私钥口令经 Electron safeStorage 加密，明文不落盘，列表出参不回流凭据
- 同一连接的多个终端标签复用一条 SSH 连接，减少握手与 `MaxSessions` 压力
- 多标签终端，后台标签持续接收输出，切换不丢回滚缓冲
- 终端尺寸自动同步远端 PTY，全屏程序不错行
- 主机公钥采用 TOFU 校验，指纹变化时拒绝连接
- 会话断开后标签可一键重连
- 配置文件的原子写与损坏降级

## 架构要点

- **凭据不出主进程**：渲染进程只拿到 `ConnectionVO`，密码与私钥内容始终在主进程内解密使用。
- **IPC 按 sessionId 路由**：所有终端操作都带会话 id，高频读写使用 `send` 而非 `invoke`。
- **终端输出传原始字节**：主进程不把 Buffer 转成字符串，交给 xterm 的 UTF-8 解码器处理跨数据包的
  多字节字符，避免中文乱码。
- **标签切换用显隐而非卸载**：终端实例常驻，避免重建导致的输出错位与历史丢失。

## 待办

- SFTP 面板（复用同一 SSH 连接的文件传输）
- 端口转发 / 隧道管理
- 连接分组、搜索与导入导出
- 使用 `MessageChannelMain` 直连终端数据流，降低高频输出下的主进程转发开销
- 打包签名：macOS 需要签名与公证，Windows 需要代码签名证书

## 环境备注

本机开发环境若设置了 `ELECTRON_RUN_AS_NODE=1`，`electron.exe` 会退化成纯 Node 运行、
无法启动图形界面，需要在该变量未设置的环境下启动应用或运行 `verify:e2e`。
