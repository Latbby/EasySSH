/**
 * 端口转发（SSH 隧道）管理器。
 *
 * 三种模式与 ssh 命令行的对应关系：
 *   - local   ≈ ssh -L：本地监听端口，收到连接后经 SSH 通道请求服务端连到目标地址；
 *   - remote  ≈ ssh -R：请求服务端监听远端端口，远端每来一个连接就转发到本机可达的目标地址；
 *   - dynamic ≈ ssh -D：本地起一个 SOCKS5 服务，由客户端在握手时指定目标地址。
 *
 * 与终端、SFTP 共享同一个连接池：规则启动时向连接池申请一次引用，停止或出错时释放，
 * 因此同一条转发规则不会额外握手，也不会在停止时把别人仍在用的连接一并关掉。
 * 所有失败都以中文 message + status='error' 的形式回到渲染进程，绝不把异常抛给主进程。
 */
import { createServer, connect as connectTcp, type Server, type Socket } from 'net'
import { randomUUID } from 'crypto'
import type { Client, ClientChannel, TcpConnectionDetails } from 'ssh2'
import type { ForwardRuleDTO, ForwardRuleVO, ForwardType } from '@shared/types'
import { POOL_CLOSED, type ResolvedSshConfig, type SshConnectionPool } from './ssh'
import { toReadableError } from './errors'

/** 监听地址留空时的默认回环地址 */
const DEFAULT_HOST = '127.0.0.1'

/** SOCKS5 协议版本号 */
const SOCKS_VERSION = 0x05

/** SOCKS5 应答码：成功 */
const SOCKS_SUCCEEDED = 0x00

/** SOCKS5 应答码：一般性失败，多用于连接目标失败 */
const SOCKS_FAILURE = 0x01

/** 转发类型的中文名，用于列表标题 */
const TYPE_LABEL: Record<ForwardType, string> = {
  local: '本地转发',
  remote: '远程转发',
  dynamic: '动态转发'
}

/**
 * SOCKS5 CONNECT 请求的解析结果。
 * null 表示字节还没收全；{ reply } 表示协议不支持，需要按该应答码回复后断开。
 */
type SocksParse = { host: string; port: number; length: number } | { reply: number } | null

/**
 * 解析 SOCKS5 请求报文（VER / CMD / RSV / ATYP / DST.ADDR / DST.PORT）。
 * 只支持 CONNECT：BIND 与 UDP ASSOCIATE 回「命令不支持」，避免客户端一直等应答。
 * @param buffer 已累积的字节
 * @returns 目标地址与端口（含已消费长度）、应回复的错误码，或 null 表示数据不完整
 */
function parseSocksRequest(buffer: Buffer): SocksParse {
  if (buffer.length < 4) return null
  if (buffer[0] !== SOCKS_VERSION) return { reply: SOCKS_FAILURE }
  // 0x01 为 CONNECT，其余命令（BIND、UDP ASSOCIATE）不支持
  if (buffer[1] !== 0x01) return { reply: 0x07 }

  const atyp = buffer[3]
  let host: string
  let offset: number

  if (atyp === 0x01) {
    // IPv4：4 字节地址
    if (buffer.length < 10) return null
    host = `${buffer[4]}.${buffer[5]}.${buffer[6]}.${buffer[7]}`
    offset = 8
  } else if (atyp === 0x03) {
    // 域名：1 字节长度 + 域名
    if (buffer.length < 5) return null
    const size = buffer[4]
    if (buffer.length < 5 + size + 2) return null
    host = buffer.subarray(5, 5 + size).toString('utf8')
    offset = 5 + size
  } else if (atyp === 0x04) {
    // IPv6：16 字节地址，按 8 组十六进制展开
    if (buffer.length < 22) return null
    const groups: string[] = []
    for (let i = 0; i < 8; i += 1) groups.push(buffer.readUInt16BE(4 + i * 2).toString(16))
    host = groups.join(':')
    offset = 20
  } else {
    // 地址类型不支持：0x08
    return { reply: 0x08 }
  }

  return { host, port: buffer.readUInt16BE(offset), length: offset + 2 }
}

/**
 * 本地监听失败时的中文提示。
 * errors.ts 的词表里没有 EADDRINUSE，而端口占用恰恰是转发最常见的失败原因，这里补一条明确的说法。
 * @param err 监听失败的原始错误
 * @param scene 操作场景
 * @returns 中文化错误
 */
function listenError(err: unknown, scene: string): Error {
  const raw = err as { code?: string }
  if (raw?.code === 'EADDRINUSE') {
    return new Error(`端口已被占用，请换一个端口或先停止占用它的程序（${scene}）`, {
      cause: err as Error
    })
  }
  return toReadableError(err, scene)
}

/**
 * 转发通道建立失败时的中文提示。
 * ssh2 在这个环节只回英文原因（Unable to bind、Channel open failure 等），errors.ts 的词表覆盖不到，
 * 这里按关键字补一条能给用户指路的中文说明，原始信息仍由 toReadableError 附在后面。
 * @param err 通道建立失败的原始错误
 * @param scene 操作场景
 * @returns 中文化错误
 */
function forwardError(err: unknown, scene: string): Error {
  const raw = err instanceof Error ? err : new Error(String(err))
  if (/unable to bind/i.test(raw.message)) {
    return new Error(`服务端无法监听该端口，可能已被占用或不允许转发（${scene}）`, { cause: raw })
  }
  if (/administratively prohibited/i.test(raw.message)) {
    return new Error(
      `服务端禁止该转发，请检查 sshd 的 AllowTcpForwarding 与 PermitOpen 配置（${scene}）`,
      {
        cause: raw
      }
    )
  }
  if (/channel open failure/i.test(raw.message)) {
    return new Error(`转发通道被服务端拒绝，目标地址可能不可达或不被允许（${scene}）`, {
      cause: raw
    })
  }
  if (/not connected|no response from server/i.test(raw.message)) {
    return new Error(`SSH 连接已断开，请重新启动转发（${scene}）`, { cause: raw })
  }
  return toReadableError(raw, scene)
}

/**
 * 整理启动阶段最终要展示的错误文案。
 * listenError / forwardError 已经给出带场景的中文说明，再套一层 toReadableError 会把同一句话重复两遍，
 * 因此带中文说明的错误直接沿用，其余才交给 errors.ts 统一翻译。
 * @param err 启动过程中捕获的错误
 * @param scene 操作场景
 * @returns 中文错误文案
 */
function startErrorMessage(err: unknown, scene: string): string {
  const raw = err instanceof Error ? err : new Error(String(err))
  if (/[\u4e00-\u9fff]/.test(raw.message)) return raw.message
  return toReadableError(raw, scene).message
}

/** 规则运行时的资源句柄，停止时按它精确回收 */
interface RuleRuntime {
  /** 底层 SSH 连接，引用计数由连接池维护 */
  client: Client
  /** local / dynamic 的本地监听；remote 转发没有本地监听 */
  server?: Server
  /** 已建立的本地连接，停止时统一销毁，避免留下半开连接 */
  sockets: Set<Socket>
  /** remote 转发在 client 上注册的 'tcp connection' 监听器，停止时移除 */
  onTcpConnection?: (
    details: TcpConnectionDetails,
    accept: () => ClientChannel,
    reject: () => void
  ) => void
  /** 撤销远端监听，仅 remote 转发需要 */
  unforward?: () => void
}

/** 一条转发规则的完整记录：出参 + 建链参数 + 运行时资源 */
interface RuleRecord {
  /** 列表出参，status / message / connections 随运行情况就地更新 */
  vo: ForwardRuleVO
  /** ipc 层解析好的连接参数，规则停止后保留，便于按原连接重新启动 */
  config: ResolvedSshConfig
  /** 运行中的资源，null 表示当前未运行 */
  runtime: RuleRuntime | null
}

/**
 * 端口转发管理器。
 * 维护规则列表与各自的监听资源，并把每次状态变化通过 onEvent 上报给渲染进程。
 */
export class ForwardManager {
  /** 规则 id 到规则记录 */
  private rules = new Map<string, RuleRecord>()

  /**
   * @param pool 共享的 SSH 连接池
   * @param onEvent 规则状态变化回调，由 ipc 层广播给渲染进程
   */
  constructor(
    private readonly pool: SshConnectionPool,
    private readonly onEvent: (vo: ForwardRuleVO) => void
  ) {
    // 底层连接断开后该连接上的转发已不可能继续，标记为错误并回收监听，避免面板仍显示「运行中」
    pool.on(POOL_CLOSED, (connectionId: string) => {
      for (const record of [...this.rules.values()]) {
        if (record.runtime && record.config.connectionId === connectionId) {
          this.teardown(record, 'SSH 连接已断开，转发已停止')
          this.emit(record)
        }
      }
    })
  }

  /**
   * 查询全部规则。
   * @returns 规则出参副本数组，按创建顺序排列
   */
  list(): ForwardRuleVO[] {
    return [...this.rules.values()].map((record) => ({ ...record.vo }))
  }

  /**
   * 新增并启动一条规则；传入已存在的 id 表示按新入参重启该规则。
   * 建链失败（端口被占用、认证失败、远端拒绝监听等）不会抛出，而是写入中文 message 并置 error。
   * @param dto 规则入参
   * @param config ipc 层解析好的连接参数，凭据已在主进程内解密
   * @returns 启动后的规则出参
   */
  async start(dto: ForwardRuleDTO, config: ResolvedSshConfig): Promise<ForwardRuleVO> {
    const existing = dto.id ? this.rules.get(dto.id) : undefined
    // 同一 id 再次启动等价于「按新配置重启」：先停掉旧监听，否则会撞上自己占用的端口
    if (existing) this.teardown(existing)

    const vo: ForwardRuleVO = {
      id: existing?.vo.id ?? randomUUID(),
      type: dto.type,
      localHost: dto.localHost?.trim() || DEFAULT_HOST,
      localPort: dto.localPort,
      remoteHost: dto.type === 'dynamic' ? undefined : dto.remoteHost?.trim(),
      remotePort: dto.type === 'dynamic' ? undefined : dto.remotePort,
      title: `${config.title} · ${TYPE_LABEL[dto.type]}`,
      status: 'stopped',
      // 累计连接数跨重启保留，用户据此判断这条规则历史上是否真的通过流量
      connections: existing?.vo.connections ?? 0
    }
    const record: RuleRecord = { vo, config, runtime: null }
    this.rules.set(vo.id, record)

    if (!Number.isInteger(vo.localPort) || vo.localPort < 1 || vo.localPort > 65535) {
      return this.fail(record, '监听端口必须是 1-65535 之间的整数')
    }
    if (dto.type !== 'dynamic' && (!vo.remoteHost || !vo.remotePort)) {
      return this.fail(record, '缺少目标地址或目标端口')
    }

    try {
      const client = await this.pool.acquire(config)
      const runtime: RuleRuntime = { client, sockets: new Set() }
      record.runtime = runtime
      if (dto.type === 'local') await this.startLocal(record, runtime)
      else if (dto.type === 'remote') await this.startRemote(record, runtime)
      else await this.startDynamic(record, runtime)
      vo.status = 'running'
      vo.message = undefined
    } catch (err) {
      return this.fail(record, startErrorMessage(err, `启动${TYPE_LABEL[dto.type]}`))
    }

    this.emit(record)
    return { ...record.vo }
  }

  /**
   * 停止指定规则，配置保留在列表中，可以再次启动。
   * @param id 规则 id
   */
  async stop(id: string): Promise<void> {
    const record = this.rules.get(id)
    if (!record) return
    this.teardown(record)
    this.emit(record)
  }

  /**
   * 删除指定规则，运行中的规则会先停止。
   * @param id 规则 id
   */
  async remove(id: string): Promise<void> {
    const record = this.rules.get(id)
    if (!record) return
    this.teardown(record)
    this.rules.delete(id)
  }

  /** 应用退出前停止全部规则并释放连接引用 */
  dispose(): void {
    for (const record of this.rules.values()) this.teardown(record)
    this.rules.clear()
  }

  /**
   * 启动本地转发：本地监听端口，每个连接经 forwardOut 由服务端连到目标地址。
   * @param record 规则记录
   * @param runtime 运行时资源
   */
  private async startLocal(record: RuleRecord, runtime: RuleRuntime): Promise<void> {
    const { vo } = record
    const target = `${vo.remoteHost}:${vo.remotePort}`
    const server = createServer((socket) => {
      runtime.sockets.add(socket)
      socket.on('close', () => runtime.sockets.delete(socket))
      // 本地连接异常只影响这一条连接，必须就地吞掉，不能让它变成未捕获异常
      socket.on('error', () => socket.destroy())
      // 源地址取真实来源，服务端日志里能看到隧道是被谁用的
      runtime.client.forwardOut(
        socket.remoteAddress ?? DEFAULT_HOST,
        socket.remotePort ?? 0,
        vo.remoteHost as string,
        vo.remotePort as number,
        (err, channel) => {
          if (err) {
            socket.destroy()
            this.noteFailure(record, forwardError(err, `转发到 ${target}`).message)
            return
          }
          this.bridge(record, runtime, socket, channel)
        }
      )
    })
    runtime.server = server
    await this.listen(server, record)
  }

  /**
   * 启动远程转发：请求服务端监听远端端口，远端每个连接都转到本机可达的目标地址。
   * @param record 规则记录
   * @param runtime 运行时资源
   */
  private async startRemote(record: RuleRecord, runtime: RuleRuntime): Promise<void> {
    const { vo } = record
    const client = runtime.client
    const listenHost = vo.localHost || DEFAULT_HOST

    await new Promise<void>((resolve, reject) => {
      client.forwardIn(listenHost, vo.localPort, (err) =>
        err ? reject(forwardError(err, `请求远端监听 ${listenHost}:${vo.localPort}`)) : resolve()
      )
    })
    // 停止时撤销远端监听，否则服务端会一直占着这个端口
    runtime.unforward = () => {
      try {
        client.unforwardIn(listenHost, vo.localPort, () => undefined)
      } catch {
        // 连接已断开时可能直接抛错，忽略即可
      }
    }

    const onTcpConnection = (
      details: TcpConnectionDetails,
      accept: () => ClientChannel,
      reject: () => void
    ): void => {
      // 同一条连接上可能挂着多条远程转发规则，按远端监听端口认领属于自己的连接
      if (details.destPort !== vo.localPort) return
      const channel = accept()
      const target = `${vo.remoteHost}:${vo.remotePort}`
      const socket = connectTcp({ host: vo.remoteHost as string, port: vo.remotePort as number })
      runtime.sockets.add(socket)
      // 本机目标连不上时要立刻拒绝这条远端连接并说明原因，不能让远端一直干等
      const onConnectError = (err: Error): void => {
        runtime.sockets.delete(socket)
        reject()
        channel.close()
        this.noteFailure(record, toReadableError(err, `连接本地目标 ${target}`).message)
      }
      socket.once('error', onConnectError)
      socket.once('connect', () => {
        socket.off('error', onConnectError)
        this.bridge(record, runtime, socket, channel)
      })
    }
    client.on('tcp connection', onTcpConnection)
    runtime.onTcpConnection = onTcpConnection
  }

  /**
   * 启动动态转发：本地提供 SOCKS5 服务（仅 CONNECT、无认证），目标地址由客户端指定。
   * @param record 规则记录
   * @param runtime 运行时资源
   */
  private async startDynamic(record: RuleRecord, runtime: RuleRuntime): Promise<void> {
    const server = createServer((socket) => {
      runtime.sockets.add(socket)
      socket.on('close', () => runtime.sockets.delete(socket))
      // 客户端半途断开是常态，就地关闭这条连接即可
      socket.on('error', () => socket.destroy())
      this.handleSocks(record, runtime, socket)
    })
    runtime.server = server
    await this.listen(server, record)
  }

  /**
   * 处理一条 SOCKS5 客户端连接：先完成无认证握手，再按 CONNECT 请求经 SSH 通道转发。
   * 协议解析必须容忍分片到达，因此用缓冲区累积到报文完整为止。
   * @param record 规则记录
   * @param runtime 运行时资源
   * @param socket 本地客户端连接
   */
  private handleSocks(record: RuleRecord, runtime: RuleRuntime, socket: Socket): void {
    let buffer = Buffer.alloc(0)
    let greeted = false

    /** 累积字节并在报文完整时继续下一步 */
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk])

      if (!greeted) {
        if (buffer.length < 2) return
        if (buffer[0] !== SOCKS_VERSION) {
          socket.destroy()
          return
        }
        const methods = buffer[1]
        if (buffer.length < 2 + methods) return
        // 跳过客户端声明的方法列表：本服务不做认证，直接回复「无需认证」
        buffer = buffer.subarray(2 + methods)
        greeted = true
        socket.write(Buffer.from([SOCKS_VERSION, SOCKS_SUCCEEDED]))
      }

      if (buffer.length === 0) return
      const parsed = parseSocksRequest(buffer)
      if (parsed === null) return
      // 请求已经解析完，后续字节属于业务数据，改由管道转发
      socket.off('data', onData)

      if ('reply' in parsed) {
        socket.end(Buffer.from([SOCKS_VERSION, parsed.reply, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
        return
      }

      const target = { host: parsed.host, port: parsed.port }
      // 请求之后可能已经跟着业务数据（例如 HTTP 请求头），先取出来再清空缓冲
      const payload = buffer.subarray(parsed.length)
      buffer = Buffer.alloc(0)

      runtime.client.forwardOut(DEFAULT_HOST, 0, target.host, target.port, (err, channel) => {
        if (err) {
          socket.end(Buffer.from([SOCKS_VERSION, SOCKS_FAILURE, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
          this.noteFailure(
            record,
            forwardError(err, `转发到 ${target.host}:${target.port}`).message
          )
          return
        }
        if (payload.length) channel.write(payload)
        // 应答里 BND.ADDR / BND.PORT 填 0，客户端不会真的去连它
        socket.write(Buffer.from([SOCKS_VERSION, SOCKS_SUCCEEDED, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
        this.bridge(record, runtime, socket, channel)
      })
    }

    socket.on('data', onData)
  }

  /**
   * 把本地连接与 SSH 通道对接成双向管道，并累加一次成功转发的连接数。
   * 任一端断开时同时关闭另一端，避免留下半开连接。
   * @param record 规则记录
   * @param runtime 运行时资源
   * @param socket 本地连接
   * @param channel SSH 通道
   */
  private bridge(
    record: RuleRecord,
    runtime: RuleRuntime,
    socket: Socket,
    channel: ClientChannel
  ): void {
    runtime.sockets.add(socket)
    socket.on('close', () => runtime.sockets.delete(socket))
    channel.on('error', () => socket.destroy())
    socket.on('error', () => channel.close())
    socket.on('close', () => channel.close())
    channel.on('close', () => socket.destroy())
    socket.pipe(channel)
    channel.pipe(socket)
    // 计数只统计真正建成的转发连接，面板据此判断隧道是否在工作
    record.vo.connections += 1
    this.emit(record)
  }

  /**
   * 绑定本地监听端口。
   * 端口被占用、地址不可用等失败会抛出中文化错误，由调用方置为 error；
   * 监听成功后的运行期错误只更新 message，不影响已有连接。
   * @param server 本地服务
   * @param record 规则记录，用于拼装错误场景
   * @returns 监听就绪的 Promise
   */
  private listen(server: Server, record: RuleRecord): Promise<void> {
    const { vo } = record
    const scene = `监听 ${vo.localHost}:${vo.localPort}`
    return new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => reject(listenError(err, scene))
      server.once('error', onError)
      const onListening = (): void => {
        server.off('error', onError)
        server.on('error', (err: Error) =>
          this.noteFailure(record, listenError(err, scene).message)
        )
        resolve()
      }
      if (vo.localHost) server.listen(vo.localPort, vo.localHost, onListening)
      else server.listen(vo.localPort, onListening)
    })
  }

  /**
   * 把规则置为错误状态并回收已占用的资源。
   * @param record 规则记录
   * @param message 中文错误说明
   * @returns 规则出参副本
   */
  private fail(record: RuleRecord, message: string): ForwardRuleVO {
    this.teardown(record, message)
    this.emit(record)
    return { ...record.vo }
  }

  /**
   * 记录一次单连接失败。
   * 单条连接失败（目标端口未开放、客户端指定了不可达地址等）不代表隧道本身坏了，
   * 因此保持 running 状态，只把最后一条失败原因显示给用户，监听继续可用。
   * @param record 规则记录
   * @param message 中文错误说明
   */
  private noteFailure(record: RuleRecord, message: string): void {
    record.vo.message = message
    this.emit(record)
  }

  /**
   * 回收一条规则的运行时资源并把状态落到目标值。
   * @param record 规则记录
   * @param message 传入时置为 error 并显示该原因；不传则置为 stopped
   */
  private teardown(record: RuleRecord, message?: string): void {
    const runtime = record.runtime
    record.runtime = null
    if (runtime) {
      if (runtime.onTcpConnection) runtime.client.off('tcp connection', runtime.onTcpConnection)
      runtime.unforward?.()
      runtime.server?.close()
      runtime.sockets.forEach((socket) => socket.destroy())
      runtime.sockets.clear()
      // 与 acquire 严格配对，规则停止后底层连接才能按引用计数归还
      this.pool.release(record.config.connectionId)
    }
    record.vo.status = message === undefined ? 'stopped' : 'error'
    record.vo.message = message
  }

  /**
   * 上报规则最新状态。
   * @param record 规则记录
   */
  private emit(record: RuleRecord): void {
    this.onEvent({ ...record.vo })
  }
}
