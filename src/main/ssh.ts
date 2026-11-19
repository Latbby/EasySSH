import { app } from 'electron'
import { Client, type ClientChannel } from 'ssh2'
import { createHash, randomUUID } from 'crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { OpenTerminalVO } from '@shared/types'

/** 解析完成的 SSH 连接参数，认证凭据已在主进程内解密 */
export interface ResolvedSshConfig {
  /** 底层连接复用键，同键的多个终端标签共享一条 SSH 连接 */
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
  /** 引用计数：每个 shell 或 sftp 打开时加一，全部释放后关闭连接 */
  refs: number
}

/** 一个终端标签对应的会话 */
interface Session {
  id: string
  connectionId: string
  stream: ClientChannel
}

/** 已知主机指纹表，key 为 host:port，全部连接共用一份 */
let knownHosts: Record<string, string> | null = null

/** 已知主机指纹表文件路径 */
function knownHostsFile(): string {
  return join(app.getPath('userData'), 'known_hosts.json')
}

/**
 * 读取已知主机指纹表，进程内缓存。
 * @returns host:port 到 SHA256 指纹的映射
 */
function loadKnownHosts(): Record<string, string> {
  if (knownHosts) return knownHosts
  const file = knownHostsFile()
  let table: Record<string, string>
  try {
    table = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  } catch {
    table = {}
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
    table[target] = fingerprint
    saveKnownHosts()
    return true
  }
  return known === fingerprint
}

/**
 * SSH 会话管理器。
 * 负责底层连接复用、终端会话生命周期，以及把远端数据回调给渲染进程。
 */
export class SshSessionManager {
  /** connectionId 到复用中的底层连接 */
  private pool = new Map<string, PooledConnection>()
  /** sessionId 到终端会话 */
  private sessions = new Map<string, Session>()

  /**
   * @param onData 远端输出回调，data 为原始字节，交由渲染进程的 xterm 完成 UTF-8 解码
   * @param onExit 会话结束回调，reason 为结束原因
   */
  constructor(
    private readonly onData: (sessionId: string, data: Uint8Array) => void,
    private readonly onExit: (sessionId: string, reason: string) => void
  ) {}

  /**
   * 获取可用的底层连接，已存在则复用并递增引用计数。
   * @param config 解析后的连接参数
   * @returns 连接池对象
   */
  private async acquire(config: ResolvedSshConfig): Promise<PooledConnection> {
    const existing = this.pool.get(config.connectionId)
    if (existing) {
      existing.refs += 1
      return existing
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
        reject(err)
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

    // 建连后仍需持续监听：连接异常断开时要回收该连接下的全部会话
    client.on('error', () => undefined)
    client.on('close', () => {
      this.pool.delete(config.connectionId)
      const affected = [...this.sessions.values()].filter(
        (item) => item.connectionId === config.connectionId
      )
      affected.forEach((item) => this.close(item.id, '连接已断开'))
    })

    return pooled
  }

  /**
   * 释放一次引用计数，归零时关闭底层连接。
   * @param connectionId 底层连接复用键
   */
  private release(connectionId: string): void {
    const pooled = this.pool.get(connectionId)
    if (!pooled) return
    pooled.refs -= 1
    if (pooled.refs > 0) return
    this.pool.delete(connectionId)
    pooled.client.end()
  }

  /**
   * 打开一个终端标签，同配置已有连接时直接复用，避免重复握手。
   * @param config 解析后的连接参数
   * @param cols 终端列数
   * @param rows 终端行数
   * @returns 会话 id 与标签标题
   */
  async open(config: ResolvedSshConfig, cols: number, rows: number): Promise<OpenTerminalVO> {
    const pooled = await this.acquire(config)
    const sessionId = randomUUID()
    let stream: ClientChannel
    try {
      stream = await new Promise<ClientChannel>((resolve, reject) => {
        pooled.client.shell({ term: 'xterm-256color', cols, rows }, (err, channel) =>
          err ? reject(err) : resolve(channel)
        )
      })
    } catch (err) {
      // 开 shell 失败要把引用计数还回去，否则底层连接永远不会释放
      this.release(config.connectionId)
      throw err
    }

    this.sessions.set(sessionId, { id: sessionId, connectionId: config.connectionId, stream })
    // 直接透传原始字节，由 xterm 的 UTF-8 解码器处理跨数据包的多字节字符，避免中文乱码
    stream.on('data', (chunk: Buffer) => this.onData(sessionId, new Uint8Array(chunk)))
    stream.stderr.on('data', (chunk: Buffer) => this.onData(sessionId, new Uint8Array(chunk)))
    stream.on('close', () => this.close(sessionId, '会话已关闭'))

    return { sessionId, title: config.title }
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
    this.release(session.connectionId)
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

  /** 应用退出前关闭全部连接 */
  dispose(): void {
    this.pool.forEach((pooled) => pooled.client.end())
    this.pool.clear()
    this.sessions.clear()
  }
}
