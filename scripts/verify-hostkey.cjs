/**
 * 主机密钥校验验证脚本（不依赖 Electron GUI）。
 *
 * 做法与 verify-sftp.cjs 一致：用 TypeScript 编译器把 src/main/ssh.ts 转成 CJS，
 * 把 electron 依赖替换成桩（app.getPath 指向临时数据目录，从而隔离 known_hosts.json），
 * 再用 ssh2 自带的 Server 在 127.0.0.1:2222 起一个真实 SSH 服务端，
 * 从真实握手流程上验证以下行为：
 *   1. 首次连接按 TOFU 记录指纹并信任，known_hosts.json 落盘
 *   2. 服务端换成另一把主机密钥后连接被拒绝，错误可被 parseHostKeyChanged 还原，
 *      且新旧指纹与两次服务端密钥的真实 SHA256 指纹一致（并与 ssh-keygen 交叉核对）
 *   3. 未确认前反复重连始终失败，且 known_hosts.json 不会被静默改写
 *   4. 调用 trustPendingHostKey 后重连成功，known_hosts.json 更新为新指纹
 *
 * 数据目录为临时目录，脚本结束即删除，不影响真实用户配置。
 */
const { Server, utils } = require('ssh2')
const { spawnSync } = require('child_process')
const { createHash } = require('crypto')
const fs = require('fs')
const Module = require('module')
const os = require('os')
const path = require('path')
const ts = require('typescript')

const HOST = '127.0.0.1'
const SSH_PORT = 2222
const TARGET = `${HOST}:${SSH_PORT}`
/** 编译产物放在项目内，否则 require('ssh2') 无法向上解析到项目的 node_modules */
const BUILD_DIR = path.join(__dirname, '..', '.verify-build-hostkey')
/** 临时 userData 目录：known_hosts.json 落在其中 */
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-hostkey-data-'))

/** 需要统一清理的资源，断言失败时也要保证进程能退出 */
const resources = { server: null, pool: null, pool2: null }

let passed = 0
/** 非致命发现：行为可用但偏离直觉或有安全含义，记入报告由实现者判断 */
const findings = []

/**
 * 断言条件成立。
 * @param {boolean} condition 条件
 * @param {string} message 描述
 */
function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`)
  passed += 1
  console.log(`[通过] ${message}`)
}

/**
 * 记录一条通过的检查项（用于「必须不发生某事」的分支，断言语义由调用处给出）。
 * @param {string} message 描述
 */
function pass(message) {
  passed += 1
  console.log(`[通过] ${message}`)
}

/**
 * 记录一条非致命发现。
 * @param {string} message 描述
 */
function observe(message) {
  findings.push(message)
  console.log(`[发现] ${message}`)
}

/**
 * @param {number} ms 毫秒
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 计算 OpenSSH 风格的 SHA256 指纹。
 * @param {Buffer} keyBlob SSH 公钥在线格式（算法名 + 密钥数据）
 * @returns {string} 形如 SHA256:xxxx 的指纹（去掉 base64 补位等号）
 */
function fingerprintOf(keyBlob) {
  return `SHA256:${createHash('sha256').update(keyBlob).digest('base64').replace(/=+$/, '')}`
}

/**
 * 取出私钥对应的公钥 blob（与服务端在握手中实际发送、客户端 hostVerifier 收到的字节完全一致）。
 * @param {string} privateKey 私钥文本
 * @returns {Buffer} 公钥 blob
 */
function publicBlobOf(privateKey) {
  const parsed = utils.parseKey(privateKey)
  if (parsed instanceof Error) throw new Error(`解析密钥失败：${parsed.message}`)
  return parsed.getPublicSSH()
}

/**
 * 用系统 ssh-keygen 独立核对指纹，与脚本自己算的 SHA256 交叉验证。
 * ssh-keygen 不存在时跳过，不算失败。
 * @param {string} publicKeyLine ssh-ed25519 AAAA... 形式的公钥行
 * @param {string} expected 脚本算出的指纹
 * @param {string} label 用途描述
 */
function crossCheckWithSshKeygen(publicKeyLine, expected, label) {
  const file = path.join(DATA_DIR, `crosscheck-${label}.pub`)
  fs.writeFileSync(file, `${publicKeyLine}\n`, 'utf8')
  const result = spawnSync('ssh-keygen', ['-lf', file, '-E', 'sha256'], { encoding: 'utf8' })
  if (result.error || result.status !== 0) {
    observe(`ssh-keygen 不可用，跳过 ${label} 的指纹交叉核对（${result.error?.message || result.stderr}）`)
    return
  }
  const matched = /(SHA256:[A-Za-z0-9+/]+)/.exec(result.stdout)
  assert(
    matched !== null && matched[1] === expected,
    `${label} 指纹与 ssh-keygen 独立计算结果一致（${expected}）`
  )
  console.log(`[证据] ssh-keygen 输出：${result.stdout.trim()}`)
}

// ---------------------------------------------------------------------------
// 测试用 SSH 服务端：接受任意凭据，提供 shell 通道
// ---------------------------------------------------------------------------

/**
 * 启动一个只做主机密钥校验所需的最小 SSH 服务端。
 * @param {string} privateKey 服务端主机私钥
 * @returns {Promise<import('ssh2').Server>} 已监听的服务端
 */
function startServer(privateKey) {
  const server = new Server({ hostKeys: [privateKey] }, (client) => {
    // 客户端在握手阶段拒绝主机密钥并断开时，服务端会抛 KEY_EXCHANGE_FAILED；
    // 没有 error 监听会让 Node 以未处理错误直接退出
    client.on('error', () => undefined)
    client.on('authentication', (ctx) => ctx.accept())
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept()
        session.on('pty', (acceptPty) => acceptPty())
        session.on('shell', (acceptShell) => {
          const stream = acceptShell()
          stream.write('hostkey-verify-ready\r\n')
          stream.on('data', (chunk) => stream.write(chunk))
        })
      })
    })
  })

  // 端口刚释放时可能短暂占用，重试几次避免偶发失败掩盖真实结论
  return new Promise((resolve, reject) => {
    let attempts = 0
    const tryListen = () => {
      attempts += 1
      const onListenError = (err) => {
        if (attempts < 10 && err.code === 'EADDRINUSE') {
          setTimeout(tryListen, 200)
          return
        }
        reject(err)
      }
      server.once('error', onListenError)
      server.listen(SSH_PORT, HOST, () => {
        server.off('error', onListenError)
        // 监听成功后的连接级错误已在连接回调里吞掉，这里再兜一层
        server.on('error', () => undefined)
        resolve(server)
      })
    }
    tryListen()
  })
}

/**
 * 关闭服务端并等待端口释放。
 * @param {import('ssh2').Server|null} server 服务端
 * @returns {Promise<void>}
 */
function closeServer(server) {
  return new Promise((resolve) => {
    if (!server) return resolve()
    server.close(() => resolve())
  })
}

// ---------------------------------------------------------------------------
// 用 electron 桩加载编译后的主进程模块
// ---------------------------------------------------------------------------

/**
 * 把 TS 源码编译成临时目录下的 CJS。
 * @param {string} fileName 源文件名
 * @param {string} outName 输出文件名
 * @param {string} sourceDir 源文件所在目录，默认为主进程目录
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

/** electron 桩：ssh.ts 只用到 app.getPath，其余按需补齐以免后续改动直接崩 */
const electronStub = {
  app: { getPath: () => DATA_DIR },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.from(plain, 'utf8'),
    decryptString: (buffer) => buffer.toString('utf8')
  },
  clipboard: { readText: () => '', writeText: () => undefined },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => undefined, on: () => undefined }
}

/**
 * 编译主进程模块并返回 require 入口。
 * @returns {string} ssh.js 的绝对路径
 */
function build() {
  fs.rmSync(BUILD_DIR, { recursive: true, force: true })
  fs.mkdirSync(BUILD_DIR, { recursive: true })
  compileTo('ssh.ts', 'ssh.js')
  // 主进程用 @shared/errors 引用共享契约，单文件转译不会解析 tsconfig paths，这里一并编译并挂到 require 上
  compileTo('errors.ts', 'shared-errors.js', '../src/shared')
  if (fs.existsSync(path.resolve(__dirname, '../src/main/errors.ts'))) {
    compileTo('errors.ts', 'errors.js')
  }
  return path.join(BUILD_DIR, 'ssh.js')
}

/**
 * 注入 electron 桩后加载编译产物。
 * 每次都清掉 require 缓存，保证拿到全新的模块级状态（known_hosts 缓存与待确认表）。
 * @param {string} entry ssh.js 路径
 * @returns {object} 编译出来的 ssh 模块
 */
function loadSshModule(entry) {
  const originalLoad = Module._load
  Module._load = function (request, ...rest) {
    if (request === 'electron') return electronStub
    if (request === '@shared/errors') return require(path.join(BUILD_DIR, 'shared-errors.js'))
    if (request === './errors') return require(path.join(BUILD_DIR, 'errors.js'))
    return originalLoad.call(this, request, ...rest)
  }
  try {
    delete require.cache[entry]
    return require(entry)
  } finally {
    Module._load = originalLoad
  }
}

// ---------------------------------------------------------------------------
// 断言用的辅助函数
// ---------------------------------------------------------------------------

/**
 * 读取 known_hosts.json。
 * @returns {Record<string, string>} host:port 到指纹的映射
 */
function readKnownHosts() {
  const file = path.join(DATA_DIR, 'known_hosts.json')
  if (!fs.existsSync(file)) return {}
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/**
 * 发起一次连接，成功则立刻释放引用。
 * @param {object} pool 连接池
 * @param {string} tag 连接复用键后缀，保证每次都新建 TCP 连接
 * @returns {Promise<Error|null>} 成功返回 null，失败返回异常
 */
async function connectOnce(pool, tag) {
  const config = {
    connectionId: `verify-hostkey-${tag}`,
    title: '验证目标',
    host: HOST,
    port: SSH_PORT,
    username: 'tester',
    password: 'any'
  }
  try {
    await pool.acquire(config)
    pool.release(config.connectionId)
    return null
  } catch (err) {
    return err
  }
}

async function main() {
  console.log(`[信息] 临时数据目录：${DATA_DIR}`)

  // 两把完全不同的主机密钥，分别充当“首次信任”与“变更后”的服务端身份
  const keyA = utils.generateKeyPairSync('ed25519')
  const keyB = utils.generateKeyPairSync('ed25519')
  const blobA = publicBlobOf(keyA.private)
  const blobB = publicBlobOf(keyB.private)
  const fpA = fingerprintOf(blobA)
  const fpB = fingerprintOf(blobB)
  assert(blobA.length > 0 && blobB.length > 0, '两把测试主机密钥解析成功，可取出公钥 blob')
  assert(fpA !== fpB, `两把主机密钥指纹不同（A=${fpA} B=${fpB}）`)
  crossCheckWithSshKeygen(keyA.public, fpA, 'A')
  crossCheckWithSshKeygen(keyB.public, fpB, 'B')

  const entry = build()
  const ssh = loadSshModule(entry)
  const { parseHostKeyChanged, HOST_KEY_CHANGED_PREFIX } = require(path.join(
    BUILD_DIR,
    'shared-errors.js'
  ))
  const pool = new ssh.SshConnectionPool()
  resources.pool = pool

  // -------------------------------------------------------------------------
  // 用例 a：首次连接 TOFU 自动信任并落盘
  // -------------------------------------------------------------------------
  resources.server = await startServer(keyA.private)
  console.log(`[信息] 测试 SSH 服务端已启动（主机密钥 A）${TARGET}`)

  const errA = await connectOnce(pool, 'a')
  assert(errA === null, `首次连接成功（TOFU 自动信任），${TARGET}`)
  const tableAfterFirst = readKnownHosts()
  assert(
    tableAfterFirst[TARGET] === fpA,
    `首次连接后 known_hosts.json 记录 A 的真实指纹（实际 ${tableAfterFirst[TARGET]}）`
  )
  assert(
    fs.existsSync(path.join(DATA_DIR, 'known_hosts.json')),
    'known_hosts.json 已落盘到 userData 目录'
  )
  assert(
    fs.readdirSync(DATA_DIR).every((name) => !name.endsWith('.tmp')),
    '落盘未残留 .tmp 临时文件（临时文件加改名保证原子性）'
  )

  // -------------------------------------------------------------------------
  // 用例 b：服务端换成另一把主机密钥后连接失败，错误可还原且指纹正确
  // -------------------------------------------------------------------------
  await closeServer(resources.server)
  resources.server = await startServer(keyB.private)
  console.log('[信息] 服务端已重启并更换主机密钥（主机密钥 B）')

  const errB = await connectOnce(pool, 'b')
  assert(errB !== null, '更换主机密钥后连接被拒绝')
  assert(
    typeof errB.message === 'string' && errB.message.includes(HOST_KEY_CHANGED_PREFIX),
    `错误信息带主机密钥变更标记（${String(errB.message).slice(0, 80)}…）`
  )
  const change = parseHostKeyChanged(errB.message)
  assert(change !== null, 'parseHostKeyChanged 能从错误信息中还原结构化详情')
  assert(
    change && change.host === HOST && change.port === SSH_PORT,
    `还原出的目标是 ${HOST}:${SSH_PORT}（实际 ${change?.host}:${change?.port}）`
  )
  assert(
    change && change.oldFingerprint === fpA,
    `还原出的旧指纹等于服务端密钥 A 的真实 SHA256（${change?.oldFingerprint}）`
  )
  assert(
    change && change.newFingerprint === fpB,
    `还原出的新指纹等于服务端密钥 B 的真实 SHA256（${change?.newFingerprint}）`
  )

  // -------------------------------------------------------------------------
  // 用例 d：未确认前反复重连始终失败，且不会静默信任新密钥
  // -------------------------------------------------------------------------
  const errB2 = await connectOnce(pool, 'b2')
  const change2 = errB2 ? parseHostKeyChanged(errB2.message) : null
  assert(errB2 !== null, '未确认前第二次重连仍然失败')
  assert(
    change2 !== null && change2.newFingerprint === fpB,
    '第二次失败仍能被识别为主机密钥变更错误'
  )
  assert(
    readKnownHosts()[TARGET] === fpA,
    '未确认前 known_hosts.json 仍保存旧指纹，没有静默信任新密钥'
  )

  // -------------------------------------------------------------------------
  // 用例 e：待确认记录存在期间，与主机密钥无关的失败不得被误判
  // （task-7 修复项：服务端下线必须给中文 ECONNREFUSED，而不是「主机密钥已变更」）
  // -------------------------------------------------------------------------
  await closeServer(resources.server)
  resources.server = null
  const errOffline = await connectOnce(pool, 'offline')
  assert(errOffline !== null, '服务端未监听时连接失败')
  assert(
    parseHostKeyChanged(errOffline.message) === null,
    `服务端未监听时未被误判为主机密钥变更（实际信息：${String(errOffline.message).slice(0, 90)}）`
  )
  assert(
    String(errOffline.message).includes('目标端口未开放') &&
      String(errOffline.message).includes('ECONNREFUSED'),
    `服务端未监听时给出中文原因并保留原始错误码（${String(errOffline.message)}）`
  )
  resources.server = await startServer(keyB.private)

  // 服务端恢复后，待确认记录仍在，此时必须重新给出可解析的「主机密钥已变更」
  const errB3 = await connectOnce(pool, 'b3')
  const change3 = errB3 ? parseHostKeyChanged(errB3.message) : null
  assert(
    change3 !== null && change3.oldFingerprint === fpA && change3.newFingerprint === fpB,
    '服务端恢复后待确认记录仍能触发可解析的主机密钥变更错误'
  )

  // -------------------------------------------------------------------------
  // 用例 c：确认信任后重连成功，known_hosts.json 更新为新指纹
  // -------------------------------------------------------------------------
  ssh.trustPendingHostKey(HOST, SSH_PORT)
  assert(
    readKnownHosts()[TARGET] === fpB,
    `信任新指纹后 known_hosts.json 更新为 B 的真实指纹（实际 ${readKnownHosts()[TARGET]}）`
  )
  const errAfterTrust = await connectOnce(pool, 'c')
  assert(errAfterTrust === null, '信任新指纹后重连成功')
  assert(
    fs.readdirSync(DATA_DIR).every((name) => !name.endsWith('.tmp')),
    '更新指纹同样未残留临时文件'
  )
  // 重复调用必须安全：没有待确认记录时不做任何事
  ssh.trustPendingHostKey(HOST, SSH_PORT)
  assert(readKnownHosts()[TARGET] === fpB, '重复调用 trustPendingHostKey 不会破坏已保存的指纹')

  // -------------------------------------------------------------------------
  // 附加：错误编码在 Electron 包装后仍可还原，普通错误不会误判
  // -------------------------------------------------------------------------
  const wrapped = `Error invoking remote method 'terminal:open': Error: ${errB.message}`
  const parsedWrapped = parseHostKeyChanged(wrapped)
  assert(
    parsedWrapped !== null && parsedWrapped.newFingerprint === fpB,
    '经 ipcRenderer.invoke 包装后的错误信息仍能还原主机密钥变更详情'
  )
  assert(
    parseHostKeyChanged(`连接 ${TARGET} 失败：连接被拒绝`) === null,
    '普通连接错误不会被误判为主机密钥变更'
  )
  assert(
    parseHostKeyChanged(`${HOST_KEY_CHANGED_PREFIX}{ 截断的JSON`) === null,
    '被截断的编码信息按普通错误处理，不抛异常'
  )

  // -------------------------------------------------------------------------
  // 附加：known_hosts.json 损坏时的行为（用全新模块实例，避免命中进程内缓存）
  // 产品决策（lead 确认）：改名 .bak 保留现场 + console.warn + 重建空表后继续 TOFU，不做 fail-closed
  // -------------------------------------------------------------------------
  const brokenContent = '{ 这不是合法 JSON'
  fs.writeFileSync(path.join(DATA_DIR, 'known_hosts.json'), brokenContent, 'utf8')
  const freshSsh = loadSshModule(entry)
  const freshPool = new freshSsh.SshConnectionPool()
  resources.pool2 = freshPool
  const errCorrupt = await connectOnce(freshPool, 'corrupt')
  assert(errCorrupt === null, 'known_hosts.json 损坏后连接仍可建立（重建空表并重新 TOFU）')
  assert(
    fs.existsSync(`${path.join(DATA_DIR, 'known_hosts.json')}.bak`) &&
      fs.readFileSync(`${path.join(DATA_DIR, 'known_hosts.json')}.bak`, 'utf8') === brokenContent,
    '损坏的记录表已改名为 .bak 并完整保留现场'
  )
  assert(
    readKnownHosts()[TARGET] === fpB,
    '重建后的记录表重新记录了本次握手指纹（TOFU 继续可用）'
  )

  console.log(`\n[结果] 断言通过 ${passed} 项，非致命发现 ${findings.length} 项`)
  findings.forEach((item, index) => console.log(`[发现 ${index + 1}] ${item}`))
}

main()
  .catch((err) => {
    console.error(`\n[失败] ${err.message}`)
    process.exitCode = 1
  })
  .finally(async () => {
    // 断言失败时连接可能仍开着，统一兜底清理，避免脚本挂住不退出
    for (const pool of [resources.pool, resources.pool2]) {
      try {
        pool?.dispose()
      } catch {
        // 清理失败不影响结论
      }
    }
    await closeServer(resources.server)
    await sleep(200)
    fs.rmSync(BUILD_DIR, { recursive: true, force: true })
    fs.rmSync(DATA_DIR, { recursive: true, force: true })
    setTimeout(() => process.exit(process.exitCode ?? 0), 200)
  })
