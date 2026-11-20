/**
 * 端口转发（SSH 隧道）验证脚本，不启动 Electron，可直接用 node 运行。
 *
 * 目的：端口转发是本轮新增功能，且三条链路都容易「看起来启动成功、实际不通」，因此这里
 * 用真实的 ssh2 服务端 + 真实的本地 TCP 服务做端到端验证，被测对象是 src/main/forward.ts 的
 * ForwardManager 与 src/main/ssh.ts 的连接池（两者都用 TypeScript 编译器转成 CJS 后加载，
 * 只把 electron 替换成桩实现），逐项确认：
 *   1. local（ssh -L）：本地端口真实可连，且数据能双向穿过隧道
 *   2. 端口被占用时给出可读的中文错误，而不是把异常抛给主进程
 *   3. stop 之后本地端口真实释放，已建立的隧道连接被销毁
 *   4. dynamic（ssh -D）：内置 SOCKS5 握手与 CONNECT 成功、连接不通时回复失败码
 *   5. remote（ssh -R）：服务端收到监听请求，远端来连接时被导到本机目标，stop 时撤销远端监听
 *   6. 目标端口未开放时隧道保持可用（只记录最后一次失败原因），不会把整条规则置为错误
 *
 * 说明：本脚本占用 127.0.0.1:2222（测试 SSH 服务）与本文件顶部 TUNNEL 里的隧道端口，
 * 请勿与其它验证脚本并发执行。
 */
const net = require('net')
const fs = require('fs')
const Module = require('module')
const os = require('os')
const path = require('path')
const ts = require('typescript')
const { Server } = require('ssh2')
const { generateHostKey } = require('./host-key.cjs')

/** 测试 SSH 服务监听端口，与其它验证脚本保持一致 */
const SSH_PORT = 2222
/** 各用例使用的隧道端口，集中定义避免互相撞端口 */
const TUNNEL = {
  local: 15101,
  occupied: 15102,
  dynamic: 15103,
  dynamicBadTarget: 15104,
  remote: 15105,
  badTarget: 15106
}

/** 编译产物目录：forward.ts 与 ssh.ts 必须保持同名导入关系 */
const BUILD_DIR = path.join(__dirname, '..', '.verify-build-forward')
/** 桩实现使用的数据目录（known_hosts.json 会写到这里） */
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-forward-data-'))

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
 * @param {number} ms 毫秒
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 轮询等待条件成立，判定函数允许是异步的（例如「端口能否重新绑定」）。
 * @param {() => boolean|Promise<boolean>} predicate 判定函数
 * @param {string} label 描述
 * @param {number} timeout 超时毫秒数
 * @returns {Promise<void>}
 */
async function waitFor(predicate, label, timeout = 5000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await predicate()) {
      pass(label)
      return
    }
    await sleep(50)
  }
  throw new Error(`等待超时：${label}`)
}

// ---------------------------------------------------------------------------
// 本地测试服务：回显服务（充当隧道目标）+ 测试 SSH 服务
// ---------------------------------------------------------------------------

/**
 * 启动一个本地回显服务：连上先打招呼，之后原样回显，用于确认双向数据都通。
 * @returns {Promise<{port: number, close: () => Promise<void>, accepted: number}>} 服务句柄
 */
function startEchoService() {
  const state = { accepted: 0 }
  const server = net.createServer((socket) => {
    state.accepted += 1
    socket.write('TARGET-HELLO\n')
    socket.on('data', (chunk) => socket.write(chunk))
    socket.on('error', () => socket.destroy())
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        accepted: () => state.accepted,
        close: () => new Promise((done) => server.close(() => done()))
      })
    })
  })
}

/** 测试 SSH 服务端的观测数据 */
const sshObserved = {
  /** 收到过的远端监听请求（remote 转发） */
  forwards: [],
  /** 收到过的撤销监听请求 */
  cancels: [],
  /** 已建立过的客户端连接数与当前连接数 */
  opened: 0,
  active: 0
}

/**
 * 启动测试 SSH 服务：接受任意认证，支持 direct-tcpip（local/dynamic 转发要用）与
 * tcpip-forward（remote 转发要用），并把 direct-tcpip 请求真实连到目标地址。
 * @returns {Promise<import('ssh2').Server>} 已监听的服务端
 */
function startTestServer() {
  const hostKey = generateHostKey()
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on('error', () => undefined)
    sshObserved.opened += 1
    sshObserved.active += 1
    client.on('close', () => {
      sshObserved.active -= 1
    })
    client.on('authentication', (ctx) => ctx.accept())

    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept()
        session.on('pty', (acceptPty) => acceptPty())
        session.on('window-change', (acceptChange) => acceptChange && acceptChange())
        session.on('shell', (acceptShell) => {
          const stream = acceptShell()
          stream.write('forward-test-shell\r\n')
          stream.on('data', () => undefined)
        })
      })

      // direct-tcpip：local 与 dynamic 转发最终都走这里，模拟服务端连到目标地址
      // 注意服务端侧的事件名是 'tcpip'（客户端侧才叫 'tcp connection'），签名是 (accept, reject, info)
      client.on('tcpip', (accept, reject, info) => {
        const target = net.connect({ host: '127.0.0.1', port: info.destPort })
        target.once('connect', () => {
          const channel = accept()
          channel.pipe(target).pipe(channel)
          channel.on('close', () => target.destroy())
        })
        // 目标端口不可达时必须拒绝通道，客户端才能拿到「转发通道被服务端拒绝」这类可读错误
        target.once('error', () => {
          reject()
          target.destroy()
        })
      })

      // tcpip-forward：remote 转发的远端监听由服务端负责，测试里只记录请求
      client.on('request', (accept, reject, name, info) => {
        if (name === 'tcpip-forward') {
          sshObserved.forwards.push(`${info.bindAddr}:${info.bindPort}`)
          accept && accept()
          return
        }
        if (name === 'cancel-tcpip-forward') {
          sshObserved.cancels.push(`${info.bindAddr}:${info.bindPort}`)
          accept && accept()
          return
        }
        reject && reject()
      })
      // 供 remote 用例主动模拟「远端有连接进来」
      remoteClients.add(client)
      client.on('close', () => remoteClients.delete(client))
    })
  })
  return new Promise((resolve) => server.listen(SSH_PORT, '127.0.0.1', () => resolve(server)))
}

/** 当前已就绪的服务端客户端，remote 用例用它发起 forwarded-tcpip 通道 */
const remoteClients = new Set()

/** 运行时资源，用例失败时用它兜底释放，避免脚本卡住不退出 */
const resources = { server: null, echo: null, pool: null }

/**
 * 等一个已就绪的服务端客户端。
 * @param {number} timeout 超时毫秒数
 * @returns {Promise<any>} ssh2 服务端侧 client
 */
async function waitForRemoteClient(timeout = 5000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const client = [...remoteClients][0]
    if (client) return client
    await sleep(50)
  }
  throw new Error('等待 SSH 客户端连接超时（无法模拟远端连接）')
}

// ---------------------------------------------------------------------------
// 用 electron 桩加载编译后的主进程模块
// ---------------------------------------------------------------------------

/**
 * 把主进程 / 共享 TS 模块编译成临时目录下的 CJS。
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
 * @returns {{ ssh: object, forward: object }} 编译出来的模块
 */
function loadModules() {
  fs.rmSync(BUILD_DIR, { recursive: true, force: true })
  fs.mkdirSync(BUILD_DIR, { recursive: true })
  compileTo('ssh.ts', 'ssh.js')
  compileTo('forward.ts', 'forward.js')
  compileTo('errors.ts', 'errors.js')
  // @shared/* 别名由构建工具解析，单文件转译时需要手工指路
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
    return {
      ssh: require(path.join(BUILD_DIR, 'ssh.js')),
      forward: require(path.join(BUILD_DIR, 'forward.js'))
    }
  } finally {
    Module._load = originalLoad
  }
}

// ---------------------------------------------------------------------------
// 隧道客户端工具
// ---------------------------------------------------------------------------

/**
 * 连接本地隧道端口。
 * @param {number} port 本地监听端口
 * @returns {Promise<net.Socket>} 已连接的 socket
 */
function connectTunnel(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    socket.once('connect', () => resolve(socket))
    socket.once('error', reject)
  })
}

/**
 * 给 socket 挂上数据收集器。
 * @param {net.Socket} socket 目标 socket
 * @param {Buffer} [initial] 挂监听前已经收到的字节（例如 SOCKS5 应答后紧跟的业务数据）
 * @returns {() => string} 读取当前累计文本
 */
function collect(socket, initial) {
  const chunks = initial && initial.length ? [initial] : []
  socket.on('data', (chunk) => chunks.push(chunk))
  return () => Buffer.concat(chunks).toString('utf8')
}

/**
 * 编造一个 SOCKS5 CONNECT 请求（域名寻址）。
 * @param {string} host 目标主机
 * @param {number} port 目标端口
 * @returns {Buffer} 请求报文
 */
function socksConnectRequest(host, port) {
  const name = Buffer.from(host, 'utf8')
  const buffer = Buffer.alloc(7 + name.length)
  buffer[0] = 5
  buffer[1] = 1
  buffer[2] = 0
  buffer[3] = 3
  buffer[4] = name.length
  name.copy(buffer, 5)
  buffer.writeUInt16BE(port, 5 + name.length)
  return buffer
}

/**
 * 走 SOCKS5 连目标，返回应答码与仍可继续收发数据的 socket。
 * @param {number} proxyPort SOCKS5 代理端口
 * @param {string} host 目标主机
 * @param {number} port 目标端口
 * @returns {Promise<{code: number, socket: net.Socket}>} 应答码与 socket
 */
function socksConnect(proxyPort, host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: proxyPort })
    let stage = 0
    let buffer = Buffer.alloc(0)
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      if (stage === 0) {
        if (buffer.length < 2) return
        if (buffer[0] !== 5 || buffer[1] !== 0) {
          reject(new Error(`SOCKS5 握手被拒绝：${[...buffer].join(',')}`))
          return
        }
        buffer = Buffer.alloc(0)
        stage = 1
        socket.write(socksConnectRequest(host, port))
        return
      }
      if (buffer.length < 10) return
      const code = buffer[1]
      // 应答之后可能已经跟着目标服务的第一个数据包，必须原样交给后续收集器，不能丢
      const rest = Buffer.from(buffer.subarray(10))
      buffer = Buffer.alloc(0)
      socket.off('data', onData)
      resolve({ code, socket, rest })
    }
    socket.on('data', onData)
    socket.once('connect', () => socket.write(Buffer.from([5, 1, 0])))
    socket.once('error', reject)
  })
}

/**
 * 在一个端口上起监听，用于验证「端口是否已释放」。
 * @param {number} port 端口
 * @returns {Promise<{ok: boolean, error?: string}>} 是否可监听
 */
function tryListen(port) {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.once('error', (err) => resolve({ ok: false, error: err.code || err.message }))
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve({ ok: true })))
  })
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

async function main() {
  const echo = await startEchoService()
  resources.echo = echo
  console.log(`[信息] 本地回显服务已启动 127.0.0.1:${echo.port}`)
  const server = await startTestServer()
  resources.server = server
  console.log(`[信息] 测试 SSH 服务已启动 127.0.0.1:${SSH_PORT}`)

  const { ssh: sshModule, forward: forwardModule } = loadModules()
  const pool = new sshModule.SshConnectionPool()
  resources.pool = pool
  /** 规则状态变化事件，用于确认主进程是按事件推送而非轮询 */
  const events = []
  const manager = new forwardModule.ForwardManager(pool, (vo) => events.push({ ...vo }))
  const config = {
    connectionId: 'verify-forward',
    title: '转发验证目标',
    host: '127.0.0.1',
    port: SSH_PORT,
    username: 'tester',
    password: 'any'
  }

  // -------------------------------------------------------------------------
  // 1. local 转发：本地端口可连 + 双向数据
  // -------------------------------------------------------------------------
  const localRule = await manager.start(
    {
      type: 'local',
      localHost: '127.0.0.1',
      localPort: TUNNEL.local,
      remoteHost: '127.0.0.1',
      remotePort: echo.port
    },
    config
  )
  assert(localRule.status === 'running', `local 规则启动成功（status=${localRule.status}）`)
  assert(localRule.title.includes('本地转发'), `规则标题带中文类型（${localRule.title}）`)

  const tunnel = await connectTunnel(TUNNEL.local)
  const readTunnel = collect(tunnel)
  await waitFor(
    () => readTunnel().includes('TARGET-HELLO'),
    'local 转发：隧道连通并收到目标服务问候'
  )
  tunnel.write('PING-本地转发\n')
  await waitFor(
    () => readTunnel().includes('PING-本地转发'),
    'local 转发：本地 → 远端 → 目标 → 返回的双向数据完整（含中文）'
  )
  assert(echo.accepted() >= 1, `目标服务确实收到连接（累计 ${echo.accepted()} 次）`)

  await waitFor(
    () => events.some((vo) => vo.id === localRule.id && vo.connections >= 1),
    '建立隧道连接后 connections 计数被推送（面板据此判断隧道是否在工作）'
  )

  // -------------------------------------------------------------------------
  // 2. 端口被占用：给出可读中文错误，且不抛异常
  // -------------------------------------------------------------------------
  const blocker = net.createServer()
  await new Promise((resolve) => blocker.listen(TUNNEL.occupied, '127.0.0.1', resolve))
  const occupiedRule = await manager.start(
    {
      type: 'local',
      localHost: '127.0.0.1',
      localPort: TUNNEL.occupied,
      remoteHost: '127.0.0.1',
      remotePort: echo.port
    },
    config
  )
  assert(
    occupiedRule.status === 'error',
    `端口被占用时规则置为 error 而不是抛出异常（status=${occupiedRule.status}）`
  )
  assert(
    typeof occupiedRule.message === 'string' && occupiedRule.message.includes('端口已被占用'),
    `错误文案可读且指明原因（${occupiedRule.message}）`
  )
  await new Promise((resolve) => blocker.close(resolve))

  // 非法端口同样只回报错误
  const badPortRule = await manager.start(
    {
      type: 'local',
      localHost: '127.0.0.1',
      localPort: 0,
      remoteHost: '127.0.0.1',
      remotePort: echo.port
    },
    config
  )
  assert(
    badPortRule.status === 'error' && badPortRule.message.includes('1-65535'),
    `非法监听端口被拒绝并给出中文说明（${badPortRule.message}）`
  )

  // -------------------------------------------------------------------------
  // 3. stop 之后端口释放、已建立的隧道连接被销毁
  // -------------------------------------------------------------------------
  let tunnelClosed = false
  tunnel.once('close', () => {
    tunnelClosed = true
  })
  await manager.stop(localRule.id)
  const stopped = manager.list().find((vo) => vo.id === localRule.id)
  assert(stopped.status === 'stopped', 'stop 之后规则状态变为 stopped')
  await waitFor(() => tunnelClosed, 'stop 之后已建立的隧道连接被主动断开')
  await waitFor(
    async () => (await tryListen(TUNNEL.local)).ok,
    'stop 之后本地监听端口真实释放（可以重新绑定）',
    5000
  )

  // -------------------------------------------------------------------------
  // 4. dynamic 转发（SOCKS5）
  // -------------------------------------------------------------------------
  const dynamicRule = await manager.start(
    { type: 'dynamic', localHost: '127.0.0.1', localPort: TUNNEL.dynamic },
    config
  )
  assert(dynamicRule.status === 'running', `dynamic 规则启动成功（status=${dynamicRule.status}）`)

  const socksOk = await socksConnect(TUNNEL.dynamic, 'localhost', echo.port)
  assert(socksOk.code === 0, `SOCKS5 CONNECT 成功（应答码 ${socksOk.code}）`)
  const readSocks = collect(socksOk.socket, socksOk.rest)
  await waitFor(() => readSocks().includes('TARGET-HELLO'), 'SOCKS5 隧道收到目标服务问候')
  socksOk.socket.write('PING-动态转发\n')
  await waitFor(
    () => readSocks().includes('PING-动态转发'),
    'SOCKS5 隧道数据双向可达（本地 → SSH → 目标 → 返回）'
  )
  socksOk.socket.destroy()

  const socksFail = await socksConnect(TUNNEL.dynamic, '127.0.0.1', 15999)
  assert(
    socksFail.code === 1,
    `目标不可达时 SOCKS5 回复失败码而不是一直等待（应答码 ${socksFail.code}）`
  )
  socksFail.socket.destroy()
  const socksRuleAfterFail = manager.list().find((vo) => vo.id === dynamicRule.id)
  assert(
    socksRuleAfterFail.status === 'running',
    '单条 SOCKS5 连接失败不会把整条规则置为错误（隧道仍可用）'
  )

  await manager.stop(dynamicRule.id)
  await waitFor(
    async () => (await tryListen(TUNNEL.dynamic)).ok,
    'dynamic 规则 stop 后端口释放',
    5000
  )

  // -------------------------------------------------------------------------
  // 5. remote 转发：服务端监听 + 远端连接导到本地目标
  // -------------------------------------------------------------------------
  const remoteRule = await manager.start(
    {
      type: 'remote',
      localHost: '127.0.0.1',
      localPort: TUNNEL.remote,
      remoteHost: '127.0.0.1',
      remotePort: echo.port
    },
    config
  )
  assert(remoteRule.status === 'running', `remote 规则启动成功（status=${remoteRule.status}）`)
  await waitFor(
    () => sshObserved.forwards.includes(`127.0.0.1:${TUNNEL.remote}`),
    `服务端收到远端监听请求（${sshObserved.forwards.join('、')}）`
  )

  const serverClient = await waitForRemoteClient()
  const channel = await new Promise((resolve, reject) => {
    // forwarded-tcpip 通道：模拟「远端有用户连到了服务端监听的端口」
    serverClient.forwardOut('127.0.0.1', TUNNEL.remote, '10.0.0.9', 55000, (err, stream) =>
      err ? reject(err) : resolve(stream)
    )
  })
  const readChannel = collect(channel)
  await waitFor(() => readChannel().includes('TARGET-HELLO'), 'remote 转发：远端连接被导到本机目标')
  channel.write('PING-远端回连\n')
  await waitFor(
    () => readChannel().includes('PING-远端回连'),
    'remote 转发：远端 → 本机目标 → 返回的数据双向完整（含中文）'
  )
  channel.end()

  await manager.stop(remoteRule.id)
  await waitFor(
    () => sshObserved.cancels.includes(`127.0.0.1:${TUNNEL.remote}`),
    'remote 规则 stop 后撤销了远端监听（服务端收到 cancel-tcpip-forward）'
  )

  // -------------------------------------------------------------------------
  // 6. 目标端口未开放：隧道保持可用，只记录最后一次失败原因
  // -------------------------------------------------------------------------
  const badTargetRule = await manager.start(
    {
      type: 'local',
      localHost: '127.0.0.1',
      localPort: TUNNEL.badTarget,
      remoteHost: '127.0.0.1',
      remotePort: 15998
    },
    config
  )
  assert(badTargetRule.status === 'running', '目标端口未开放不影响隧道本身启动')
  const deadTunnel = await connectTunnel(TUNNEL.badTarget)
  await waitFor(() => {
    const vo = manager.list().find((item) => item.id === badTargetRule.id)
    return Boolean(
      vo && vo.status === 'running' && typeof vo.message === 'string' && vo.message.length > 0
    )
  }, '单条连接失败只更新 message，规则保持运行中')
  const badTargetMessage = manager.list().find((item) => item.id === badTargetRule.id).message
  assert(/[\u4e00-\u9fff]/.test(badTargetMessage), `失败原因已中文化（${badTargetMessage}）`)
  deadTunnel.destroy()
  await manager.stop(badTargetRule.id)

  // -------------------------------------------------------------------------
  // 7. 全部规则停止后底层 SSH 连接被释放（引用计数归零）
  // -------------------------------------------------------------------------
  manager.dispose()
  await waitFor(() => sshObserved.active === 0, '全部规则停止后底层 SSH 连接被释放', 8000)
  assert(
    manager.list().every((vo) => vo.status === 'stopped' || vo.status === 'error'),
    'dispose 之后没有任何规则仍处于 running'
  )

  server.close()
  await echo.close()
  pool.dispose()
  fs.rmSync(BUILD_DIR, { recursive: true, force: true })
  fs.rmSync(DATA_DIR, { recursive: true, force: true })
  console.log(`\n[结果] 全部通过，共 ${passed} 项`)
}

main().catch((err) => {
  console.error(`\n[失败] ${err.message}`)
  if (err.stack) console.error(err.stack)
  // 失败路径也要释放监听端口与 SSH 连接，否则脚本会一直挂着不退出
  if (resources.echo) resources.echo.close().catch(() => undefined)
  if (resources.server) resources.server.close()
  if (resources.pool) resources.pool.dispose()
  setTimeout(() => process.exit(1), 300)
})
