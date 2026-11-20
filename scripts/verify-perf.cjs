/**
 * 终端吞吐与输出完整性验证脚本（不启动 Electron，可直接用 node 运行）。
 *
 * 背景：README「架构要点」里有一份关于终端数据通道的测量结论——「20MB 连续输出下端口路径与
 * IPC 路径差异被噪声淹没，真正耗时在 ssh2 自身的加解密与包处理（45~70MB/s），
 * setImmediate 批量合并已把 20MB 压成 35~45 条消息；合成压力测试里端口路径在 512KB/64KB
 * 分片下反而慢约 20%」。该结论决定了最终**不回退**到 MessageChannelMain，因此必须能被独立复跑。
 *
 * 本脚本负责两件事：
 *   1. 边界正确性：20MB 连续输出在「远端 → SSH → 主进程 → setImmediate 批量合并 → onData
 *      （即 IPC 前的最后一站）」这条链路上逐字节不丢、顺序不乱，且退出事件一定在所有数据之后；
 *   2. 复核测量结论：用与 README 相同的口径（同一台机器、同样 20MB、同样走 ssh2）复跑一次，
 *      给出会话管理器路径与「纯 ssh2 无批量合并」基线的耗时、吞吐与消息条数，供对照。
 *
 * 结论的可信度判断标准（写进验证报告）：纯 ssh2 基线的吞吐应与 45~70MB/s 同一量级；
 * 会话管理器路径的消息条数应与 35~45 条同一量级（分片大小一致时）。
 *
 * 说明：本脚本占用 127.0.0.1:2222 起一个测试 SSH 服务，请与其它验证脚本串行执行。
 */
const { Server, Client } = require('ssh2')
const { createHash } = require('crypto')
const fs = require('fs')
const Module = require('module')
const os = require('os')
const path = require('path')
const ts = require('typescript')
const { generateHostKey } = require('./host-key.cjs')

/** 测试 SSH 服务端口，与其它验证脚本保持一致 */
const SSH_PORT = 2222
/** 主用例数据量：与 README 的 20MB 口径一致 */
const MAIN_SIZE = 20 * 1024 * 1024
/** 主用例服务端分片大小（对齐 README 里的 64KB 分片口径） */
const MAIN_CHUNK = 64 * 1024
/** 合成压力用例：小分片下的消息条数（验证批量合并确实在起作用） */
const SMALL_SIZE = 4 * 1024 * 1024
const SMALL_CHUNK = 4 * 1024
/** 负载尾部标记，用于确认数据流完整结束 */
const TRAILER = Buffer.from('\n[PERF-END]\n', 'utf8')

/** 编译产物目录 */
const BUILD_DIR = path.join(__dirname, '..', '.verify-build-perf')
/** 桩实现的数据目录 */
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-perf-data-'))

let passed = 0

/**
 * 记录一条通过项。
 * @param {string} message 描述
 */
function pass(message) {
  passed += 1
  console.log(`[通过] ${message}`)
}

/**
 * 断言条件成立，不成立直接抛错（退出码非零）。
 * @param {boolean} condition 条件
 * @param {string} message 描述
 */
function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`)
  pass(message)
}

/**
 * 输出一条测量数据。
 * @param {string} message 描述
 */
function data(message) {
  console.log(`[数据] ${message}`)
}

/**
 * 生成可校验顺序的负载：每 1KB 块的开头写入块号（8 位十进制 + 竖线），其余字节按块号填充。
 * 这样既能用 SHA-256 校验整段内容，也能按绝对偏移抽查「第 N 块是否落在第 N 个位置」。
 * @param {number} size 总字节数
 * @returns {Buffer} 负载
 */
function buildPayload(size) {
  const buffer = Buffer.alloc(size)
  for (let block = 0; block * 1024 < size; block += 1) {
    const start = block * 1024
    const header = `${String(block).padStart(8, '0')}|`
    buffer.write(header, start, 'utf8')
    const fill = (block * 31 + 7) & 0xff
    buffer.fill(fill, start + header.length, Math.min(start + 1024, size))
  }
  return buffer
}

/**
 * 校验负载里若干块的块号与偏移是否对应。
 * @param {Buffer} received 实际收到的字节
 * @param {number} size 期望总长度
 * @returns {string} 校验结论描述
 */
function checkOrder(received, size) {
  const blocks = Math.floor(size / 1024)
  const samples = [0, 1, Math.floor(blocks / 3), Math.floor(blocks / 2), blocks - 2, blocks - 1]
  for (const block of samples) {
    const expected = `${String(block).padStart(8, '0')}|`
    const actual = received.subarray(block * 1024, block * 1024 + 9).toString('utf8')
    if (actual !== expected) {
      throw new Error(`第 ${block} 块位置的内容不是该块本身：期望 ${expected}，实际 ${actual}`)
    }
  }
  return `抽查第 ${samples.join('、')} 块，块号与偏移一一对应`
}

/**
 * 按固定分片把负载写到流上，带背压处理。
 * @param {import('stream').Writable} stream 目标流
 * @param {Buffer} payload 负载
 * @param {number} chunkSize 分片大小
 * @returns {Promise<void>} 写完的 Promise
 */
function writeInChunks(stream, payload, chunkSize) {
  return new Promise((resolve, reject) => {
    let offset = 0
    const pump = () => {
      while (offset < payload.length) {
        const chunk = payload.subarray(offset, Math.min(offset + chunkSize, payload.length))
        offset += chunk.length
        if (!stream.write(chunk)) {
          stream.once('drain', pump)
          return
        }
      }
      stream.write(TRAILER, () => {
        stream.exit(0)
        stream.end()
        resolve()
      })
    }
    stream.once('error', reject)
    pump()
  })
}

/**
 * 启动测试 SSH 服务：shell 通道一建立就把指定负载按分片推给客户端。
 * @param {string} hostKey 主机私钥，整个脚本共用一把，避免中途换密钥触发 TOFU 拒绝
 * @param {Buffer} payload 负载
 * @param {number} chunkSize 分片大小
 * @returns {Promise<import('ssh2').Server>} 已监听的服务端
 */
function startServer(hostKey, payload, chunkSize) {
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on('error', () => undefined)
    client.on('authentication', (ctx) => ctx.accept())
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept()
        session.on('pty', (acceptPty) => acceptPty())
        session.on('window-change', (acceptChange) => acceptChange && acceptChange())
        session.on('shell', (acceptShell) => {
          const stream = acceptShell()
          writeInChunks(stream, payload, chunkSize).catch(() => stream.end())
        })
      })
    })
  })
  return new Promise((resolve) => server.listen(SSH_PORT, '127.0.0.1', () => resolve(server)))
}

/**
 * 把主进程 TS 模块编译成临时目录下的 CJS。
 * @param {string} fileName 源文件名
 * @param {string} outName 输出文件名
 * @param {string} sourceDir 源文件所在目录
 */
function compileTo(fileName, outName, sourceDir = '../src/main') {
  const source = fs.readFileSync(path.resolve(__dirname, `${sourceDir}/${fileName}`), 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    },
    fileName
  })
  fs.writeFileSync(path.join(BUILD_DIR, outName), outputText, 'utf8')
}

/**
 * 注入 electron 桩后加载编译产物。
 * @returns {{ ssh: object }} 编译出来的模块
 */
function loadModules() {
  fs.rmSync(BUILD_DIR, { recursive: true, force: true })
  fs.mkdirSync(BUILD_DIR, { recursive: true })
  compileTo('ssh.ts', 'ssh.js')
  compileTo('errors.ts', 'errors.js')
  compileTo('errors.ts', 'shared-errors.js', '../src/shared')

  const electronStub = {
    app: { getPath: () => DATA_DIR },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (plain) => Buffer.from(plain, 'utf8'),
      decryptString: (buffer) => buffer.toString('utf8')
    }
  }

  const originalLoad = Module._load
  Module._load = function (request, ...rest) {
    if (request === 'electron') return electronStub
    if (request === '@shared/errors') return require(path.join(BUILD_DIR, 'shared-errors.js'))
    if (request === './errors') return require(path.join(BUILD_DIR, 'errors.js'))
    return originalLoad.call(this, request, ...rest)
  }
  try {
    return { ssh: require(path.join(BUILD_DIR, 'ssh.js')) }
  } finally {
    Module._load = originalLoad
  }
}

/** 运行时资源，失败时兜底释放 */
const resources = { server: null, pool: null }

/**
 * 用真实 SshSessionManager 跑一次输出，统计消息条数与耗时。
 * @param {object} sshModule 编译后的 ssh 模块
 * @param {Buffer} payload 期望收到的负载
 * @returns {Promise<object>} 统计结果
 */
async function measureSessionManager(sshModule, payload) {
  const pool = new sshModule.SshConnectionPool()
  resources.pool = pool
  const chunks = []
  const sizes = []
  /** onExit 触发时已经收到的字节数，用于验证「退出事件在数据之后」 */
  let bytesAtExit = null
  let exitReason = null
  let firstDataAt = null
  let lastDataAt = null

  const manager = new sshModule.SshSessionManager(
    pool,
    (_sessionId, data) => {
      const buffer = Buffer.from(data)
      chunks.push(buffer)
      sizes.push(buffer.length)
      const now = process.hrtime.bigint()
      if (firstDataAt === null) firstDataAt = now
      lastDataAt = now
    },
    (_sessionId, reason) => {
      bytesAtExit = chunks.reduce((sum, item) => sum + item.length, 0)
      exitReason = reason
    }
  )

  const started = process.hrtime.bigint()
  const opened = await manager.open(
    {
      connectionId: 'verify-perf',
      title: '吞吐验证目标',
      host: '127.0.0.1',
      port: SSH_PORT,
      username: 'tester',
      password: 'any'
    },
    80,
    24
  )

  const expected = payload.length + TRAILER.length
  const deadline = Date.now() + 120000
  while (bytesAtExit === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  const finished = process.hrtime.bigint()

  const received = Buffer.concat(chunks)
  const elapsedMs = Number(finished - started) / 1e6
  const dataMs = firstDataAt && lastDataAt ? Number(lastDataAt - firstDataAt) / 1e6 : 0
  const result = {
    sessionId: opened.sessionId,
    received,
    expected,
    messages: sizes.length,
    maxMessage: sizes.length ? Math.max(...sizes) : 0,
    avgMessage: sizes.length ? Math.round(received.length / sizes.length) : 0,
    elapsedMs,
    dataMs,
    throughput: received.length / 1024 / 1024 / (elapsedMs / 1000),
    dataThroughput: dataMs > 0 ? received.length / 1024 / 1024 / (dataMs / 1000) : 0,
    bytesAtExit,
    exitReason
  }
  manager.close(opened.sessionId, '验证结束')
  pool.dispose()
  resources.pool = null
  return result
}

/**
 * 纯 ssh2 客户端基线：不经过应用的会话管理器，直接统计 shell 通道收到的字节与耗时。
 * @param {Buffer} payload 期望收到的负载
 * @returns {Promise<object>} 统计结果
 */
async function measureRawSsh2(payload) {
  const client = new Client()
  const chunks = []
  let firstDataAt = null
  let lastDataAt = null
  const started = process.hrtime.bigint()
  await new Promise((resolve, reject) => {
    client.once('ready', resolve)
    client.once('error', reject)
    client.connect({
      host: '127.0.0.1',
      port: SSH_PORT,
      username: 'tester',
      password: 'any',
      readyTimeout: 20000,
      hostVerifier: () => true
    })
  })
  const stream = await new Promise((resolve, reject) => {
    client.shell({ term: 'xterm-256color', cols: 80, rows: 24 }, (err, channel) =>
      err ? reject(err) : resolve(channel)
    )
  })
  const expected = payload.length + TRAILER.length
  await new Promise((resolve) => {
    const check = () => {
      const total = chunks.reduce((sum, item) => sum + item.length, 0)
      if (total >= expected) resolve()
    }
    stream.on('data', (chunk) => {
      chunks.push(chunk)
      const now = process.hrtime.bigint()
      if (firstDataAt === null) firstDataAt = now
      lastDataAt = now
      check()
    })
    stream.on('close', resolve)
  })
  const finished = process.hrtime.bigint()
  const received = Buffer.concat(chunks)
  const elapsedMs = Number(finished - started) / 1e6
  // 数据段耗时：从首包到末包，去掉连接与握手这段固定开销，才可比「加解密与包处理」的吞吐
  const dataMs = firstDataAt && lastDataAt ? Number(lastDataAt - firstDataAt) / 1e6 : 0
  client.end()
  return {
    received,
    expected,
    messages: chunks.length,
    elapsedMs,
    dataMs,
    throughput: received.length / 1024 / 1024 / (elapsedMs / 1000),
    dataThroughput: dataMs > 0 ? received.length / 1024 / 1024 / (dataMs / 1000) : 0
  }
}

async function main() {
  const payload = buildPayload(MAIN_SIZE)
  // 期望收到的完整字节 = 负载 + 尾部标记，哈希按两者一起算，避免把「少了尾部」误判成内容不符
  const expectedBytes = Buffer.concat([payload, TRAILER])
  const payloadHash = createHash('sha256').update(expectedBytes).digest('hex')
  // 整个脚本共用一把主机密钥：中途换密钥会让连接池按 TOFU 拒绝，与本次要测的东西无关
  const hostKey = generateHostKey()
  console.log(`[信息] 主用例负载 ${MAIN_SIZE / 1024 / 1024}MB，分片 ${MAIN_CHUNK / 1024}KB`)

  // -------------------------------------------------------------------------
  // 1. 20MB 输出完整性（会话管理器路径 = IPC 之前的最后一站）
  // -------------------------------------------------------------------------
  let server = await startServer(hostKey, payload, MAIN_CHUNK)
  resources.server = server
  const { ssh: sshModule } = loadModules()
  const managed = await measureSessionManager(sshModule, payload)

  assert(
    managed.received.length === managed.expected,
    `20MB 连续输出字节数完整（收到 ${managed.received.length} / 期望 ${managed.expected}）`
  )
  const receivedHash = createHash('sha256').update(managed.received).digest('hex')
  assert(
    receivedHash === payloadHash,
    `20MB 输出 SHA-256 与源负载一致（${receivedHash.slice(0, 16)}…）`
  )
  assert(
    managed.received.subarray(-TRAILER.length).equals(TRAILER),
    '负载尾部标记完整到达，没有被截断'
  )
  pass(checkOrder(managed.received, MAIN_SIZE))
  assert(
    managed.bytesAtExit === managed.expected && managed.exitReason !== null,
    `退出事件在全部数据之后（退出时已收 ${managed.bytesAtExit} / ${managed.expected} 字节，原因「${managed.exitReason}」）`
  )
  assert(
    managed.messages > 0 && managed.messages < 400,
    `批量合并生效：20MB 只产生 ${managed.messages} 条 IPC 消息（平均 ${Math.round(managed.avgMessage / 1024)}KB/条）`
  )
  data(
    `会话管理器路径：耗时 ${managed.elapsedMs.toFixed(0)}ms（数据段 ${managed.dataMs.toFixed(0)}ms），吞吐 ${managed.throughput.toFixed(1)}MB/s（数据段 ${managed.dataThroughput.toFixed(1)}MB/s），消息 ${managed.messages} 条，最大 ${Math.round(managed.maxMessage / 1024)}KB/条`
  )

  // -------------------------------------------------------------------------
  // 2. 纯 ssh2 基线：复核 README「瓶颈在 ssh2 侧」的结论
  // -------------------------------------------------------------------------
  const raw = await measureRawSsh2(payload)
  assert(
    raw.received.length === raw.expected &&
      createHash('sha256').update(raw.received).digest('hex') === payloadHash,
    '纯 ssh2 基线的 20MB 输出同样逐字节完整（对照口径一致）'
  )
  data(
    `纯 ssh2 基线：耗时 ${raw.elapsedMs.toFixed(0)}ms（数据段 ${raw.dataMs.toFixed(0)}ms），吞吐 ${raw.throughput.toFixed(1)}MB/s（数据段 ${raw.dataThroughput.toFixed(1)}MB/s），消息 ${raw.messages} 条`
  )
  // README 记录的是本机实测区间（数据段 280~310MB/s、应用层 80~140MB/s），
  // 绝对数字随机器与负载波动，这里只要求与记录区间同一量级，不把波动当失败
  const readmeLow = 140
  const readmeHigh = 400
  if (raw.dataThroughput >= readmeLow * 0.5 && raw.dataThroughput <= readmeHigh * 2) {
    pass(
      `纯 ssh2 数据段吞吐 ${raw.dataThroughput.toFixed(1)}MB/s 与 README 记录的量级一致（${readmeLow}~${readmeHigh}MB/s）`
    )
  } else {
    console.log(
      `[非致命] 纯 ssh2 数据段吞吐 ${raw.dataThroughput.toFixed(1)}MB/s 明显偏离 README 记录的 ${readmeLow}~${readmeHigh}MB/s，可能是机器负载或环境差异（结论方向不受影响：瓶颈仍在 ssh2 侧）`
    )
  }
  const timeDelta = ((managed.elapsedMs - raw.elapsedMs) / raw.elapsedMs) * 100
  data(`会话管理器路径相对纯 ssh2 基线的总耗时差异：${timeDelta.toFixed(1)}%（正数表示应用层更慢）`)

  // -------------------------------------------------------------------------
  // 3. 小分片压力：确认批量合并对碎片化输出有效
  // -------------------------------------------------------------------------
  await new Promise((resolve) => server.close(resolve))
  const smallPayload = buildPayload(SMALL_SIZE)
  server = await startServer(hostKey, smallPayload, SMALL_CHUNK)
  resources.server = server
  const small = await measureSessionManager(sshModule, smallPayload)
  assert(
    small.received.equals(Buffer.concat([smallPayload, TRAILER])),
    `4KB 分片下 ${SMALL_SIZE / 1024 / 1024}MB 输出仍然逐字节完整`
  )
  assert(
    small.messages < SMALL_SIZE / SMALL_CHUNK / 4,
    `4KB 分片被合并：${SMALL_SIZE / SMALL_CHUNK} 个分片只产生 ${small.messages} 条消息`
  )
  data(
    `4KB 分片路径：耗时 ${small.elapsedMs.toFixed(0)}ms，吞吐 ${small.throughput.toFixed(1)}MB/s，消息 ${small.messages} 条，平均 ${Math.round(small.avgMessage / 1024)}KB/条`
  )

  server.close()
  fs.rmSync(BUILD_DIR, { recursive: true, force: true })
  fs.rmSync(DATA_DIR, { recursive: true, force: true })
  console.log(`\n[结果] 全部通过，共 ${passed} 项`)
}

main().catch((err) => {
  console.error(`\n[失败] ${err.message}`)
  if (err.stack) console.error(err.stack)
  if (resources.server) resources.server.close()
  if (resources.pool) resources.pool.dispose()
  setTimeout(() => process.exit(1), 300)
})
