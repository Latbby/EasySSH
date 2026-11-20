import { dialog } from 'electron'
import { randomUUID } from 'crypto'
import { createReadStream, createWriteStream, existsSync, renameSync, statSync } from 'fs'
import { basename } from 'path'
import type { Writable } from 'stream'
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

/** 进度上报器，上传与下载共用同一套 VO 语义 */
interface ProgressReporter {
  /** 标记本次传输从断点续传开始，首次上报会带上 resumed */
  markResumed(): void
  /**
   * 上报一次进度。
   * @param transferred 累计已传输字节数（含断点之前已完成的部分）
   * @param total 文件总大小
   * @param done 该文件是否已传完
   */
  report(transferred: number, total: number, done: boolean): void
}

/**
 * 创建进度上报器。
 * transferred 为累计字节、total 为文件总大小、done 标记结束，与渲染进程进度条约定一致。
 * @param direction 传输方向
 * @param base 进度出参中的固定字段：会话 id 与文件名
 * @param onTransfer 进度回调，未提供时只做传输不上报
 * @returns 上报器
 */
function createReporter(
  direction: 'upload' | 'download',
  base: { sftpId: string; name: string },
  onTransfer?: (vo: SftpTransferVO) => void
): ProgressReporter {
  let resumed = false
  let reported = false
  return {
    markResumed: () => {
      resumed = true
    },
    report: (transferred, total, done) => {
      if (!onTransfer) return
      const vo: SftpTransferVO = { ...base, direction, transferred, total, done }
      // resumed 只随首次上报发出：后续每条进度都带会让渲染进程反复提示「已续传」
      if (resumed && !reported) vo.resumed = true
      reported = true
      onTransfer(vo)
    }
  }
}

/**
 * 读取远端文件大小。
 * @param sftp SFTP 通道
 * @param remotePath 远端绝对路径
 * @returns 文件字节数；文件不存在或读取失败时返回 -1
 */
function remoteFileSize(sftp: SFTPWrapper, remotePath: string): Promise<number> {
  return new Promise((resolve) => {
    sftp.stat(remotePath, (err, stats) => resolve(err ? -1 : (stats.size ?? 0)))
  })
}

/**
 * 以截断方式在远端创建空文件。
 * ssh2 的写流按 r+ 打开时要求目标已存在，所以首次上传（或断点作废重传）前先建出空文件，
 * 这样后续「按偏移写入」的语义与 fastPut 的 w 一致，不会把旧内容留在文件尾部。
 * @param sftp SFTP 通道
 * @param remotePath 远端绝对路径
 * @returns 空文件创建完成后的 Promise，失败时抛中文化错误
 */
function truncateRemote(sftp: SFTPWrapper, remotePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.open(remotePath, 'w', (err, handle) => {
      if (err) {
        reject(toReadableError(err, `创建 ${remotePath}`))
        return
      }
      // 句柄必须显式关闭，否则远端会一直挂着一个打开的文件
      sftp.close(handle, (closeErr) =>
        closeErr ? reject(toReadableError(closeErr, `创建 ${remotePath}`)) : resolve()
      )
    })
  })
}

/**
 * 写入一块数据并等待写入确认。
 * 回调在 ssh2 收到服务端 WRITE 应答（本地流则是落盘）之后触发，
 * 因此按它累计出来的进度与断点都是真实的已写入字节。
 * @param writer 目标写流
 * @param chunk 数据块
 * @returns 写入确认后完成的 Promise
 */
function writeChunk(writer: Writable, chunk: Buffer): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    writer.write(chunk, (err?: Error | null) => (err ? reject(err) : resolve()))
  })
}

/**
 * 收尾写流：结束写入并等待句柄关闭。
 * 本地文件流必须等到 close 才能改名（Windows 上打开着的文件无法改名），ssh2 写流同样在句柄关闭后触发 close；
 * 出错时以 Promise 拒绝的方式抛出，避免流上的 error 事件变成未捕获异常。
 * @param writer 目标写流
 * @returns 写流关闭后完成的 Promise
 */
function closeWriter(writer: Writable): Promise<void> {
  // 已销毁的流不会再触发 close（ssh2 在出错时也不发），避免等一个永远不来的事件
  if (writer.destroyed) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (err?: Error | null): void => {
      if (settled) return
      settled = true
      writer.removeListener('error', onError)
      writer.removeListener('close', onClose)
      if (err) reject(err)
      else resolve()
    }
    const onError = (err: Error): void => finish(err)
    const onClose = (): void => finish()
    writer.once('error', onError)
    writer.once('close', onClose)
    writer.end()
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
   * 上传断点记录，key 为「会话 id|远端路径」，value 为该文件已确认写入远端的字节数。
   * 只存在内存里：进程活着就能对中断的文件续传，重启后从头传，符合面板的会话语义。
   */
  private uploadOffsets = new Map<string, number>()

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
    // 会话关闭后断点记录不再有意义，一并清掉，避免长期运行攒下无用条目
    for (const key of [...this.uploadOffsets.keys()]) {
      if (key.startsWith(`${sftpId}|`)) this.uploadOffsets.delete(key)
    }
    try {
      session.sftp.end()
    } catch {
      // 通道可能已由远端关闭，忽略
    }
    this.pool.release(session.connectionId)
  }

  /**
   * 取出会话的 SFTP 通道，供主进程其它功能（如远程编辑）复用同一条 SFTP 会话。
   * @param sftpId SFTP 会话 id
   * @returns SFTP 通道
   */
  requireWrapper(sftpId: string): SFTPWrapper {
    return this.require(sftpId).sftp
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
    const session = this.require(dto.sftpId)
    const uploaded: string[] = []
    // 逐个上传而非并发，避免多个大文件抢占同一条通道导致进度来回跳
    for (const localPath of dto.localPaths) {
      const name = basename(localPath)
      await this.putFile(session, joinRemote(dto.remoteDir, name), localPath, name)
      uploaded.push(name)
    }
    return uploaded
  }

  /**
   * 上传单个本地文件，同一会话内对中断过的目标文件断点续传。
   * 远端按 r+ 打开并从上次已确认写入的偏移继续写，本地文件流也从同一偏移开始读，
   * 所以进度里的 transferred 是真实的累计字节，中断重试不会把已传部分再传一遍。
   * @param session 目标 SFTP 会话
   * @param remotePath 远端绝对路径
   * @param localPath 本地文件绝对路径
   * @param name 文件名，仅用于进度提示
   */
  private async putFile(
    session: SftpSession,
    remotePath: string,
    localPath: string,
    name: string
  ): Promise<void> {
    const { sftp } = session
    const total = statSync(localPath).size
    const key = `${session.id}|${remotePath}`
    const record = this.uploadOffsets.get(key) ?? 0
    let offset = Math.min(record, total)
    // 远端可能在两次上传之间被改动过（同名文件被替换等），长度对不上时按原偏移续写会写坏文件，改为重传
    if (offset > 0 && (await remoteFileSize(sftp, remotePath)) !== offset) offset = 0
    // r+ 要求目标已存在，首次上传（或断点作废）时先建出空文件
    if (offset === 0) await truncateRemote(sftp, remotePath)

    const reporter = createReporter('upload', { sftpId: session.id, name }, this.onTransfer)
    if (offset > 0) reporter.markResumed()

    const reader = createReadStream(localPath, { start: offset })
    const writer = sftp.createWriteStream(remotePath, { flags: 'r+', start: offset })
    let written = offset
    // 流上的错误必须有人接：ssh2 打开远端文件失败时会直接 emit error，无人监听会变成未捕获异常
    let failure: Error | null = null
    writer.on('error', (err: Error) => {
      failure = err
    })
    try {
      for await (const chunk of reader) {
        if (failure) throw failure
        await writeChunk(writer, chunk as Buffer)
        written += (chunk as Buffer).length
        // 每写成功一块就刷新断点，连接或进程中断后能从最近一次成功写入处接着传
        this.uploadOffsets.set(key, written)
        reporter.report(written, total, false)
      }
      if (failure) throw failure
      await closeWriter(writer)
    } catch (err) {
      reader.destroy()
      writer.destroy()
      throw toReadableError(err, '上传文件')
    }
    // 传完才清掉断点记录：下次上传同一目标重新从头开始
    this.uploadOffsets.delete(key)
    reporter.report(total, total, true)
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
    // 先写到 <目标>.part：中断时保留半成品，正式文件要么不存在、要么是完整的，不会被半个文件覆盖
    const partPath = `${localPath}.part`
    const total = await remoteFileSize(sftp, remotePath)
    if (total < 0) throw new Error(`远程文件不存在或无法读取：${remotePath}`)

    // 只有 .part 比远端小才值得续传；不小于时说明上次已下完或内容是脏的，直接重下
    let offset = 0
    if (existsSync(partPath)) {
      const done = statSync(partPath).size
      if (done > 0 && done < total) offset = done
    }

    const reporter = createReporter('download', { sftpId, name }, this.onTransfer)
    if (offset > 0) reporter.markResumed()
    try {
      await this.getFile(sftp, remotePath, partPath, offset, total, reporter)
      // 传完才改名成正式文件，任何中断都只留下 .part
      renameSync(partPath, localPath)
    } catch (err) {
      throw toReadableError(err, '下载文件')
    }
    reporter.report(total, total, true)
    return true
  }

  /**
   * 从远端读取剩余内容并写入本地文件。
   * @param sftp SFTP 通道
   * @param remotePath 远端绝对路径
   * @param localPath 本地目标路径（下载断点文件）
   * @param offset 续传起点，即本地已下载的字节数
   * @param total 远端文件总大小
   * @param reporter 进度上报器
   */
  private async getFile(
    sftp: SFTPWrapper,
    remotePath: string,
    localPath: string,
    offset: number,
    total: number,
    reporter: ProgressReporter
  ): Promise<void> {
    const reader = sftp.createReadStream(remotePath, { start: offset })
    // 续传时追加写入，否则新建（w 会先清掉上次残留的内容）
    const writer = createWriteStream(localPath, { flags: offset > 0 ? 'a' : 'w' })
    let written = offset
    let failure: Error | null = null
    reader.on('error', (err: Error) => {
      failure = err
    })
    writer.on('error', (err: Error) => {
      failure = err
    })
    try {
      for await (const chunk of reader) {
        if (failure) throw failure
        await writeChunk(writer, chunk as Buffer)
        written += (chunk as Buffer).length
        reporter.report(written, total, false)
      }
      if (failure) throw failure
      await closeWriter(writer)
    } catch (err) {
      reader.destroy()
      writer.destroy()
      throw err
    }
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
