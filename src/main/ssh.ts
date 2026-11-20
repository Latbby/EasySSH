import { app } from 'electron'
import { Client, type ClientChannel } from 'ssh2'
import { EventEmitter } from 'events'
import { createHash, randomUUID } from 'crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { OpenTerminalVO } from '@shared/types'
import { encodeHostKeyChanged, type HostKeyChangeVO } from '@shared/errors'
import { toReadableError } from './errors'

/** 解析完成的 SSH 连接参数，认证凭据已在主进程内解密 */
export interface ResolvedSshConfig {
  /** 底层连接复用键，同键的多个终端标签与 SFTP 会话共享一条 SSH 连接 */
  connectionId: string
  /** 标签展示名 */
  title: string
  host: string
  port: number
  username: string
  password?: string
  privateKey?: Buffer
  passphrase?: string
}

/** 复用中的底层 SSH 连接 */
interface PooledConnection {
  client: Client
  /** 引用计数：每个 shell 或 sftp 通道打开时加一，全部释放后关闭连接 */
  refs: number
}

/** 一个终端标签对应的会话 */
interface Session {
  id: string
  connectionId: string
  stream: ClientChannel
}

/** 连接池的底层连接断开事件名，终端与 SFTP 各自监听并回收自己的通道 */
export const POOL_CLOSED = 'closed'

/** 已知主机指纹表，key 为 host:port，全部连接共用一份 */
let knownHosts: Record<string, string> | null = null

/**
 * 待用户确认的主机密钥变更，key 为 host:port。
 * 指纹变化时本次握手仍然拒绝，由渲染进程弹框让用户核对，确认后再由 {@link trustPendingHostKey} 落盘。
 */
const pendingHostKeys = new Map<string, HostKeyChangeVO>()

/** 已知主机指纹表文件路径 */
function knownHostsFile(): string {
  return join(app.getPath('userData'), 'known_hosts.json')
}

/**
 * 读取已知主机指纹表，进程内缓存。
 * 文件损坏时先改名为 .bak 保留现场再重建空表：若静默按空表处理，下次连接会直接重新 TOFU，
 * 主机身份校验会无声失效，用户与日志都看不到任何痕迹。
 * @returns host:port 到 SHA256 指纹的映射
 */
function loadKnownHosts(): Record<string, string> {
  if (knownHosts) return knownHosts
  const file = knownHostsFile()
  let table: Record<string, string> = {}
  if (existsSync(file)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('known_hosts 内容不是对象')
      }
      table = parsed as Record<string, string>
    } catch {
      // 解析失败说明记录表已损坏：备份现场后重建空表，并留下日志，避免主机身份校验无声失效
      try {
        renameSync(file, `${file}.bak`)
        console.warn(
          `[ssh-client] known_hosts 无法解析，已备份为 ${file}.bak 并重建空表，本次连接将重新记录主机指纹`
        )
      } catch {
        console.warn(
          `[ssh-client] known_hosts 无法解析且备份失败（${file}），本次连接将重新记录主机指纹`
        )
      }
    }
  }
  knownHosts = table
  return table
}

/** 持久化已知主机指纹表，同样使用临时文件加改名保证原子性 */
function saveKnownHosts(): void {
  const file = knownHostsFile()
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(knownHosts ?? {}, null, 2), 'utf8')
  renameSync(tmp, file)
}

/**
 * 校验服务端主机公钥，采用 TOFU 策略：首次连接记录指纹并信任，指纹变化即拒绝。
 * 这一步用来防中间人攻击，缺少它等于放弃主机身份校验。
 * @param host 目标主机
 * @param port 目标端口
 * @param key 服务端主机公钥
 * @returns 是否允许建立连接
 */
function verifyHostKey(host: string, port: number, key: Buffer): boolean {
  const target = `${host}:${port}`
  const fingerprint = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
  const table = loadKnownHosts()
  const known = table[target]
  if (!known) {
    // 首次连接采用 TOFU 策略：记录指纹并直接信任，不额外增加首次确认弹窗
    table[target] = fingerprint
    saveKnownHosts()
    return true
  }
  if (known === fingerprint) {
    // 指纹一致，清掉可能残留的待确认记录
    pendingHostKeys.delete(target)
    return true
  }
  // 指纹变化：记入待确认表并拒绝本次握手，既不静默信任新密钥，也不把用户堵死在无法恢复的错误上
  pendingHostKeys.set(target, { host, port, oldFingerprint: known, newFingerprint: fingerprint })
  return false
}

/**
 * 用户核对后信任待确认的主机新指纹，写入 known_hosts 并原子落盘。
 * 没有待确认记录时不做任何事，重复调用是安全的。
 * @param host 目标主机
 * @param port 目标端口
 */
export function trustPendingHostKey(host: string, port: number): void {
  const target = `${host}:${port}`
  const pending = pendingHostKeys.get(target)
  if (!pending) return
  const table = loadKnownHosts()
  table[target] = pending.newFingerprint
  saveKnownHosts()
  // 落盘成功后才清除待确认记录，避免写盘失败时用户重连又被拒绝
  pendingHostKeys.delete(target)
}

/**
 * 判断一次握手失败是否确实来自主机密钥校验。
 * ssh2 在 hostVerifier 返回 false 时抛出 'Host denied (verification failed)' 且 level 为 'handshake'，
 * 这里同时看 level 与关键字：只有两者相符才认定为密钥变更，
 * 否则 ECONNREFUSED、网络不可达等无关失败会被误报成「疑似中间人攻击」。
 * @param err 握手阶段抛出的错误
 * @returns 是否为主机密钥校验失败
 */
function isHostKeyRejected(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const level = (err as { level?: string }).level
  if (!/host denied|verification failed|host key/i.test(err.message)) return false
  // 少数版本可能不带 level，只要信息明确指向主机密钥即可认定
  return level === undefined || level === 'handshake'
}

/**
 * SSH 连接池。
 * 负责建立与复用底层连接、维护引用计数、校验主机指纹。
 * 连接异常断开时通过 {@link POOL_CLOSED} 事件通知各使用者回收自己的通道，
 * 这样终端会话与 SFTP 会话可以各自独立管理，却共享同一条 TCP 连接。
 */
export class SshConnectionPool extends EventEmitter {
  /** connectionId 到复用中的底层连接 */
  private pool = new Map<string, PooledConnection>()

  /**
   * 获取可用的底层连接，已存在则复用并递增引用计数。
   * @param config 解析后的连接参数
   * @returns 已就绪的 ssh2 客户端
   */
  async acquire(config: ResolvedSshConfig): Promise<Client> {
    const existing = this.pool.get(config.connectionId)
    if (existing) {
      existing.refs += 1
      return existing.client
    }

    const client = new Client()
    await new Promise<void>((resolve, reject) => {
      client.once('ready', resolve)
      client.once('error', (err) => {
        // 握手阶段失败必须显式释放，否则会留下半开连接
        try {
          client.end()
        } catch {
          // 尚未建立连接时 end 可能抛错，忽略即可
        }
        // 只有确实因主机密钥校验失败时才抛编码错误，避免服务端下线等失败被误报成密钥变更
        const pending = pendingHostKeys.get(`${config.host}:${config.port}`)
        reject(
          pending && isHostKeyRejected(err)
            ? new Error(encodeHostKeyChanged(pending))
            : toReadableError(err, `连接 ${config.host}:${config.port}`)
        )
      })
      client.connect({
        host: config.host,
        port: config.port,
        username: config.username,
        password: config.password,
        privateKey: config.privateKey,
        passphrase: config.passphrase,
        // 握手超时，避免网络不通时一直转圈
        readyTimeout: 20000,
        // 心跳保活，防止空闲连接被中间设备切断
        keepaliveInterval: 15000,
        hostVerifier: (key: Buffer) => verifyHostKey(config.host, config.port, key)
      })
    })

    const pooled: PooledConnection = { client, refs: 1 }
    this.pool.set(config.connectionId, pooled)

    // 建连后仍需持续监听：连接异常断开时要通知所有使用者回收通道
    client.on('error', () => undefined)
    client.on('close', () => {
      this.pool.delete(config.connectionId)
      this.emit(POOL_CLOSED, config.connectionId)
    })

    return client
  }

  /**
   * 释放一次引用计数，归零时关闭底层连接。
   * @param connectionId 底层连接复用键
   */
  release(connectionId: string): void {
    const pooled = this.pool.get(connectionId)
    if (!pooled) return
    pooled.refs -= 1
    if (pooled.refs > 0) return
    this.pool.delete(connectionId)
    pooled.client.end()
  }

  /** 应用退出前关闭全部连接 */
  dispose(): void {
    this.pool.forEach((pooled) => pooled.client.end())
    this.pool.clear()
  }
}

/**
 * 终端会话管理器。
 * 只负责 shell 通道的生命周期，底层连接由连接池统一持有。
 */
export class SshSessionManager {
  /** sessionId 到终端会话 */
  private sessions = new Map<string, Session>()

  /** 待冲刷的远端输出，key 为会话 id，value 为已到达但尚未合并上报的分片 */
  private pendingOutput = new Map<string, Buffer[]>()

  /** 批量冲刷任务，同一事件循环内只安排一次 */
  private flushTask: ReturnType<typeof setImmediate> | null = null

  /**
   * @param pool 共享的连接池
   * @param onData 远端输出回调，data 为原始字节，交由渲染进程的 xterm 完成 UTF-8 解码
   * @param onExit 会话结束回调，reason 为结束原因
   */
  constructor(
    private readonly pool: SshConnectionPool,
    private readonly onData: (sessionId: string, data: Uint8Array) => void,
    private readonly onExit: (sessionId: string, reason: string) => void
  ) {
    // 底层连接断开时，回收该连接下的全部终端会话
    pool.on(POOL_CLOSED, (connectionId: string) => {
      const affected = [...this.sessions.values()].filter(
        (item) => item.connectionId === connectionId
      )
      affected.forEach((item) => this.close(item.id, '连接已断开'))
    })
  }

  /**
   * 打开一个终端标签，同配置已有连接时直接复用，避免重复握手。
   * @param config 解析后的连接参数
   * @param cols 终端列数
   * @param rows 终端行数
   * @returns 会话 id 与标签标题
   */
  async open(config: ResolvedSshConfig, cols: number, rows: number): Promise<OpenTerminalVO> {
    const client = await this.pool.acquire(config)
    const sessionId = randomUUID()
    let stream: ClientChannel
    try {
      stream = await new Promise<ClientChannel>((resolve, reject) => {
        client.shell({ term: 'xterm-256color', cols, rows }, (err, channel) =>
          err ? reject(err) : resolve(channel)
        )
      })
    } catch (err) {
      // 开 shell 失败要把引用计数还回去，否则底层连接永远不会释放
      this.pool.release(config.connectionId)
      throw toReadableError(err, '打开终端')
    }

    this.sessions.set(sessionId, { id: sessionId, connectionId: config.connectionId, stream })
    // 原始字节先按到达顺序暂存，由 setImmediate 批量合并后上报，跨数据包的多字节字符仍交给 xterm 解码
    stream.on('data', (chunk: Buffer) => this.queueOutput(sessionId, chunk))
    stream.stderr.on('data', (chunk: Buffer) => this.queueOutput(sessionId, chunk))
    stream.on('close', () => this.close(sessionId, '会话已关闭'))

    return { sessionId, title: config.title }
  }

  /**
   * 暂存一个输出分片，并为整个事件循环安排一次冲刷。
   * 高吞吐输出（如 cat 大文件）下 ssh2 会拆出大量小分片，逐个走 IPC 既慢又容易拖住渲染进程。
   * @param sessionId 会话 id
   * @param chunk 远端输出的原始字节
   */
  private queueOutput(sessionId: string, chunk: Buffer): void {
    const chunks = this.pendingOutput.get(sessionId)
    if (chunks) chunks.push(chunk)
    else this.pendingOutput.set(sessionId, [chunk])
    // setImmediate 在本轮 I/O 回调全部执行完之后触发，能攒下同一批到达的全部分片
    if (!this.flushTask) this.flushTask = setImmediate(() => this.flushOutput())
  }

  /** 冲刷全部会话的待发送输出，按到达顺序合并后各上报一次 */
  private flushOutput(): void {
    this.flushTask = null
    // 先整体取出再回调：回调期间新到达的数据会进入下一轮批量，既不丢数据也不会乱序
    const batches = [...this.pendingOutput]
    this.pendingOutput.clear()
    for (const [sessionId, chunks] of batches) this.emitOutput(sessionId, chunks)
  }

  /**
   * 立即冲刷指定会话的待发送输出，用于关闭会话前补齐最后一段数据。
   * @param sessionId 会话 id
   */
  private flushSession(sessionId: string): void {
    const chunks = this.pendingOutput.get(sessionId)
    if (!chunks) return
    this.pendingOutput.delete(sessionId)
    this.emitOutput(sessionId, chunks)
  }

  /**
   * 合并分片并交给 onData 上报。
   * @param sessionId 会话 id
   * @param chunks 已按到达顺序排列的输出分片
   */
  private emitOutput(sessionId: string, chunks: Buffer[]): void {
    const merged = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks)
    this.onData(sessionId, new Uint8Array(merged))
  }

  /**
   * 关闭指定终端会话。
   * 重复调用是安全的：会话已移除时直接返回，避免远端关闭事件与主动关闭互相递归。
   * @param sessionId 会话 id
   * @param reason 关闭原因，用于提示用户
   */
  close(sessionId: string, reason: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.sessions.delete(sessionId)
    try {
      session.stream.close()
    } catch {
      // 流可能已由远端关闭，忽略
    }
    // 先补齐尚未冲刷的输出再通知退出，保证用户能看到最后一段内容
    this.flushSession(sessionId)
    this.pool.release(session.connectionId)
    this.onExit(sessionId, reason)
  }

  /**
   * 把键盘输入写入远端 PTY。
   * @param sessionId 会话 id
   * @param data 键盘输入
   */
  write(sessionId: string, data: string): void {
    this.sessions.get(sessionId)?.stream.write(data)
  }

  /**
   * 同步终端尺寸到远端 PTY，缺少这一步 vim、top 等全屏程序会错行。
   * @param sessionId 会话 id
   * @param cols 列数
   * @param rows 行数
   */
  resize(sessionId: string, cols: number, rows: number): void {
    this.sessions.get(sessionId)?.stream.setWindow(rows, cols, 0, 0)
  }
}
