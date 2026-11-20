/**
 * SFTP 功能验证脚本（不依赖 Electron GUI）。
 *
 * 做法：用 ssh2 自带的 Server 在 127.0.0.1 上实现一个内存文件系统的 SFTP 服务端，
 * 再把 src/main/ssh.ts 与 src/main/sftp.ts 用 TypeScript 编译器转成 CJS、
 * 把 electron 依赖换成桩实现（其中 dialog 返回脚本预设的路径），
 * 从而在真实 SSH 协议之上验证 SftpManager 的全部行为：
 *   1. 打开 SFTP 会话并能取到 home 目录
 *   2. 目录列表的类型判定（file / directory）与排序（目录在前）
 *   3. 新建目录、重命名（含目录搬迁）、删除文件与删除目录
 *   4. 上传与下载的内容完整性
 *   5. 终端与 SFTP 共享同一条底层连接，且引用计数正确（关掉一个通道不会影响另一个）
 */
const { Server, utils } = require('ssh2')
const fs = require('fs')
const Module = require('module')
const os = require('os')
const path = require('path')
const ts = require('typescript')

const SSH_PORT = 2222
const HOME = '/home'
/**
 * 编译产物必须放在项目内，否则 require('ssh2') 无法向上解析到项目的 node_modules
 */
const BUILD_DIR = path.join(__dirname, '..', '.verify-build')
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-sftp-data-'))

/** 需要统一清理的资源，断言失败时也要保证进程能退出 */
const resources = { server: null, pool: null }

let passed = 0

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

// ---------------------------------------------------------------------------
// 内存文件系统与 SFTP 服务端
// ---------------------------------------------------------------------------

/** 文件类型掩码常量 */
const S_IFDIR = 0o040000
const S_IFREG = 0o100000

/** SFTP 状态码，取自协议定义 */
const STATUS = { OK: 0, EOF: 1, NO_SUCH_FILE: 2, PERMISSION_DENIED: 3, FAILURE: 4 }

/** 内存文件系统：绝对路径 -> 节点 */
const memfs = new Map()

/**
 * 规范化远程路径。
 * @param {string} input 原始路径
 * @returns {string} 绝对路径
 */
function normalize(input) {
  const parts = []
  for (const segment of String(input).split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') parts.pop()
    else parts.push(segment)
  }
  return `/${parts.join('/')}`
}

/**
 * 列出某个目录的直接子项。
 * @param {string} dir 目录路径
 * @returns {Array<[string, object, string]>} 路径、节点、名称三元组
 */
function childrenOf(dir) {
  const prefix = dir === '/' ? '/' : `${dir}/`
  const result = []
  for (const [fullPath, node] of memfs) {
    if (fullPath === dir || !fullPath.startsWith(prefix)) continue
    const rest = fullPath.slice(prefix.length)
    // 只取直接子项，孙子项由下一级目录负责
    if (rest.includes('/')) continue
    result.push([fullPath, node, rest])
  }
  return result
}

/**
 * 构造节点属性。
 * @param {object} node 文件系统节点
 * @returns {object} SFTP attrs
 */
function attrsOf(node) {
  const now = Math.floor(Date.now() / 1000)
  return {
    mode: (node.type === 'dir' ? S_IFDIR : S_IFREG) | 0o644,
    size: node.type === 'file' ? node.content.length : 0,
    uid: 0,
    gid: 0,
    atime: now,
    mtime: now
  }
}

/** 预置一些用于测试的内容 */
memfs.set(HOME, { type: 'dir' })
memfs.set(`${HOME}/readme.txt`, { type: 'file', content: Buffer.from('hello sftp') })
memfs.set(`${HOME}/sub`, { type: 'dir' })

/**
 * 把 sftp 通道接到内存文件系统上。
 * @param {import('ssh2').SFTPWrapper} sftp 服务端 SFTP 通道
 */
function serveSftp(sftp) {
  /** 句柄表：数字 id -> 打开的上下文 */
  const handles = new Map()
  let nextHandleId = 1

  /**
   * 登记一个句柄。
   * @param {object} context 句柄上下文
   * @returns {Buffer} 4 字节句柄
   */
  const makeHandle = (context) => {
    const id = nextHandleId
    nextHandleId += 1
    handles.set(id, context)
    const buffer = Buffer.alloc(4)
    buffer.writeUInt32BE(id, 0)
    return buffer
  }

  /**
   * 取出句柄上下文。
   * @param {Buffer} buffer 句柄
   * @returns {object|undefined} 上下文
   */
  const getHandle = (buffer) => handles.get(buffer.readUInt32BE(0))

  /**
   * 回复 stat 类请求。
   * @param {number} reqid 请求 id
   * @param {string} target 目标路径
   */
  const replyStat = (reqid, target) => {
    const node = memfs.get(normalize(target))
    if (!node) return sftp.status(reqid, STATUS.NO_SUCH_FILE)
    sftp.attrs(reqid, attrsOf(node))
  }

  sftp.on('REALPATH', (reqid, givenPath) => {
    // 与真实服务端一致：'.' 解析为登录用户的 home 目录
    const resolved = !givenPath || givenPath === '.' ? HOME : normalize(givenPath)
    sftp.name(reqid, [
      {
        filename: resolved,
        longname: resolved,
        attrs: { mode: S_IFDIR | 0o755, size: 0, uid: 0, gid: 0, atime: 0, mtime: 0 }
      }
    ])
  })

  sftp.on('OPENDIR', (reqid, target) => {
    const node = memfs.get(normalize(target))
    if (!node) return sftp.status(reqid, STATUS.NO_SUCH_FILE)
    if (node.type !== 'dir') return sftp.status(reqid, STATUS.FAILURE)
    sftp.handle(reqid, makeHandle({ kind: 'dir', path: normalize(target), sent: false }))
  })

  sftp.on('READDIR', (reqid, handle) => {
    const context = getHandle(handle)
    if (!context || context.kind !== 'dir') return sftp.status(reqid, STATUS.FAILURE)
    // 目录内容一次性给出，之后按协议回复 EOF
    if (context.sent) return sftp.status(reqid, STATUS.EOF)
    context.sent = true

    sftp.name(
      reqid,
      childrenOf(context.path).map(([, node, name]) => ({
        filename: name,
        longname: `${node.type === 'dir' ? 'd' : '-'}rw-r--r-- 1 u u ${node.type === 'file' ? node.content.length : 0} Jan 1 00:00 ${name}`,
        attrs: attrsOf(node)
      }))
    )
  })

  sftp.on('OPEN', (reqid, filename, flags) => {
    const target = normalize(filename)
    const canWrite = (flags & 0x02) !== 0
    let node = memfs.get(target)
    if (!node && canWrite) {
      node = { type: 'file', content: Buffer.alloc(0) }
      memfs.set(target, node)
    }
    if (!node) return sftp.status(reqid, STATUS.NO_SUCH_FILE)
    if (node.type !== 'file') return sftp.status(reqid, STATUS.FAILURE)
    if (canWrite && (flags & 0x10) !== 0) node.content = Buffer.alloc(0)
    sftp.handle(reqid, makeHandle({ kind: 'file', path: target }))
  })

  sftp.on('READ', (reqid, handle, offset, length) => {
    const context = getHandle(handle)
    const node = context ? memfs.get(context.path) : undefined
    if (!node || node.type !== 'file') return sftp.status(reqid, STATUS.FAILURE)
    const chunk = node.content.subarray(offset, offset + length)
    if (chunk.length === 0) return sftp.status(reqid, STATUS.EOF)
    sftp.data(reqid, chunk)
  })

  sftp.on('WRITE', (reqid, handle, offset, data) => {
    const context = getHandle(handle)
    const node = context ? memfs.get(context.path) : undefined
    if (!node || node.type !== 'file') return sftp.status(reqid, STATUS.FAILURE)
    const needed = offset + data.length
    if (node.content.length < needed) {
      const grown = Buffer.alloc(needed)
      node.content.copy(grown)
      node.content = grown
    }
    data.copy(node.content, offset)
    sftp.status(reqid, STATUS.OK)
  })

  sftp.on('CLOSE', (reqid, handle) => {
    handles.delete(handle.readUInt32BE(0))
    sftp.status(reqid, STATUS.OK)
  })

  sftp.on('STAT', (reqid, target) => replyStat(reqid, target))
  sftp.on('LSTAT', (reqid, target) => replyStat(reqid, target))

  sftp.on('FSTAT', (reqid, handle) => {
    const context = getHandle(handle)
    const node = context ? memfs.get(context.path) : undefined
    if (!node) return sftp.status(reqid, STATUS.NO_SUCH_FILE)
    sftp.attrs(reqid, attrsOf(node))
  })

  sftp.on('MKDIR', (reqid, target) => {
    const full = normalize(target)
    if (memfs.has(full)) return sftp.status(reqid, STATUS.FAILURE)
    memfs.set(full, { type: 'dir' })
    sftp.status(reqid, STATUS.OK)
  })

  sftp.on('RMDIR', (reqid, target) => {
    const full = normalize(target)
    const node = memfs.get(full)
    if (!node || node.type !== 'dir') return sftp.status(reqid, STATUS.NO_SUCH_FILE)
    // 与真实服务端一致：非空目录拒绝删除，客户端据此给出「目录非空」的明确提示
    if (childrenOf(full).length > 0) return sftp.status(reqid, STATUS.FAILURE)
    memfs.delete(full)
    sftp.status(reqid, STATUS.OK)
  })

  sftp.on('REMOVE', (reqid, target) => {
    const full = normalize(target)
    const node = memfs.get(full)
    if (!node || node.type !== 'file') return sftp.status(reqid, STATUS.NO_SUCH_FILE)
    memfs.delete(full)
    sftp.status(reqid, STATUS.OK)
  })

  sftp.on('RENAME', (reqid, oldPath, newPath) => {
    const from = normalize(oldPath)
    const to = normalize(newPath)
    if (!memfs.has(from)) return sftp.status(reqid, STATUS.NO_SUCH_FILE)
    // 目录重命名必须连同子项一起搬迁，否则子项会变成孤儿节点
    for (const [fullPath, node] of [...memfs]) {
      if (fullPath === from || fullPath.startsWith(`${from}/`)) {
        memfs.delete(fullPath)
        memfs.set(to + fullPath.slice(from.length), node)
      }
    }
    sftp.status(reqid, STATUS.OK)
  })

  sftp.on('SETSTAT', (reqid) => sftp.status(reqid, STATUS.OK))
  sftp.on('FSETSTAT', (reqid) => sftp.status(reqid, STATUS.OK))
  sftp.on('EXTENDED', (reqid) => sftp.status(reqid, STATUS.FAILURE))
}

/** 服务端观测到的连接数 */
const connectionStats = { opened: 0, closed: 0, active: 0 }

/**
 * 启动测试 SFTP 服务端。
 * @returns {Promise<import('ssh2').Server>} 已监听的服务端
 */
function startServer() {
  const hostKey = utils.generateKeyPairSync('ed25519').private
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    connectionStats.opened += 1
    connectionStats.active += 1
    client.on('close', () => {
      connectionStats.closed += 1
      connectionStats.active -= 1
    })

    client.on('authentication', (ctx) => ctx.accept())
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept()
        session.on('pty', (acceptPty) => acceptPty())
        session.on('window-change', (acceptChange) => acceptChange && acceptChange())
        session.on('shell', (acceptShell) => {
          const stream = acceptShell()
          stream.write('shell-ready\r\n')
          stream.on('data', () => undefined)
        })
        session.on('sftp', (acceptSftp) => serveSftp(acceptSftp()))
      })
    })
  })

  return new Promise((resolve) => server.listen(SSH_PORT, '127.0.0.1', () => resolve(server)))
}

// ---------------------------------------------------------------------------
// 用 electron 桩加载编译后的主进程模块
// ---------------------------------------------------------------------------

/** dialog 桩的行为开关，由各用例设置 */
const dialogBehavior = { openPaths: [], savePath: null }

/**
 * 把主进程 TS 模块编译成临时目录下的 CJS。
 * 两个文件必须同名导入，因此分别输出为 ssh.js 与 sftp.js，保持 require('./ssh') 可解析。
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

/**
 * 注入 electron 桩后加载编译产物。
 * @returns {{ ssh: object, sftp: object }} 编译出来的模块
 */
function loadModules() {
  fs.rmSync(BUILD_DIR, { recursive: true, force: true })
  fs.mkdirSync(BUILD_DIR, { recursive: true })
  compileTo('ssh.ts', 'ssh.js')
  compileTo('sftp.ts', 'sftp.js')
  // 主进程模块用 @shared/errors 引用共享契约，单文件转译不会解析 tsconfig paths，这里一并编译并挂到 require 上
  compileTo('errors.ts', 'shared-errors.js', '../src/shared')
  // 主进程自己的错误翻译模块为可选文件，存在才编译
  if (fs.existsSync(path.resolve(__dirname, '../src/main/errors.ts'))) {
    compileTo('errors.ts', 'errors.js')
  }

  const electronStub = {
    app: { getPath: () => DATA_DIR },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (plain) => Buffer.from(plain, 'utf8'),
      decryptString: (buffer) => buffer.toString('utf8')
    },
    dialog: {
      showOpenDialog: async () => ({
        canceled: dialogBehavior.openPaths.length === 0,
        filePaths: dialogBehavior.openPaths
      }),
      showSaveDialog: async () => ({
        canceled: !dialogBehavior.savePath,
        filePath: dialogBehavior.savePath
      })
    }
  }

  const originalLoad = Module._load
  Module._load = function (request, ...rest) {
    if (request === 'electron') return electronStub
    // tsconfig 里的 @shared/* 别名在真实构建中由 electron-vite 解析，单文件转译时需要手工指路
    if (request === '@shared/errors') return require(path.join(BUILD_DIR, 'shared-errors.js'))
    if (request === './errors') return require(path.join(BUILD_DIR, 'errors.js'))
    return originalLoad.call(this, request, ...rest)
  }
  try {
    return {
      ssh: require(path.join(BUILD_DIR, 'ssh.js')),
      sftp: require(path.join(BUILD_DIR, 'sftp.js'))
    }
  } finally {
    Module._load = originalLoad
  }
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

/**
 * @param {number} ms 毫秒
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main() {
  const server = await startServer()
  console.log(`[信息] 内存 SFTP 服务端已启动 127.0.0.1:${SSH_PORT}`)

  const { ssh, sftp: sftpModule } = loadModules()
  const pool = new ssh.SshConnectionPool()
  const terminal = new ssh.SshSessionManager(
    pool,
    () => undefined,
    () => undefined
  )
  const manager = new sftpModule.SftpManager(pool)
  resources.server = server
  resources.pool = pool

  const config = {
    connectionId: 'verify-target',
    title: '验证目标',
    host: '127.0.0.1',
    port: SSH_PORT,
    username: 'tester',
    password: 'any'
  }

  // 1. 打开 SFTP 会话
  const session = await manager.open(config)
  assert(typeof session.sftpId === 'string' && session.sftpId.length > 0, 'SFTP 会话打开成功')
  assert(session.home === HOME, `初始目录解析为 home（${session.home}）`)

  // 2. 目录列表与排序：目录在前，文件在后
  const entries = await manager.list(session.sftpId, HOME)
  assert(entries.length === 2, `目录列表返回 2 项（实际 ${entries.length}）`)
  assert(
    entries[0].name === 'sub' && entries[0].type === 'directory',
    '目录项类型判定为 directory 且排在文件之前'
  )
  assert(entries[1].name === 'readme.txt' && entries[1].type === 'file', '普通文件类型判定为 file')
  assert(entries[1].size === 'hello sftp'.length, '文件大小与内容长度一致')
  assert(entries[1].path === `${HOME}/readme.txt`, '目录项返回绝对路径')

  // 3. 新建目录
  await manager.mkdir(session.sftpId, `${HOME}/newdir`)
  assert(
    (await manager.list(session.sftpId, HOME)).some((item) => item.name === 'newdir'),
    '新建目录后立刻可见'
  )

  // 4. 重命名目录
  await manager.rename(session.sftpId, `${HOME}/newdir`, `${HOME}/renamed`)
  const afterRename = await manager.list(session.sftpId, HOME)
  assert(
    afterRename.some((item) => item.name === 'renamed') &&
      !afterRename.some((item) => item.name === 'newdir'),
    '重命名目录生效'
  )

  // 5. 上传：dialog 桩返回本地临时文件，内容需完整落到远端
  const uploadSource = path.join(DATA_DIR, 'upload-me.txt')
  fs.writeFileSync(uploadSource, 'uploaded-content-中文', 'utf8')
  dialogBehavior.openPaths = [uploadSource]
  const uploaded = await manager.upload(session.sftpId, HOME)
  assert(uploaded.length === 1 && uploaded[0] === 'upload-me.txt', '上传返回文件名')
  assert(
    memfs.get(`${HOME}/upload-me.txt`)?.content.toString('utf8') === 'uploaded-content-中文',
    '上传内容完整且中文无乱码'
  )
  // 服务端强制关闭与客户端缓存无关，这里直接校验远端内存文件系统
  assert(
    (await manager.list(session.sftpId, HOME)).some((item) => item.name === 'upload-me.txt'),
    '上传后列表中可见新文件'
  )

  // 6. 下载：dialog 桩返回本地保存路径，内容需与远端一致
  const downloadTarget = path.join(DATA_DIR, 'downloaded.txt')
  dialogBehavior.savePath = downloadTarget
  const done = await manager.download(session.sftpId, `${HOME}/readme.txt`)
  assert(done === true, '下载返回完成状态')
  assert(fs.readFileSync(downloadTarget, 'utf8') === 'hello sftp', '下载内容与远端文件一致')

  // 7. 删除文件
  await manager.remove(session.sftpId, `${HOME}/readme.txt`)
  assert(
    !(await manager.list(session.sftpId, HOME)).some((item) => item.name === 'readme.txt'),
    '删除文件生效'
  )

  // 8. 删除目录（主进程按 stat 结果选择 rmdir）
  await manager.remove(session.sftpId, `${HOME}/renamed`)
  assert(
    !(await manager.list(session.sftpId, HOME)).some((item) => item.name === 'renamed'),
    '删除目录生效'
  )

  // 9. 终端与 SFTP 共享连接：两个通道并存时只应建立一条 SSH 连接
  const terminalSession = await terminal.open(config, 80, 24)
  assert(
    connectionStats.opened === 1,
    `终端与 SFTP 复用同一条 SSH 连接（累计建连 ${connectionStats.opened} 次）`
  )

  // 关掉 SFTP 后终端必须仍然可用，这是引用计数最容易写错的地方
  manager.close(session.sftpId)
  await sleep(200)
  assert(connectionStats.active === 1, '关闭 SFTP 后底层连接仍然存活')
  terminal.write(terminalSession.sessionId, 'ping\n')
  await sleep(200)
  assert(connectionStats.closed === 0, '关闭 SFTP 后终端通道未被连带关闭')

  // 10. 关闭最后一个通道后连接才断开
  terminal.close(terminalSession.sessionId, '用例结束')
  await sleep(400)
  assert(connectionStats.active === 0, '全部通道关闭后底层连接被释放')

  // 11. 会话失效后给出明确错误
  let errorMessage = ''
  try {
    await manager.list(session.sftpId, HOME)
  } catch (err) {
    errorMessage = err.message
  }
  assert(errorMessage.includes('SFTP 会话已关闭'), `会话失效后报错可读（${errorMessage}）`)

  // 12. 拖拽上传入参 uploadPaths 与 fastPut 进度上报
  const progressRecords = []
  const progressManager = new sftpModule.SftpManager(pool, (vo) => progressRecords.push(vo))
  const progressSession = await progressManager.open(config)
  assert(typeof progressSession.sftpId === 'string', '带进度回调的 SFTP 会话打开成功')

  const bigSource = path.join(DATA_DIR, 'big-upload.bin')
  const bigContent = Buffer.alloc(300 * 1024)
  for (let i = 0; i < bigContent.length; i += 1) bigContent[i] = i % 251
  fs.writeFileSync(bigSource, bigContent)
  const uploadedNames = await progressManager.uploadPaths({
    sftpId: progressSession.sftpId,
    remoteDir: HOME,
    localPaths: [bigSource]
  })
  assert(
    uploadedNames.length === 1 && uploadedNames[0] === 'big-upload.bin',
    'uploadPaths 返回上传文件名（拖拽上传底层入口）'
  )
  const remoteBig = memfs.get(`${HOME}/big-upload.bin`)
  assert(
    remoteBig != null &&
      remoteBig.content.length === bigContent.length &&
      remoteBig.content.equals(bigContent),
    'uploadPaths 上传内容与本地文件逐字节一致（300KB）'
  )
  const uploadSteps = progressRecords.filter((vo) => vo.direction === 'upload')
  assert(
    uploadSteps.some((vo) => !vo.done && vo.transferred > 0),
    `上传过程上报了非零进度（共 ${uploadSteps.length} 条）`
  )
  const uploadDone = uploadSteps.find((vo) => vo.done)
  assert(
    uploadDone != null && uploadDone.name === 'big-upload.bin' && uploadDone.total === bigContent.length,
    `上传完成事件带文件名与总大小（total=${uploadDone?.total}）`
  )

  // 13. 下载进度上报（fastGet step）
  const bigDownloadTarget = path.join(DATA_DIR, 'big-download.bin')
  dialogBehavior.savePath = bigDownloadTarget
  const downloadDone = await progressManager.download(
    progressSession.sftpId,
    `${HOME}/big-upload.bin`
  )
  assert(downloadDone === true, '下载返回完成状态')
  assert(
    fs.readFileSync(bigDownloadTarget).equals(bigContent),
    '下载内容与远端文件逐字节一致（300KB）'
  )
  const downloadSteps = progressRecords.filter((vo) => vo.direction === 'download')
  assert(
    downloadSteps.some((vo) => !vo.done && vo.transferred > 0) &&
      downloadSteps.some((vo) => vo.done),
    `下载过程上报了进度与完成事件（共 ${downloadSteps.length} 条）`
  )

  // 14. 删除非空目录时给出明确中文提示
  await progressManager.mkdir(progressSession.sftpId, `${HOME}/notempty`)
  await progressManager.uploadPaths({
    sftpId: progressSession.sftpId,
    remoteDir: `${HOME}/notempty`,
    localPaths: [bigSource]
  })
  let notEmptyMessage = ''
  try {
    await progressManager.remove(progressSession.sftpId, `${HOME}/notempty`)
  } catch (err) {
    notEmptyMessage = err.message
  }
  assert(
    notEmptyMessage.includes('目录非空'),
    `删除非空目录时给出明确中文提示（${notEmptyMessage || '未报错'}）`
  )

  progressManager.close(progressSession.sftpId)
  await sleep(300)
  assert(connectionStats.active === 0, '关闭带进度的会话后底层连接被释放')

  server.close()
  console.log(`\n[结果] 全部通过，共 ${passed} 项`)
}

main()
  .catch((err) => {
    console.error(`\n[失败] ${err.message}`)
    process.exitCode = 1
  })
  .finally(() => {
    // 断言失败时连接可能仍开着，统一兜底清理，避免脚本挂住不退出
    try {
      resources.pool?.dispose()
    } catch {
      // 清理失败不影响结论
    }
    try {
      resources.server?.close()
    } catch {
      // 同上
    }
    fs.rmSync(BUILD_DIR, { recursive: true, force: true })
    fs.rmSync(DATA_DIR, { recursive: true, force: true })
    // 仍有残留句柄时强制退出
    setTimeout(() => process.exit(process.exitCode ?? 0), 300)
  })
