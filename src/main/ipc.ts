import { BrowserWindow, dialog, ipcMain } from 'electron'
import { readFileSync } from 'fs'
import {
  IPC,
  type ConnectionVO,
  type OpenTerminalDTO,
  type OpenTerminalVO,
  type SaveConnectionDTO
} from '@shared/types'
import {
  getConnection,
  isSecureStorageAvailable,
  listConnections,
  removeConnection,
  resolveCredential,
  saveConnection
} from './store'
import { SshSessionManager, type ResolvedSshConfig } from './ssh'

/**
 * 向所有渲染窗口广播事件，目前是单窗口，多窗口时天然可用。
 * @param channel IPC 通道名
 * @param args 事件参数
 */
function broadcast(channel: string, ...args: unknown[]): void {
  BrowserWindow.getAllWindows().forEach((win) => win.webContents.send(channel, ...args))
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
 * 把打开终端入参解析为 SSH 配置，凭据在主进程内解密后使用，不回流到渲染进程。
 * @param dto 打开终端入参，支持已保存连接或一次性临时连接
 * @returns 解析后的连接参数
 */
function resolveConfig(dto: OpenTerminalDTO): ResolvedSshConfig {
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
 * @returns SSH 会话管理器实例，供应用退出时统一释放连接
 */
export function registerIpcHandlers(): SshSessionManager {
  const manager = new SshSessionManager(
    (sessionId, data) => broadcast(IPC.termData, sessionId, data),
    (sessionId, reason) => broadcast(IPC.termExit, sessionId, reason)
  )

  ipcMain.handle(IPC.connList, (): ConnectionVO[] => listConnections())
  ipcMain.handle(IPC.connSave, (_event, dto: SaveConnectionDTO): ConnectionVO =>
    saveConnection(dto)
  )
  ipcMain.handle(IPC.connRemove, (_event, id: string): void => removeConnection(id))
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

  ipcMain.handle(IPC.termOpen, (_event, dto: OpenTerminalDTO): Promise<OpenTerminalVO> =>
    manager.open(resolveConfig(dto), dto.cols, dto.rows)
  )
  ipcMain.on(IPC.termWrite, (_event, sessionId: string, data: string) =>
    manager.write(sessionId, data)
  )
  ipcMain.on(IPC.termResize, (_event, sessionId: string, cols: number, rows: number) =>
    manager.resize(sessionId, cols, rows)
  )
  ipcMain.on(IPC.termClose, (_event, sessionId: string) => manager.close(sessionId, '会话已关闭'))

  return manager
}
