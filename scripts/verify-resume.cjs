/**
 * SFTP 断点续传验证脚本（不启动 Electron，可直接用 node 运行）。
 *
 * 目的：断点续传是本轮新增的能力，而它最典型的失效方式是「看起来传完了，内容却坏了」，
 * 因此这里在内存 SFTP 服务端上做**故障注入**，用真实协议把 src/main/sftp.ts 的
 * SftpManager 跑一遍，验证：
 *   1. 上传中断后重试：从已确认写入的偏移继续，不重传已完成的字节，最终逐字节一致
 *   2. 上传中断前服务端只拿到「已确认」的前缀，不会出现空洞或错位
 *   3. 上传成功后断点记录被清除，下次上传从头开始（不会误续传旧偏移）
 *   4. 下载中断后重试：`.part` 已下载部分被复用，服务端读取偏移从断点开始，最终逐字节一致
 *   5. `.part` 已完整或比远端更大时判定为脏数据，按从头下载处理
 *   6. 多文件上传逐个进行、进度按文件顺序上报，range 单调不减
 *   7. 同名文件上传契约：断点吻合时直接续传（不进 conflicts）；断点已清除时缺省绝不覆盖
 *      （只返回 conflicts 且远端不变），显式 overwrite 才从头重传
 *
 * 说明：本脚本占用 127.0.0.1:2222 起一个内存 SFTP 服务，请与其它验证脚本串行执行。
 */
const { Server } = require('ssh2')
const fs = require('fs')
const Module = require('module')
const os = require('os')
const path = require('path')
const ts = require('typescript')
const crypto = require('crypto')
const { generateHostKey } = require('./host-key.cjs')

/** 测试 SSH 服务端口，与其它验证脚本保持一致 */
const SSH_PORT = 2222
/** 假想远端 home 目录 */
const HOME = '/home'
/** 编译产物目录 */
const BUILD_DIR = path.join(__dirname, '..', '.verify-build-resume')
/** 桩实现的数据目录 */
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-resume-data-'))
/** 本地临时文件目录 */
const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-resume-work-'))

/** 上传用例的故障注入点：偏移超过它的 WRITE 一律失败（模拟传输中断） */
const UPLOAD_FAULT_AT = 256 * 1024
/** 单个用例的兜底超时，避免流卡住导致脚本一直不退出 */
const CASE_TIMEOUT = 30000

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
 * 给 Promise 加超时兜底，避免被流卡住时脚本永久挂起。
 * @param {Promise<any>} promise 目标 Promise
 * @param {string} label 描述
 * @param {number} timeout 超时毫秒数
 * @returns {Promise<any>} 原结果
 */
function withTimeout(promise, label, timeout = CASE_TIMEOUT) {
  return Promise.race([
    promise,
    new Promise((_resolve, reject) =>
      setTimeout(() => reject(new Error(`用例超时（${timeout}ms）：${label}`)), timeout)
    )
  ])
}

// ---------------------------------------------------------------------------
// 内存 SFTP 服务端（含读偏移与写故障注入的观测）
// ---------------------------------------------------------------------------

/** SFTP 状态码 */
const STATUS = { OK: 0, EOF: 1, NO_SUCH_FILE: 2, PERMISSION_DENIED: 3, FAILURE: 4 }
const S_IFDIR = 0o040000
const S_IFREG = 0o100000

/** 内存文件系统：绝对路径 -> 节点 */
const memfs = new Map()
memfs.set('/', { type: 'dir' })
memfs.set(HOME, { type: 'dir' })

/** 服务端观测数据 */
const observed = {
  /** 读取请求的最小偏移，用于证明续传没有重新拉取前面的字节 */
  minReadOffset: Infinity,
  /** 本轮读取的字节数 */
  readBytes: 0,
  /** 本轮写入的字节数 */
  writtenBytes: 0,
  /** 被故障注入拒绝的写请求数 */
  rejectedWrites: 0
}

/** 故障注入开关：WRITE 偏移 >= writeRejectFrom 时直接失败 */
const fault = { writeRejectFrom: null }

/** 重置服务端观测数据 */
function resetObserved() {
  observed.minReadOffset = Infinity
  observed.readBytes = 0
  observed.writtenBytes = 0
  observed.rejectedWrites = 0
}

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

/**
 * 把 sftp 通道接到内存文件系统上，只实现断点续传用例需要的那部分协议。
 * @param {import('ssh2').SFTPWrapper} sftp 服务端 SFTP 通道
 */
function serveSftp(sftp) {
  const handles = new Map()
  let nextHandleId = 1

  /**
   * 登记句柄。
   * @param {object} context 句柄上下文
   * @returns {Buffer} 句柄字节
   */
  const makeHandle = (context) => {
    const buffer = Buffer.alloc(4)
    buffer.writeUInt32BE(nextHandleId, 0)
    handles.set(nextHandleId, context)
    nextHandleId += 1
    return buffer
  }

  /**
   * 取句柄上下文。
   * @param {Buffer} handle 句柄字节
   * @returns {object|undefined} 上下文
   */
  const getHandle = (handle) => handles.get(handle.readUInt32BE(0))

  sftp.on('REALPATH', (reqid, givenPath) => {
    const resolved = !givenPath || givenPath === '.' ? HOME : normalize(givenPath)
    sftp.name(reqid, [{ filename: resolved, longname: resolved, attrs: attrsOf({ type: 'dir' }) }])
  })

  sftp.on('OPENDIR', (reqid, dirPath) => {
    const dir = normalize(dirPath)
    const node = memfs.get(dir)
    if (!node || node.type !== 'dir') return sftp.status(reqid, STATUS.NO_SUCH_FILE)
    sftp.handle(reqid, makeHandle({ kind: 'dir', path: dir }))
  })

  sftp.on('READDIR', (reqid, handle) => {
    const context = getHandle(handle)
    if (!context) return sftp.status(reqid, STATUS.FAILURE)
    const prefix = context.path === '/' ? '/' : `${context.path}/`
    const names = ['.', '..']
    for (const fullPath of memfs.keys()) {
      if (fullPath === context.path || !fullPath.startsWith(prefix)) continue
      const rest = fullPath.slice(prefix.length)
      if (!rest || rest.includes('/')) continue
      names.push(rest)
    }
    sftp.name(
      reqid,
      names.map((name) => {
        const full = name === '.' ? context.path : name === '..' ? context.path : `${prefix}${name}`
        const node = memfs.get(full) ?? { type: 'dir' }
        return { filename: name, longname: name, attrs: attrsOf(node) }
      })
    )
  })

  sftp.on('OPEN', (reqid, filename, flags) => {
    const target = normalize(filename)
    const canWrite = (flags & 0x02) !== 0
    const truncate = (flags & 0x10) !== 0
    let node = memfs.get(target)
    if (!node && canWrite) {
      node = { type: 'file', content: Buffer.alloc(0) }
      memfs.set(target, node)
    }
    if (!node) return sftp.status(reqid, STATUS.NO_SUCH_FILE)
    if (node.type !== 'file') return sftp.status(reqid, STATUS.FAILURE)
    if (canWrite && truncate) node.content = Buffer.alloc(0)
    sftp.handle(reqid, makeHandle({ kind: 'file', path: target }))
  })

  sftp.on('READ', (reqid, handle, offset, length) => {
    const context = getHandle(handle)
    const node = context ? memfs.get(context.path) : undefined
    if (!node || node.type !== 'file') return sftp.status(reqid, STATUS.FAILURE)
    observed.minReadOffset = Math.min(observed.minReadOffset, offset)
    const chunk = node.content.subarray(offset, offset + length)
    if (chunk.length === 0) return sftp.status(reqid, STATUS.EOF)
    observed.readBytes += chunk.length
    sftp.data(reqid, chunk)
  })

  sftp.on('WRITE', (reqid, handle, offset, data) => {
    const context = getHandle(handle)
    const node = context ? memfs.get(context.path) : undefined
    if (!node || node.type !== 'file') return sftp.status(reqid, STATUS.FAILURE)
    // 故障注入：偏移超过阈值即拒绝，且不写入任何字节，保证远端内容始终是「已确认前缀」
    if (fault.writeRejectFrom !== null && offset >= fault.writeRejectFrom) {
      observed.rejectedWrites += 1
      return sftp.status(reqid, STATUS.FAILURE)
    }
    const needed = offset + data.length
    if (node.content.length < needed) {
      const grown = Buffer.alloc(needed)
      node.content.copy(grown)
      node.content = grown
    }
    data.copy(node.content, offset)
    observed.writtenBytes += data.length
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

  /**
   * 回应 stat 类请求。
   * @param {number} reqid 请求 id
   * @param {string} target 路径
   */
  function replyStat(reqid, target) {
    const node = memfs.get(normalize(target))
    if (!node) return sftp.status(reqid, STATUS.NO_SUCH_FILE)
    sftp.attrs(reqid, attrsOf(node))
  }

  // 备份用例（同名文件改名成「原名.日期」）需要改名能力；ssh2 服务端未注册的请求会回
  // OP_UNSUPPORTED，缺了这个处理器备份路径根本走不通
  sftp.on('RENAME', (reqid, oldPath, newPath) => {
    const from = normalize(oldPath)
    const to = normalize(newPath)
    if (!memfs.has(from)) return sftp.status(reqid, STATUS.NO_SUCH_FILE)
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

/**
 * 启动测试 SFTP 服务端。
 * @returns {Promise<import('ssh2').Server>} 已监听的服务端
 */
function startServer() {
  const hostKey = generateHostKey()
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
          stream.write('resume-test-shell\r\n')
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

/** dialog 桩行为 */
const dialogBehavior = { savePath: null }

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
 * @returns {{ ssh: object, sftp: object }} 编译出来的模块
 */
function loadModules() {
  fs.rmSync(BUILD_DIR, { recursive: true, force: true })
  fs.mkdirSync(BUILD_DIR, { recursive: true })
  compileTo('ssh.ts', 'ssh.js')
  compileTo('sftp.ts', 'sftp.js')
  compileTo('errors.ts', 'errors.js')
  compileTo('errors.ts', 'shared-errors.js', '../src/shared')

  const electronStub = {
    app: { getPath: () => DATA_DIR },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (plain) => Buffer.from(plain, 'utf8'),
      decryptString: (buffer) => buffer.toString('utf8')
    },
    dialog: {
      showSaveDialog: async () => ({
        canceled: !dialogBehavior.savePath,
        filePath: dialogBehavior.savePath
      }),
      showOpenDialog: async () => ({ canceled: true, filePaths: [] })
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
      sftp: require(path.join(BUILD_DIR, 'sftp.js'))
    }
  } finally {
    Module._load = originalLoad
  }
}

/** 运行时资源，失败时兜底释放 */
const resources = { server: null, pool: null }

async function main() {
  const server = await startServer()
  resources.server = server
  console.log(`[信息] 内存 SFTP 服务端已启动 127.0.0.1:${SSH_PORT}`)

  const { ssh: sshModule, sftp: sftpModule } = loadModules()
  const pool = new sshModule.SshConnectionPool()
  resources.pool = pool
  /** 进度事件按到达顺序记录，用于核对 resumed / transferred / done 语义 */
  const progress = []
  const manager = new sftpModule.SftpManager(pool, (vo) => progress.push({ ...vo }))
  const config = {
    connectionId: 'verify-resume',
    title: '续传验证目标',
    host: '127.0.0.1',
    port: SSH_PORT,
    username: 'tester',
    password: 'any'
  }
  const opened = await manager.open(config)
  const sftpId = opened.sftpId
  assert(opened.home === HOME, `SFTP 会话打开，初始目录 ${opened.home}`)

  // -------------------------------------------------------------------------
  // 1. 上传中断：只写入已确认前缀
  // -------------------------------------------------------------------------
  const uploadSize = 1024 * 1024
  const uploadContent = crypto.randomBytes(uploadSize)
  const localUpload = path.join(WORK_DIR, 'upload.bin')
  fs.writeFileSync(localUpload, uploadContent)
  // 预置一个 0 字节同名文件：模拟「远端已有上次留下的半成品」。
  // 新契约下同名文件必须显式给出处理方式，这里按续传本意用 overwrite（本次从 0 重新写起）
  memfs.set(`${HOME}/upload.bin`, { type: 'file', content: Buffer.alloc(0) })

  fault.writeRejectFrom = UPLOAD_FAULT_AT
  let firstError = null
  try {
    await withTimeout(
      manager.uploadPaths({
        sftpId,
        remoteDir: HOME,
        localPaths: [localUpload],
        conflictAction: 'overwrite'
      }),
      '第一次上传（预期中断）'
    )
  } catch (err) {
    firstError = err
  }
  fault.writeRejectFrom = null
  assert(Boolean(firstError), '上传被中断时以异常返回，不会假装成功')
  assert(
    typeof firstError.message === 'string' && firstError.message.includes('上传文件'),
    `上传失败信息带场景说明（${firstError.message}）`
  )
  const partialSize = memfs.get(`${HOME}/upload.bin`).content.length
  assert(
    partialSize > 0 && partialSize < uploadSize,
    `中断后远端只留下已确认写入的前缀（${partialSize} / ${uploadSize} 字节）`
  )
  assert(
    observed.rejectedWrites > 0 && partialSize === UPLOAD_FAULT_AT,
    `远端内容停在故障点且没有空洞（${partialSize} 字节，被拒绝的写请求 ${observed.rejectedWrites} 次）`
  )
  assert(
    memfs.get(`${HOME}/upload.bin`).content.equals(uploadContent.subarray(0, partialSize)),
    '前缀内容与本地文件前 N 字节逐字节一致'
  )

  // -------------------------------------------------------------------------
  // 2. 上传重试：从断点继续，最终逐字节一致
  // -------------------------------------------------------------------------
  progress.length = 0
  resetObserved()
  const uploaded = await withTimeout(
    manager.uploadPaths({ sftpId, remoteDir: HOME, localPaths: [localUpload] }),
    '断点续传上传'
  )
  assert(
    uploaded.uploaded.length === 1 && uploaded.uploaded[0] === `${HOME}/upload.bin`,
    `续传上传返回远程绝对路径（实际 ${uploaded.uploaded[0]}）`
  )
  assert(
    uploaded.conflicts.length === 0 && uploaded.backups.length === 0,
    '断点记录与远端长度吻合时直接续传，未被当作同名冲突拦下（conflicts 为空）'
  )
  const remoteAfterResume = memfs.get(`${HOME}/upload.bin`).content
  assert(
    remoteAfterResume.length === uploadSize && remoteAfterResume.equals(uploadContent),
    `续传后远端文件与本地逐字节一致（${remoteAfterResume.length} 字节）`
  )
  assert(
    observed.writtenBytes === uploadSize - partialSize,
    `重试只发送剩余字节，没有重传已完成的 ${partialSize} 字节（本轮写入 ${observed.writtenBytes}）`
  )
  const firstProgress = progress[0]
  // 首条进度在「第一块写入成功」之后才上报，因此 transferred = 断点 + 首个分片，允许一个分片的误差
  assert(
    firstProgress.resumed === true &&
      firstProgress.transferred > partialSize &&
      firstProgress.transferred <= partialSize + 128 * 1024,
    `首条进度标记 resumed 且从断点起算（transferred=${firstProgress.transferred}，断点 ${partialSize}）`
  )
  assert(
    progress.filter((vo) => vo.resumed === true).length === 1,
    'resumed 只随首次上报发出，后续进度不再重复标记'
  )
  assert(
    progress[progress.length - 1].done === true &&
      progress[progress.length - 1].transferred === uploadSize,
    '最后一条进度为完成态且累计字节等于文件大小'
  )
  assert(
    progress.every((vo, index) => index === 0 || vo.transferred >= progress[index - 1].transferred),
    '进度单调不减，不会来回跳'
  )

  // -------------------------------------------------------------------------
  // 3. 上传成功后断点被清除：再次上传从头开始
  //    新契约：缺省 conflictAction 时同名文件绝不覆盖，只返回 conflicts 且远端内容不变；
  //    要覆盖必须显式传 overwrite
  // -------------------------------------------------------------------------
  progress.length = 0
  resetObserved()
  const conflictAfterDone = await withTimeout(
    manager.uploadPaths({ sftpId, remoteDir: HOME, localPaths: [localUpload] }),
    '传完后缺省处理方式再传一次'
  )
  assert(
    conflictAfterDone.uploaded.length === 0 &&
      conflictAfterDone.conflicts.length === 1 &&
      conflictAfterDone.conflicts[0].remotePath === `${HOME}/upload.bin`,
    '断点已清除时同名文件进入 conflicts 且不上传（缺省 conflictAction 不覆盖）'
  )
  assert(
    memfs.get(`${HOME}/upload.bin`).content.equals(uploadContent),
    '缺省路径下远端内容保持不变（没有被截断或改写）'
  )
  assert(
    observed.writtenBytes === 0 && progress.length === 0,
    `缺省路径没有写入任何字节也没有进度上报（写入 ${observed.writtenBytes} 字节，进度 ${progress.length} 条）`
  )

  progress.length = 0
  resetObserved()
  await withTimeout(
    manager.uploadPaths({
      sftpId,
      remoteDir: HOME,
      localPaths: [localUpload],
      conflictAction: 'overwrite'
    }),
    '重复上传同一文件（显式覆盖）'
  )
  assert(
    progress[0].resumed === undefined && progress[0].transferred < uploadSize,
    `成功上传后断点被清除，下一次从头开始（首条 transferred=${progress[0].transferred}）`
  )
  assert(observed.writtenBytes === uploadSize, `重传写入完整 ${uploadSize} 字节`)
  assert(
    memfs.get(`${HOME}/upload.bin`).content.equals(uploadContent),
    '重传后远端内容仍与本地一致（先截断再写，没有尾部残留）'
  )

  // -------------------------------------------------------------------------
  // 3.b 备份后上传在中途失败时的远端现场（故障注入取证）
  //     先把旧文件改名成备份、再写新文件；写入失败时**必须回滚**：
  //     清掉半成品并把备份改名回原路径，保证原路径仍是失败前的完整旧内容。
  // -------------------------------------------------------------------------
  progress.length = 0
  resetObserved()
  fault.writeRejectFrom = 0
  let backupFailure = null
  try {
    await withTimeout(
      manager.uploadPaths({
        sftpId,
        remoteDir: HOME,
        localPaths: [localUpload],
        conflictAction: 'backup'
      }),
      '备份后上传（预期中断）'
    )
  } catch (err) {
    backupFailure = err
  }
  fault.writeRejectFrom = null
  assert(Boolean(backupFailure), '备份后上传写入失败时以异常返回，不会假装成功')
  const backupKeys = [...memfs.keys()].filter((key) => key.startsWith(`${HOME}/upload.bin.`))
  assert(
    backupKeys.length === 0,
    `回滚后没有残留的「原名.日期」备份（实际 ${backupKeys.join('、') || '无'}）`
  )
  assert(
    memfs.get(`${HOME}/upload.bin`).content.equals(uploadContent),
    `回滚后原路径仍是失败前的完整旧内容（实际 ${memfs.get(`${HOME}/upload.bin`).content.length} 字节）`
  )

  // -------------------------------------------------------------------------
  // 4. 下载中断后重试：复用 .part，读取偏移从断点开始
  // -------------------------------------------------------------------------
  const downloadSize = 1024 * 1024
  const remoteContent = crypto.randomBytes(downloadSize)
  memfs.set(`${HOME}/download.bin`, { type: 'file', content: remoteContent })

  const localDownload = path.join(WORK_DIR, 'download.bin')
  const partPath = `${localDownload}.part`
  const resumedPart = 300 * 1024
  fs.writeFileSync(partPath, remoteContent.subarray(0, resumedPart))

  progress.length = 0
  resetObserved()
  dialogBehavior.savePath = localDownload
  const done = await withTimeout(manager.download(sftpId, `${HOME}/download.bin`), '续传下载')
  assert(done === true, '下载返回完成状态')
  const downloaded = fs.readFileSync(localDownload)
  assert(
    downloaded.length === downloadSize && downloaded.equals(remoteContent),
    `续传下载的本地文件与远端逐字节一致（${downloaded.length} 字节）`
  )
  assert(
    observed.minReadOffset === resumedPart,
    `服务端读取偏移从断点开始，未重新拉取前 ${resumedPart} 字节（最小偏移 ${observed.minReadOffset}）`
  )
  assert(
    observed.readBytes === downloadSize - resumedPart,
    `续传只读取剩余字节（本轮读取 ${observed.readBytes}）`
  )
  assert(
    progress[0].resumed === true &&
      progress[0].transferred > resumedPart &&
      progress[0].transferred <= resumedPart + 128 * 1024,
    `下载首条进度标记 resumed 且从断点起算（transferred=${progress[0].transferred}，断点 ${resumedPart}）`
  )
  assert(!fs.existsSync(partPath), '下载完成后 .part 被改名成正式文件，不留半成品')

  // -------------------------------------------------------------------------
  // 5. .part 已完整 / 比远端更大时按脏数据处理
  // -------------------------------------------------------------------------
  fs.rmSync(localDownload, { force: true })
  fs.writeFileSync(partPath, remoteContent)
  progress.length = 0
  resetObserved()
  await withTimeout(manager.download(sftpId, `${HOME}/download.bin`), '完整 .part 的下载')
  assert(
    progress[0].resumed === undefined && observed.minReadOffset === 0,
    '.part 与远端等长时判定为已下载完成，按从头下载处理'
  )
  assert(fs.readFileSync(localDownload).equals(remoteContent), '重下后文件内容仍正确')

  fs.rmSync(localDownload, { force: true })
  fs.writeFileSync(partPath, Buffer.concat([remoteContent, Buffer.from('脏数据')]))
  progress.length = 0
  resetObserved()
  await withTimeout(manager.download(sftpId, `${HOME}/download.bin`), '.part 过大的下载')
  assert(
    progress[0].resumed === undefined && observed.minReadOffset === 0,
    '.part 比远端大时判定为脏数据，按从头下载处理'
  )
  assert(
    fs.readFileSync(localDownload).equals(remoteContent),
    '脏 .part 不会污染最终文件（w 模式重建，无尾部残留）'
  )

  // -------------------------------------------------------------------------
  // 6. 多文件上传：逐个进行、进度按文件顺序上报
  // -------------------------------------------------------------------------
  const files = []
  for (const index of [1, 2]) {
    const content = crypto.randomBytes(128 * 1024)
    const file = path.join(WORK_DIR, `multi-${index}.bin`)
    fs.writeFileSync(file, content)
    files.push({ file, content })
  }
  progress.length = 0
  resetObserved()
  const multiNames = await withTimeout(
    manager.uploadPaths({ sftpId, remoteDir: HOME, localPaths: files.map((item) => item.file) }),
    '多文件上传'
  )
  assert(
    multiNames.uploaded.length === 2 &&
      multiNames.uploaded[0] === `${HOME}/multi-1.bin` &&
      multiNames.uploaded[1] === `${HOME}/multi-2.bin`,
    `多文件上传按入参顺序返回远程绝对路径（${multiNames.uploaded.join('、')}）`
  )
  assert(
    files.every((item, index) =>
      memfs.get(`${HOME}/multi-${index + 1}.bin`).content.equals(item.content)
    ),
    '两个文件的内容都逐字节一致'
  )
  const namesInOrder = progress.map((vo) => vo.name)
  const firstIndexOfSecond = namesInOrder.indexOf('multi-2.bin')
  assert(
    firstIndexOfSecond > 0 &&
      namesInOrder.slice(0, firstIndexOfSecond).every((name) => name === 'multi-1.bin') &&
      namesInOrder.slice(firstIndexOfSecond).every((name) => name === 'multi-2.bin'),
    `多文件逐个上传，进度按文件顺序到达（${namesInOrder[0]} → ${namesInOrder[firstIndexOfSecond]}）`
  )
  const lastOfFirst = progress.filter((vo) => vo.name === 'multi-1.bin').pop()
  assert(
    lastOfFirst.done === true && lastOfFirst.transferred === 128 * 1024,
    `第一个文件先上报完成态再开始第二个（transferred=${lastOfFirst.transferred}）`
  )

  manager.close(sftpId)
  server.close()
  pool.dispose()
  fs.rmSync(BUILD_DIR, { recursive: true, force: true })
  fs.rmSync(DATA_DIR, { recursive: true, force: true })
  fs.rmSync(WORK_DIR, { recursive: true, force: true })
  console.log(`\n[结果] 全部通过，共 ${passed} 项`)
}

main().catch((err) => {
  console.error(`\n[失败] ${err.message}`)
  if (err.stack) console.error(err.stack)
  if (resources.server) resources.server.close()
  if (resources.pool) resources.pool.dispose()
  setTimeout(() => process.exit(1), 300)
})
