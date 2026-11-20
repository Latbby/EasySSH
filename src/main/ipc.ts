import { BrowserWindow, clipboard, dialog, ipcMain } from 'electron'
import { readFileSync } from 'fs'
import { userInfo } from 'os'
import {
  IPC,
  type AssignGroupDTO,
  type ConnectionVO,
  type ExportResultVO,
  type ForwardRuleDTO,
  type ForwardRuleVO,
  type ImportResultVO,
  type OpenSftpDTO,
  type OpenSftpVO,
  type OpenTerminalDTO,
  type OpenTerminalVO,
  type SaveConnectionDTO,
  type SessionSnapshotVO,
  type SftpEntryVO,
  type SftpTransferVO,
  type SftpUploadPathsDTO,
  type EditSessionVO
} from '@shared/types'
import {
  assignGroup,
  getConnection,
  isSecureStorageAvailable,
  listConnections,
  removeConnection,
  resolveCredential,
  saveConnection
} from './store'
import {
  SshConnectionPool,
  SshSessionManager,
  trustPendingHostKey,
  type ResolvedSshConfig
} from './ssh'
import { SftpManager } from './sftp'
import { exportConnectionsToFile, importConnectionsFromFile } from './config-io'
import { editRemoteFile, closeEditSessions } from './edit'
import { ForwardManager } from './forward'
import { clearSession, loadSession, saveSession } from './session'

/** 打开终端或 SFTP 的公共入参：已保存连接与临时连接二选一 */
type OpenTargetDTO = Pick<OpenTerminalDTO, 'connectionId' | 'inline'>

/** IPC 注册结果，应用退出时用来释放连接 */
export interface IpcHandle {
  /** 关闭全部底层 SSH 连接 */
  dispose(): void
}

/**
 * 向所有渲染窗口广播事件，目前是单窗口，多窗口时天然可用。
 * @param channel IPC 通道名
 * @param args 事件参数
 */
function broadcast(channel: string, ...args: unknown[]): void {
  BrowserWindow.getAllWindows().forEach((win) => win.webContents.send(channel, ...args))
}

/**
 * 终端输出的发送方式说明。
 *
 * README 待办里「用 MessageChannelMain 直连终端数据流」已实测评估过（见 scripts/verify-report.md
 * 的性能章节）：本机 20MB 连续输出下，端口路径与 IPC 路径的端到端耗时差异被噪声淹没，
 * 真正耗时在 ssh2 自身的加解密与包处理（45~70MB/s），而 ssh.ts 的 setImmediate 批量合并
 * 已经把 20MB 压成 35~45 条消息，IPC 序列化不再是瓶颈；合成压力测试里端口路径在 512KB/64KB
 * 分片下反而慢约 20%。因此这里保留批量合并后的普通 IPC 通道，不再引入 MessagePort 分支。
 */

/**
 * 取当前用于弹系统对话框的窗口。
 * @returns 优先返回聚焦窗口，没有时返回第一个窗口
 */
function dialogWindow(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
}

/**
 * 读取私钥文件内容。
 * @param path 私钥文件路径，为空时返回 undefined
 * @returns 私钥内容缓冲区
 * @throws 文件不可读时抛出可读错误，交由渲染进程提示用户
 */
function readPrivateKey(path?: string): Buffer | undefined {
  if (!path) return undefined
  try {
    return readFileSync(path)
  } catch {
    throw new Error(`无法读取私钥文件：${path}`)
  }
}

/**
 * 把打开通道的入参解析为 SSH 配置，凭据在主进程内解密后使用，不回流到渲染进程。
 * @param dto 打开入参，支持已保存连接或一次性临时连接
 * @returns 解析后的连接参数
 */
function resolveConfig(dto: OpenTargetDTO): ResolvedSshConfig {
  if (dto.connectionId) {
    const vo = getConnection(dto.connectionId)
    if (!vo) throw new Error('连接配置不存在，可能已被删除')
    const credential = resolveCredential(vo.id)
    return {
      connectionId: vo.id,
      title: vo.name || `${vo.username}@${vo.host}`,
      host: vo.host,
      port: vo.port,
      username: vo.username,
      password: credential.password,
      passphrase: credential.passphrase,
      privateKey: readPrivateKey(credential.privateKeyPath)
    }
  }

  const inline = dto.inline
  if (!inline) throw new Error('缺少连接信息')
  return {
    // 临时连接没有 id，用连接要素拼出复用键，指向同一目标时仍可共享底层连接
    connectionId: `inline:${inline.username}@${inline.host}:${inline.port}`,
    title: inline.name || `${inline.username}@${inline.host}`,
    host: inline.host,
    port: inline.port,
    username: inline.username,
    password: inline.password,
    passphrase: inline.passphrase,
    privateKey: readPrivateKey(inline.privateKeyPath)
  }
}

/**
 * 注册全部 IPC 处理器。
 * @returns 句柄，应用退出时调用其 dispose 释放连接
 */
export function registerIpcHandlers(): IpcHandle {
  // 终端与 SFTP 共用同一个连接池，因此同一目标的文件传输不会额外握手
  const pool = new SshConnectionPool()
  const terminal = new SshSessionManager(
    pool,
    (sessionId, data) => broadcast(IPC.termData, sessionId, data),
    (sessionId, reason) => broadcast(IPC.termExit, sessionId, reason)
  )
  // 上传与下载的进度经 IPC.sftpTransfer 广播，渲染进程据此画进度条
  const sftp = new SftpManager(pool, (vo: SftpTransferVO) => broadcast(IPC.sftpTransfer, vo))
  // 端口转发复用同一个连接池，规则状态变化实时广播给面板
  const forward = new ForwardManager(pool, (vo: ForwardRuleVO) => broadcast(IPC.forwardEvent, vo))

  ipcMain.handle(IPC.connList, (): ConnectionVO[] => listConnections())
  ipcMain.handle(IPC.connSave, (_event, dto: SaveConnectionDTO): ConnectionVO =>
    saveConnection(dto)
  )
  ipcMain.handle(IPC.connRemove, (_event, id: string): void => removeConnection(id))
  ipcMain.handle(IPC.connAssignGroup, (_event, dto: AssignGroupDTO): ConnectionVO[] =>
    assignGroup(dto.ids, dto.group)
  )
  ipcMain.handle(IPC.connImport, async (): Promise<ImportResultVO | null> => {
    const win = dialogWindow()
    return win ? importConnectionsFromFile(win) : null
  })
  ipcMain.handle(IPC.connExport, async (): Promise<ExportResultVO | null> => {
    const win = dialogWindow()
    return win ? exportConnectionsToFile(win) : null
  })
  ipcMain.handle(IPC.secureAvailable, (): boolean => isSecureStorageAvailable())

  ipcMain.handle(IPC.pickPrivateKey, async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      title: '选择私钥文件',
      properties: ['openFile'],
      filters: [
        { name: '私钥文件', extensions: ['pem', 'key', 'ppk', 'rsa', 'ed25519'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle(IPC.clipboardRead, (): string => clipboard.readText())
  ipcMain.handle(IPC.clipboardWrite, (_event, text: string): void => clipboard.writeText(text))
  // 快速连接需要默认用户名，取当前系统登录用户
  ipcMain.handle(IPC.defaultUsername, (): string => userInfo().username)
  // 用户在主机密钥变更弹窗里确认后，把新指纹写入 known_hosts
  ipcMain.handle(IPC.trustHostKey, (_event, host: string, port: number): void =>
    trustPendingHostKey(host, port)
  )

  ipcMain.handle(IPC.termOpen, (_event, dto: OpenTerminalDTO): Promise<OpenTerminalVO> =>
    terminal.open(resolveConfig(dto), dto.cols, dto.rows)
  )
  ipcMain.on(IPC.termWrite, (_event, sessionId: string, data: string) =>
    terminal.write(sessionId, data)
  )
  ipcMain.on(IPC.termResize, (_event, sessionId: string, cols: number, rows: number) =>
    terminal.resize(sessionId, cols, rows)
  )
  ipcMain.on(IPC.termClose, (_event, sessionId: string) => terminal.close(sessionId, '会话已关闭'))

  ipcMain.handle(IPC.sftpOpen, (_event, dto: OpenSftpDTO): Promise<OpenSftpVO> =>
    sftp.open(resolveConfig(dto))
  )
  ipcMain.handle(IPC.sftpList, (_event, sftpId: string, path: string): Promise<SftpEntryVO[]> =>
    sftp.list(sftpId, path)
  )
  ipcMain.handle(IPC.sftpUpload, (_event, sftpId: string, remoteDir: string): Promise<string[]> =>
    sftp.upload(sftpId, remoteDir)
  )
  ipcMain.handle(IPC.sftpUploadPaths, (_event, dto: SftpUploadPathsDTO): Promise<string[]> =>
    sftp.uploadPaths(dto)
  )
  ipcMain.handle(IPC.sftpDownload, (_event, sftpId: string, remotePath: string): Promise<boolean> =>
    sftp.download(sftpId, remotePath)
  )
  ipcMain.handle(IPC.sftpMkdir, (_event, sftpId: string, path: string): Promise<void> =>
    sftp.mkdir(sftpId, path)
  )
  ipcMain.handle(IPC.sftpRemove, (_event, sftpId: string, path: string): Promise<void> =>
    sftp.remove(sftpId, path)
  )
  ipcMain.handle(
    IPC.sftpRename,
    (_event, sftpId: string, oldPath: string, newPath: string): Promise<void> =>
      sftp.rename(sftpId, oldPath, newPath)
  )
  ipcMain.on(IPC.sftpClose, (_event, sftpId: string) => {
    // 先停掉该会话的远程编辑监听，避免面板关闭后本地保存还在失效通道上回传
    closeEditSessions(sftpId)
    sftp.close(sftpId)
  })
  // 远程编辑复用面板已打开的 SFTP 会话，下载到临时目录后用系统程序打开，保存后自动回传
  ipcMain.handle(
    IPC.sftpEdit,
    (_event, sftpId: string, remotePath: string): Promise<EditSessionVO> =>
      editRemoteFile(sftp.requireWrapper(sftpId), sftpId, remotePath, (vo) =>
        broadcast(IPC.sftpEditEvent, vo)
      )
  )

  ipcMain.handle(IPC.forwardList, (): ForwardRuleVO[] => forward.list())
  ipcMain.handle(IPC.forwardStart, (_event, dto: ForwardRuleDTO): Promise<ForwardRuleVO> =>
    forward.start(dto, resolveConfig(dto))
  )
  ipcMain.handle(IPC.forwardStop, (_event, id: string): Promise<void> => forward.stop(id))
  ipcMain.handle(IPC.forwardRemove, (_event, id: string): Promise<void> => forward.remove(id))

  ipcMain.handle(IPC.sessionSave, (_event, snapshot: SessionSnapshotVO): void =>
    saveSession(snapshot)
  )
  ipcMain.handle(IPC.sessionLoad, (): SessionSnapshotVO | null => loadSession())
  ipcMain.handle(IPC.sessionClear, (): void => clearSession())

  return {
    dispose: () => {
      forward.dispose()
      pool.dispose()
    }
  }
}
