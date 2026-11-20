import { dialog } from 'electron'
import { randomUUID } from 'crypto'
import { basename } from 'path'
import type { FileEntry, SFTPWrapper, Stats } from 'ssh2'
import type {
  OpenSftpVO,
  SftpEntryType,
  SftpEntryVO,
  SftpTransferVO,
  SftpUploadPathsDTO
} from '@shared/types'
import { POOL_CLOSED, type ResolvedSshConfig, type SshConnectionPool } from './ssh'
import { toReadableError } from './errors'

/** 打开中的 SFTP 会话 */
interface SftpSession {
  id: string
  /** 所属底层连接，释放时按它递减引用计数 */
  connectionId: string
  sftp: SFTPWrapper
}

/**
 * 把远程目录与名称拼成 POSIX 路径。
 * 远程始终使用正斜杠，不能直接用 path.join，否则 Windows 上会拼出反斜杠。
 * @param dir 远程目录
 * @param name 目录项名称
 * @returns 拼接后的绝对路径
 */
function joinRemote(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`
}

/** 文件类型掩码 */
const S_IFMT = 0o170000
/** 目录类型位 */
const S_IFDIR = 0o040000
/** 符号链接类型位 */
const S_IFLNK = 0o120000

/**
 * 由权限位判断目录项类型。
 * readdir 返回的是纯数据 Attributes，没有 isDirectory() 之类的方法，只能按位判断。
 * @param mode 权限位
 * @returns 条目类型
 */
function entryType(mode: number): SftpEntryType {
  const type = mode & S_IFMT
  if (type === S_IFDIR) return 'directory'
  if (type === S_IFLNK) return 'symlink'
  return 'file'
}

/**
 * 执行一次带进度的文件传输。
 * ssh2 的 step 回调签名为 (已传输字节数, 本次分片字节数, 文件总大小)，其中文件总大小来自源文件的 stat，
 * 取不到时为 undefined，这里按 0 处理（渲染进程约定 total 为 0 表示大小未知）；
 * 结束时额外补一条 done 记录——空文件不会有任何 step 回调。
 * @param direction 传输方向
 * @param base 进度出参中的固定字段：会话 id 与文件名
 * @param onTransfer 进度回调，未提供时只做传输不上报
 * @param start 真正发起传输，入参为 step 回调与完成回调
 * @returns 传输完成的 Promise，失败时抛中文化错误
 */
function transferFile(
  direction: 'upload' | 'download',
  base: { sftpId: string; name: string },
  onTransfer: ((vo: SftpTransferVO) => void) | undefined,
  start: (
    step: (transferred: number, chunk: number, total?: number) => void,
    done: (err?: Error | null) => void
  ) => void
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let transferred = 0
    let total = 0
    start(
      (current, _chunk, size) => {
        transferred = current
        total = typeof size === 'number' ? size : 0
        onTransfer?.({ ...base, direction, transferred, total, done: false })
      },
      (err) => {
        if (err) {
          reject(toReadableError(err, direction === 'upload' ? '上传文件' : '下载文件'))
          return
        }
        onTransfer?.({ ...base, direction, transferred, total, done: true })
        resolve()
      }
    )
  })
}

/**
 * SFTP 会话管理器。
 * 与终端共享同一条底层 SSH 连接：打开时向连接池申请一次引用，关闭时释放，
 * 因此先关 SFTP 面板不会影响仍开着的终端标签，反之亦然。
 */
export class SftpManager {
  /** sftpId 到 SFTP 会话 */
  private sessions = new Map<string, SftpSession>()

  /**
   * @param pool 共享的连接池
   * @param onTransfer 文件传输进度回调，由 ipc 层广播给渲染进程；未提供时不上报进度
   */
  constructor(
    private readonly pool: SshConnectionPool,
    private readonly onTransfer?: (vo: SftpTransferVO) => void
  ) {
    // 底层连接断开时丢弃该连接下的全部 SFTP 会话，后续操作会得到明确的重新打开提示
    pool.on(POOL_CLOSED, (connectionId: string) => {
      for (const session of [...this.sessions.values()]) {
        if (session.connectionId === connectionId) this.sessions.delete(session.id)
      }
    })
  }

  /**
   * 取出会话，不存在时给出可读错误。
   * @param sftpId SFTP 会话 id
   * @returns SFTP 会话
   */
  private require(sftpId: string): SftpSession {
    const session = this.sessions.get(sftpId)
    if (!session) throw new Error('SFTP 会话已关闭，请重新打开')
    return session
  }

  /**
   * 打开 SFTP 会话，同配置已有底层连接时直接复用。
   * @param config 解析后的连接参数
   * @returns 会话 id、标签标题与初始目录
   */
  async open(config: ResolvedSshConfig): Promise<OpenSftpVO> {
    const client = await this.pool.acquire(config)
    let sftp: SFTPWrapper
    try {
      sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
        client.sftp((err, wrapper) => (err ? reject(err) : resolve(wrapper)))
      })
    } catch (err) {
      this.pool.release(config.connectionId)
      throw toReadableError(err, '打开 SFTP 面板')
    }

    const sftpId = randomUUID()
    this.sessions.set(sftpId, { id: sftpId, connectionId: config.connectionId, sftp })

    // 以登录用户的 home 作为面板起始目录，避免硬编码 /root 之类路径
    const home = await new Promise<string>((resolve, reject) => {
      sftp.realpath('.', (err, absolutePath) =>
        err ? reject(toReadableError(err, '定位初始目录')) : resolve(absolutePath)
      )
    })

    return { sftpId, title: config.title, home }
  }

  /**
   * 关闭 SFTP 会话并释放一次连接引用。
   * @param sftpId SFTP 会话 id
   */
  close(sftpId: string): void {
    const session = this.sessions.get(sftpId)
    if (!session) return
    this.sessions.delete(sftpId)
    try {
      session.sftp.end()
    } catch {
      // 通道可能已由远端关闭，忽略
    }
    this.pool.release(session.connectionId)
  }

  /**
   * 列出远程目录内容，目录排在文件之前并按名称排序。
   * @param sftpId SFTP 会话 id
   * @param path 远程目录绝对路径
   * @returns 目录项列表
   */
  async list(sftpId: string, path: string): Promise<SftpEntryVO[]> {
    const { sftp } = this.require(sftpId)
    const entries = await new Promise<FileEntry[]>((resolve, reject) => {
      sftp.readdir(path, (err, list) =>
        err ? reject(toReadableError(err, `读取目录 ${path}`)) : resolve(list)
      )
    })

    return (
      entries
        // 部分服务端会返回 . 与 ..，直接过滤掉，避免面板出现无法进入的条目
        .filter((entry) => entry.filename !== '.' && entry.filename !== '..')
        .map((entry) => ({
          name: entry.filename,
          path: joinRemote(path, entry.filename),
          type: entryType(entry.attrs.mode),
          size: entry.attrs.size ?? 0,
          mtime: (entry.attrs.mtime ?? 0) * 1000
        }))
        .sort((a, b) => {
          if (a.type === 'directory' && b.type !== 'directory') return -1
          if (a.type !== 'directory' && b.type === 'directory') return 1
          return a.name.localeCompare(b.name)
        })
    )
  }

  /**
   * 弹出文件选择框，把选中的本地文件上传到指定远程目录，内部复用 {@link uploadPaths}。
   * @param sftpId SFTP 会话 id
   * @param remoteDir 目标远程目录
   * @returns 上传成功的文件名列表；用户取消时为空数组
   */
  async upload(sftpId: string, remoteDir: string): Promise<string[]> {
    // 先校验会话，避免用户挑完文件才发现面板已经关闭
    this.require(sftpId)
    const picked = await dialog.showOpenDialog({
      title: '选择要上传的文件',
      properties: ['openFile', 'multiSelections']
    })
    if (picked.canceled || picked.filePaths.length === 0) return []

    return this.uploadPaths({ sftpId, remoteDir, localPaths: picked.filePaths })
  }

  /**
   * 上传指定的本地文件列表，不弹系统选择框，供面板拖拽上传使用。
   * @param dto 上传入参：会话 id、目标远程目录、本地文件绝对路径列表
   * @returns 上传成功的文件名列表
   */
  async uploadPaths(dto: SftpUploadPathsDTO): Promise<string[]> {
    const { sftp } = this.require(dto.sftpId)
    const uploaded: string[] = []
    // 逐个上传而非并发，避免多个大文件抢占同一条通道导致进度来回跳
    for (const localPath of dto.localPaths) {
      const name = basename(localPath)
      await transferFile('upload', { sftpId: dto.sftpId, name }, this.onTransfer, (step, done) =>
        sftp.fastPut(localPath, joinRemote(dto.remoteDir, name), { step }, done)
      )
      uploaded.push(name)
    }
    return uploaded
  }

  /**
   * 弹出保存框，把远程文件下载到本地。
   * @param sftpId SFTP 会话 id
   * @param remotePath 远程文件绝对路径
   * @returns 是否完成下载；用户取消时返回 false
   */
  async download(sftpId: string, remotePath: string): Promise<boolean> {
    const { sftp } = this.require(sftpId)
    const target = await dialog.showSaveDialog({
      title: '保存到',
      defaultPath: basename(remotePath)
    })
    if (target.canceled || !target.filePath) return false

    const name = basename(remotePath)
    const localPath = target.filePath
    await transferFile('download', { sftpId, name }, this.onTransfer, (step, done) =>
      sftp.fastGet(remotePath, localPath, { step }, done)
    )
    return true
  }

  /**
   * 新建远程目录。
   * @param sftpId SFTP 会话 id
   * @param path 目标目录绝对路径
   */
  async mkdir(sftpId: string, path: string): Promise<void> {
    const { sftp } = this.require(sftpId)
    await new Promise<void>((resolve, reject) => {
      sftp.mkdir(path, (err) =>
        err ? reject(toReadableError(err, `新建目录 ${path}`)) : resolve()
      )
    })
  }

  /**
   * 删除远程文件或目录。
   * 类型由服务端 stat 结果决定，避免调用方传错导致删不掉目录。
   * @param sftpId SFTP 会话 id
   * @param path 目标路径
   */
  async remove(sftpId: string, path: string): Promise<void> {
    const { sftp } = this.require(sftpId)
    const stats = await new Promise<Stats>((resolve, reject) => {
      sftp.stat(path, (err, result) =>
        err ? reject(toReadableError(err, `读取 ${path}`)) : resolve(result)
      )
    })

    if (!stats.isDirectory()) {
      await new Promise<void>((resolve, reject) => {
        sftp.unlink(path, (err) =>
          err ? reject(toReadableError(err, `删除文件 ${path}`)) : resolve()
        )
      })
      return
    }

    try {
      await new Promise<void>((resolve, reject) => {
        sftp.rmdir(path, (err) => (err ? reject(err) : resolve()))
      })
    } catch (err) {
      // SFTP 协议删除非空目录只回 FAILURE，无法区分原因，这里补一次列目录探测给出明确提示
      const rest = await new Promise<FileEntry[]>((resolve) => {
        sftp.readdir(path, (readErr, list) => resolve(readErr ? [] : list))
      })
      if (rest.some((entry) => entry.filename !== '.' && entry.filename !== '..')) {
        throw new Error(`目录非空，请先删除其中的内容：${path}`, { cause: err })
      }
      throw toReadableError(err, `删除目录 ${path}`)
    }
  }

  /**
   * 重命名或移动远程路径。
   * @param sftpId SFTP 会话 id
   * @param oldPath 原路径
   * @param newPath 新路径
   */
  async rename(sftpId: string, oldPath: string, newPath: string): Promise<void> {
    const { sftp } = this.require(sftpId)
    await new Promise<void>((resolve, reject) => {
      sftp.rename(oldPath, newPath, (err) =>
        err ? reject(toReadableError(err, `重命名 ${oldPath}`)) : resolve()
      )
    })
  }
}
